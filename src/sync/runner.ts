import type { KeyRing } from "./crypto";
import type { SyncEngine } from "./engine";
import {
  fromWireVector,
  toWireVector,
  type HeldSlot,
  type SyncTransport,
  TransportError,
} from "./transport";
import type { DrainStatement } from "./drain";
import type { HeldItem, SyncClient, SyncStatus, Unsubscribe } from "./types";

export type RunnerConfig = {
  engine: SyncEngine;
  /** LAN hub transport (configured URL; discovery is the hub's and the shell's job). Optional. */
  hub?: SyncTransport;
  /** Cloud gateway transport. Optional (a LAN-only test, or before activation). */
  cloud?: SyncTransport;
  /** Credential key ring: credentials served with pulled ops are ingested before ops are verified. */
  keyRing?: KeyRing;
  /** Relay every origin's ops (the hub role). Devices push only their own, plus the re-offer after a restore. */
  relayAll?: boolean;
  now?: () => number;
  random?: () => number;
  /** Idle interval between rounds when running in the background. Default 15 s. */
  intervalMs?: number;
  /** Pull and push batch cap. Default 500 ops. */
  batch?: number;
  /** Called with errors a round hit; the UI never needs them, the log does. */
  onError?: (e: unknown) => void;
};

const HUB_FAILOVER_TRIES = 3;
const HUB_FAILOVER_MS = 10_000;
const HUB_PROBE_MS = 15_000;
const MAX_BATCHES = 200;

const toHeld = (h: HeldSlot[], origin: string): HeldItem[] => h.filter((s) => s.origin === origin).map((s) => ({ stream: s.stream, seq: s.seq, code: s.code }));

/**
 * Background sync runner (ADR-0002 S10, S12). A device has one upstream at a time: the hub when
 * reachable, otherwise the cloud. Each round is hello, push, pull; every step is safe to repeat and
 * resumes by version vector, so a cut connection costs nothing. The UI never awaits this.
 */
export class SyncRunner implements SyncClient {
  private readonly e: SyncEngine;
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inflight: Promise<void> | undefined;
  private hubFailures = 0;
  private hubFirstFailureAt = 0;
  private hubRetryAt = 0;
  private failures = 0;

  constructor(private readonly cfg: RunnerConfig) {
    this.e = cfg.engine;
    this.now = cfg.now ?? Date.now;
    this.random = cfg.random ?? Math.random;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (): void => {
      if (!this.running) return;
      void this.syncNow().finally(() => {
        if (!this.running) return;
        const base = this.cfg.intervalMs ?? 15_000;
        const backoff = Math.min(base * 2 ** Math.min(this.failures, 4), 120_000);
        this.timer = setTimeout(tick, backoff * (0.75 + this.random() * 0.5)); // jittered
      });
    };
    tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  status(): SyncStatus {
    return this.e.status();
  }

  onStatus(listener: (status: SyncStatus) => void): Unsubscribe {
    return this.e.onStatus(listener);
  }

  /** Runs one round now. Concurrent calls share the round in flight. Never throws. */
  /**
   * Drain a revoked device (ADR-0005 A3.3). With the drain token as the cloud credential: enter drain mode (nothing new is
   * recorded), upload every own op to quarantine until the answered vector covers every own head, then send the last
   * upload with no items and the signed statement. Safe to repeat after a cut: it starts over and the statement is
   * built once. `drained: false` means the cloud was not reached or did not cover every head, and nothing was signed
   * into a send.
   */
  async drain(): Promise<{ drained: boolean; statement?: DrainStatement }> {
    const up = this.cfg.cloud?.uploadQuarantine?.bind(this.cfg.cloud);
    if (!up) throw new Error("drain: needs a cloud transport with uploadQuarantine");
    const e = this.e;
    await e.beginDrain();
    const batch = this.cfg.batch ?? 500;
    try {
      for (const stream of e.streams) {
        const head = (await e.vector(stream))[e.deviceId] ?? 0;
        let have: Record<string, number> = {};
        for (let i = 0; i < MAX_BATCHES && (have[e.deviceId] ?? 0) < head; i++) {
          const { items, seals } = await e.outbox(stream, have, "own", batch);
          if (items.length === 0) break;
          const res = await up({ items, seals });
          const accepted = fromWireVector(res.vector)[stream] ?? {};
          const before = have[e.deviceId] ?? 0;
          have = { ...have, ...accepted };
          if ((have[e.deviceId] ?? 0) <= before) return { drained: false }; // refused or no progress
        }
        if ((have[e.deviceId] ?? 0) < head) return { drained: false };
      }
      const statement = await e.drainStatement();
      await up({ items: [], drain_statement: statement });
      return { drained: true, statement };
    } catch (err) {
      this.cfg.onError?.(err);
      return { drained: false };
    }
  }

  syncNow(): Promise<void> {
    this.inflight ??= this.round().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private pickUpstream(): Array<"hub" | "cloud"> {
    const order: Array<"hub" | "cloud"> = [];
    const { hub, cloud } = this.cfg;
    const hubDue = hub && this.now() >= this.hubRetryAt;
    // Fail over to the cloud after 3 tries or 10 s; probe the hub again every 15 s (S12).
    const hubDown = this.hubFailures >= HUB_FAILOVER_TRIES || (this.hubFailures > 0 && this.now() - this.hubFirstFailureAt >= HUB_FAILOVER_MS);
    if (hub && hubDue) order.push("hub");
    if (cloud && (!hub || hubDown || !hubDue)) order.push("cloud");
    return order;
  }

  private async round(): Promise<void> {
    await this.e.sealIfDue().catch(this.cfg.onError);
    const order = this.pickUpstream();
    for (const kind of order) {
      const transport = kind === "hub" ? this.cfg.hub : this.cfg.cloud;
      if (!transport) continue;
      try {
        await this.exchange(kind, transport);
        if (kind === "hub") this.hubFailures = 0;
        this.failures = 0;
        this.e.setConnectivity({ online: true, upstream: kind, lastSyncAt: new Date(this.now()).toISOString() });
        // After a cloud restore a hub may hold only placeholders: the origin must also reach the cloud
        // directly while the re-offer flag is set (S16 item 4). A cloud failure here is not a hub failure.
        // The same goes for the A2.8 checks: a node behind a hub reaches the cloud directly at least every 24 h,
        // and at once while an unbound slot, an unreported chain conflict or a refused cloud seal waits.
        if (kind === "hub" && this.cfg.cloud && (this.e.needsReoffer || (await this.e.directCloudDue()))) {
          await this.exchange("cloud", this.cfg.cloud).catch(this.cfg.onError);
        }
        return;
      } catch (err) {
        this.cfg.onError?.(err);
        if (kind === "hub") {
          if (this.hubFailures === 0) this.hubFirstFailureAt = this.now();
          this.hubFailures++;
          if (this.hubFailures >= HUB_FAILOVER_TRIES) this.hubRetryAt = this.now() + HUB_PROBE_MS;
        }
        // A non-retriable error is a bug or a refusal; it is still reported but must not spin.
        if (!(err instanceof TransportError) || err.retriable) continue;
      }
    }
    this.failures++;
    this.e.setConnectivity({ online: false, upstream: "none" });
  }

  /** hello, then push until nothing is left, then pull until `more` is false. */
  private async exchange(kind: "hub" | "cloud", t: SyncTransport): Promise<void> {
    const e = this.e;
    const batch = this.cfg.batch ?? 500;
    const vectors: Record<string, Record<string, number>> = {};
    const cloudVec: Record<string, Record<string, number>> = {};
    for (const s of e.streams) {
      vectors[s] = await e.vector(s);
      cloudVec[s] = e.upstreamVector("cloud", s);
    }

    // Only the cloud can check a slot taken by hash, and only it takes a conflict report (A2.8 items 1.3, 1.4).
    const extras = kind === "cloud" ? await e.helloExtras() : {};
    const hello = await t.hello({
      protocol: 1,
      vector: toWireVector(vectors),
      ...(e.lastEpoch ? { epoch: e.lastEpoch } : {}),
      cloud_vector: toWireVector(cloudVec),
      ...extras,
    });
    await e.noteUpstreamTime(kind, hello.time);
    const upstream = fromWireVector(hello.vector);
    if (kind === "cloud") {
      await e.noteCloudHello(hello.epoch ?? "genesis", upstream);
      await e.markConflictsReported(extras.chain_conflicts ?? []);
      await e.clearErasureAcks(extras.pii_erased ?? []);
      await e.resolveUnbound(hello.unbound_h ?? []);
      for (const s of e.streams) await e.noteUpstream("cloud", s, upstream[s] ?? {});
    } else {
      // The hub tells us what it holds (at_hub) and what the cloud last confirmed to it (in_cloud).
      for (const s of e.streams) await e.noteUpstream("hub", s, upstream[s] ?? {}, true);
      const viaHub = fromWireVector(hello.cloud_vector);
      for (const s of e.streams) if (viaHub[s]) await e.noteUpstream("cloud", s, viaHub[s]!);
      await e.noteHubEpoch(hello.epoch);
    }

    const scope = this.cfg.relayAll || (kind === "cloud" && e.needsReoffer) ? "all" : "own";
    let drained = true;
    for (const stream of e.streams) {
      let have = { ...(upstream[stream] ?? {}) };
      let done = false;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const { items, seals } = await e.outbox(stream, have, scope, batch);
        if (items.length === 0) {
          done = true;
          break;
        }
        const res = await t.push({ items, seals });
        const accepted = fromWireVector(res.vector)[stream] ?? {};
        await e.noteUpstream(kind, stream, accepted, kind === "hub");
        if (res.held?.length) await e.setHeld(mergeHeld(e.heldOps(), toHeld(res.held, e.deviceId)));
        const before = JSON.stringify(have);
        have = { ...have, ...accepted };
        if (JSON.stringify(have) === before) break; // refused or no progress: do not spin; next round retries
      }
      if (!done) drained = false;
    }
    // Only a direct cloud hello that leaves nothing to push closes a re-offer (A2.2 item 3).
    if (kind === "cloud" && drained && e.needsReoffer) await e.reofferDone();

    // Pull until caught up.
    for (let i = 0; i < MAX_BATCHES; i++) {
      const cur: Record<string, Record<string, number>> = {};
      for (const s of e.streams) cur[s] = await e.vector(s);
      const stale = await e.staleSeals();
      const res = await t.pull({
        vector: toWireVector(cur),
        streams: e.streams,
        placeholders: await e.placeholders(),
        ...(stale.length ? { stale_seals: stale } : {}),
        limit: batch,
      });
      if (res.creds?.length && this.cfg.keyRing) await this.cfg.keyRing.ingest(res.creds);
      if (res.seal_refresh?.length) await e.refreshSeals(res.seal_refresh);
      let progress = res.items.length === 0;
      for (const s of e.streams) {
        const items = res.items.filter((it) => it.stream === s);
        if (items.length === 0) continue;
        const r = await e.applyRemote(s, items, res.seals ?? [], { endorsements: res.endorsements ?? [], attestations: res.attestations ?? [], fromCloud: kind === "cloud" });
        if (r.applied > 0 || r.skipped > 0) progress = true;
        if (r.rejected.length) this.cfg.onError?.(new Error(`pull rejected: ${JSON.stringify(r.rejected)}`));
      }
      await e.setHeld(toHeld(res.own_held ?? [], e.deviceId));
      if (!res.more || !progress) break;
    }

    // `pii_incomplete` (ADR-0014 A3.1 item 4): ask this upstream again from just below the oldest op missing a value.
    // The re-served slots are held already, so they only fill the missing fields; a kds has nothing to ask for.
    const missing = await e.piiIncomplete();
    if (missing.length > 0) {
      const from: Record<string, Record<string, number>> = {};
      for (const s of e.streams) from[s] = await e.vector(s);
      for (const m of missing) {
        const v = from[m.stream];
        if (v && m.origin in v) v[m.origin] = Math.min(v[m.origin]!, m.seq - 1);
      }
      const res = await t.pull({ vector: toWireVector(from), streams: e.streams, limit: batch });
      for (const s of e.streams) {
        const items = res.items.filter((it) => it.stream === s && it.pii !== undefined);
        if (items.length > 0) await e.applyRemote(s, items, res.seals ?? [], { fromCloud: kind === "cloud" });
      }
    }
  }
}

function mergeHeld(cur: HeldItem[], add: HeldItem[]): HeldItem[] {
  const m = new Map(cur.map((h) => [`${h.stream}|${h.seq}`, h]));
  for (const h of add) m.set(`${h.stream}|${h.seq}`, h);
  return [...m.values()];
}
