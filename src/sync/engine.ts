import { uuidv7 } from "../ids";
import type { LocalStore, Row, StoreTx } from "../store";
import {
  applyMutations,
  applyVoidTo,
  opId,
  opRowId,
  T,
  touchesLww,
  visible,
  type ApplyCtx,
  type ConflictRow,
} from "./apply";
import { canonicalize } from "./canonical";
import {
  attestationMessage,
  genesisHash,
  makeSeal,
  sha256Hex,
  verifySeal,
  type SealVerifier,
  type Signer,
} from "./crypto";
import { HlcClock, MAX_FUTURE_MS, unpackHlc } from "./hlc";
import type { SchemaRegistry, DocType } from "./schema";
import { allocateNumber, putGrants, type SeriesGrant } from "./series";
import type {
  Attestation,
  Endorsement,
  ClockMode,
  DeliveryState,
  HeldItem,
  Mutation,
  OpEnvelope,
  OpRef,
  Seal,
  SyncStatus,
  Unsubscribe,
  VersionVector,
  WireItem,
} from "./types";

export class KeyLostError extends Error {
  constructor() {
    super("device key unavailable: this device must be recovered or re-activated before it records anything");
  }
}

export type EngineConfig = {
  store: LocalStore;
  schemas: SchemaRegistry;
  /** Node id: the device id from identity. */
  deviceId: string;
  /** `outlet:<outlet_id>`: where this device's own ops go. */
  outletStream: string;
  /** Streams this device syncs (outlet, brand, tenant). Defaults to the outlet stream only. */
  streams?: string[];
  signer: Signer;
  verifier: SealVerifier;
  packVersion: string;
  /** Wall clock in ms; injectable. */
  now?: () => number;
  clockMode?: ClockMode;
  /** A device holding unpushed ops seals its head at least this often (ADR-0002 A1.3 item 8). Default 5 min. */
  sealIntervalMs?: number;
  newId?: () => string;
};

export type OpSession = { actor: string; sid: string };

export type BuildCtx = {
  /** Corrected wall clock, ms. */
  now: number;
  /** Next legal document number of the first active series of `docType`; allocated in the op's transaction. */
  number(docType: DocType): string;
  get(entity: string, id: string): Row | undefined;
  list(entity: string): Row[];
  newId(): string;
};

export type RecordSpec = {
  intent: string;
  intentV?: number;
  stream?: string;
  actor?: string;
  sid?: string;
  approval?: string;
  /** Opaque PIN-derived proof (ADR-0005); stamped by the auth layer. */
  proof?: string;
  /** Personal data: travels beside the op, outside its hash. */
  pii?: Record<string, unknown>;
  /** Runs inside the single-writer transaction; whatever it allocates commits with the op or not at all. */
  build: (ctx: BuildCtx) => Mutation[];
};

export type Rejection = { origin: string; seq: number; reason: string };
export type RemoteResult = { applied: number; skipped: number; rejected: Rejection[]; gaps: string[] };

type OpRow = Row & {
  /** Canonical JSON text of the op body exactly as hashed; absent for a placeholder. */
  body?: string;
  pii?: unknown;
  h: string;
  placeholder?: boolean;
  state: "applied" | "clock_quarantined" | "void_skipped" | "opaque" | "placeholder";
  own?: boolean;
  /** Accepted under a gateway endorsement, not a seal: "a holder of device.recover released this op" (A2.1 item 4). */
  unsealed?: boolean;
};

const rowOp = (r: OpRow): OpEnvelope | undefined => (r.body === undefined ? undefined : (JSON.parse(r.body) as OpEnvelope));

/** Parses a received body and checks it names the slot the item claims. Undefined if malformed. */
function parseBody(it: WireItem): OpEnvelope | undefined {
  try {
    const op = JSON.parse(it.body ?? "") as OpEnvelope;
    if (op.origin !== it.origin || op.stream !== it.stream || op.seq !== it.seq || !Array.isArray(op.muts)) return undefined;
    return op;
  } catch {
    return undefined;
  }
}

type Head = Row & { seq: number; h: string; sealedSeq: number; sealedAt: number };

/** Per-stream view of how far each upstream has confirmed. */
type Deliv = { hub: VersionVector; cloud: VersionVector };

const SKEW_WARN_MS = 2 * 60 * 1000;

/**
 * The client sync engine (ADR-0002 S4 to S7, S16, S17). Local-first: `record` writes the op log and the
 * rows in one local transaction and returns; nothing here waits on the network. The runner
 * (`runner.ts`) moves ops; this class owns state.
 */
export class SyncEngine {
  readonly clock: HlcClock;
  readonly deviceId: string;
  readonly outletStream: string;
  readonly streams: string[];
  session: OpSession | undefined;

  private readonly store: LocalStore;
  private readonly schemas: SchemaRegistry;
  private readonly signer: Signer;
  private readonly verifier: SealVerifier;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly packVersion: string;
  private readonly clockMode: ClockMode;
  private readonly sealIntervalMs: number;

  private heads = new Map<string, Head>();
  private deliv = new Map<string, Deliv>();
  private held: HeldItem[] = [];
  private refused = new Set<string>();
  private conflictCount = 0;
  private clockqCount = 0;
  private epoch: string | undefined;
  private reoffer = false;
  /** The newest epoch this device has finished re-offering under (A2.2); open while it differs from `epoch`. */
  private reofferedEpoch: string | undefined;
  private skewMs = 0;
  private skewSource: "none" | "hub" | "cloud" = "none";
  private conn: { online: boolean; upstream: "hub" | "cloud" | "none"; lastSyncAt?: string } = {
    online: false,
    upstream: "none",
  };
  private listeners = new Set<(s: SyncStatus) => void>();

  private constructor(cfg: EngineConfig) {
    this.store = cfg.store;
    this.schemas = cfg.schemas;
    this.deviceId = cfg.deviceId;
    this.outletStream = cfg.outletStream;
    this.streams = cfg.streams ?? [cfg.outletStream];
    this.signer = cfg.signer;
    this.verifier = cfg.verifier;
    this.now = cfg.now ?? Date.now;
    this.newId = cfg.newId ?? (() => uuidv7(this.now));
    this.packVersion = cfg.packVersion;
    this.clockMode = cfg.clockMode ?? "sync";
    this.sealIntervalMs = cfg.sealIntervalMs ?? 5 * 60 * 1000;
    this.clock = new HlcClock(this.now);
  }

  /** Opens the engine over a store, restoring clock, vectors, delivery state and the held list. */
  static async open(cfg: EngineConfig): Promise<SyncEngine> {
    const e = new SyncEngine(cfg);
    const store = cfg.store;
    const hlc = await store.get(T.meta, "hlc");
    if (hlc) e.clock.restore(hlc.v as string);
    const clk = await store.get(T.meta, "clock");
    if (clk) {
      e.skewMs = clk.offset as number;
      e.skewSource = clk.src as "hub" | "cloud";
      e.clock.setOffset(e.skewMs);
    }
    e.epoch = (await store.get(T.meta, "epoch"))?.v as string | undefined;
    e.reoffer = ((await store.get(T.meta, "reoffer"))?.v as boolean | undefined) ?? false;
    e.reofferedEpoch = (await store.get(T.meta, "reoffered_epoch"))?.v as string | undefined;
    e.refused = new Set(((await store.get(T.meta, "refused"))?.list as string[] | undefined) ?? []);
    e.held = ((await store.get(T.held, "own"))?.items as HeldItem[] | undefined) ?? [];
    for (const s of e.streams) {
      const h = (await store.get(T.head, `${s}|${cfg.deviceId}`)) as Head | undefined;
      if (h) e.heads.set(s, h);
      const d = await store.get(T.deliv, s);
      if (d) e.deliv.set(s, { hub: d.hub as VersionVector, cloud: d.cloud as VersionVector });
    }
    e.conflictCount = (await e.conflicts()).length;
    e.clockqCount = (await store.list(T.clockq)).length;
    return e;
  }

  // ---- identity of the node ------------------------------------------------------------------

  get tenantId(): string {
    return this.store.tenantId;
  }

  /** The chain head is per origin and stream: a device that adopts a kept database starts its own chain. */
  private headId(stream: string): string {
    return `${stream}|${this.deviceId}`;
  }

  get keyLost(): boolean {
    return !this.signer.available();
  }

  /** Corrected wall clock, ms. */
  correctedNow(): number {
    return this.now() + this.clock.offset;
  }

  // ---- local-first writes --------------------------------------------------------------------

  /**
   * Records an operation: allocates `seq`, `ph`, any legal number, the HLC stamp, the op and its row
   * changes in one single-writer transaction (ADR-0002 S4). Returns when the local commit is done.
   */
  async record(spec: RecordSpec): Promise<OpEnvelope> {
    if (this.keyLost) throw new KeyLostError();
    const stream = spec.stream ?? this.outletStream;
    const actor = spec.actor ?? this.session?.actor;
    const sid = spec.sid ?? this.session?.sid;
    if (!actor || !sid) throw new Error("record: no session (actor and sid are stamped on every op)");

    const op = await this.store.transact(async (tx) => {
      const head: Head =
        (tx.get(T.head, this.headId(stream)) as Head | undefined) ??
        ({ id: this.headId(stream), tenant_id: this.tenantId, seq: 0, h: await genesisHash(this.deviceId, stream), sealedSeq: 0, sealedAt: this.now() } as Head);
      const nowMs = this.correctedNow();
      // An op may take several legal numbers in this one transaction (bill.rebill: a credit note and the new bills);
      // they commit with the op or not at all, so no number is burnt or duplicated.
      const allocated: NonNullable<OpEnvelope["doc"]>[] = [];
      const muts = spec.build({
        now: nowMs,
        number: (docType) => {
          const d = { type: docType, number: allocateNumber(tx, this.tenantId, docType, nowMs) };
          allocated.push(d);
          return d.number;
        },
        get: (e, id) => tx.get(e, id),
        list: (e) => tx.list(e),
        newId: this.newId,
      });
      for (const m of muts) {
        if (!this.schemas.get(m.e)) throw new Error(`record: unknown entity ${m.e}`);
      }
      const envelope: OpEnvelope = {
        v: 1,
        origin: this.deviceId,
        stream,
        seq: head.seq + 1,
        ph: head.h,
        hlc: this.clock.next(),
        clk: this.clockMode,
        tenant_id: this.tenantId,
        actor,
        sid,
        pack_v: this.packVersion,
        ...(spec.approval ? { approval: spec.approval } : {}),
        ...(spec.proof ? { proof: spec.proof } : {}),
        intent: spec.intent,
        intent_v: spec.intentV ?? 1,
        at: new Date(nowMs).toISOString(),
        // `doc` is the first number (what a reader that knows one number sees); `docs` lists all of them when there are several.
        ...(allocated.length ? { doc: allocated[0]! } : {}),
        ...(allocated.length > 1 ? { docs: allocated } : {}),
        // Empty `f` and `prev` are omitted, as the Go side omits them, so both encoders give the same bytes.
        muts: muts.map((m) => ({
          e: m.e,
          id: m.id,
          k: m.k,
          ...(m.f && Object.keys(m.f).length ? { f: m.f } : {}),
          ...(m.prev && Object.keys(m.prev).length ? { prev: m.prev } : {}),
        })),
      };
      const body = canonicalize(envelope);
      const h = await sha256Hex(body);
      const applied = JSON.parse(body) as OpEnvelope; // apply exactly what receivers will parse
      applyMutations(tx, this.applyCtx(tx), applied);
      tx.put(T.op, {
        id: opRowId(applied),
        tenant_id: this.tenantId,
        body,
        ...(spec.pii ? { pii: spec.pii } : {}),
        h,
        state: "applied",
        own: true,
      } satisfies OpRow);
      tx.put(T.head, { ...head, seq: applied.seq, h, sealedAt: head.seq === head.sealedSeq ? this.now() : head.sealedAt });
      this.bumpVv(tx, stream, this.deviceId, applied.seq);
      tx.put(T.meta, { id: "hlc", tenant_id: this.tenantId, v: this.clock.last() });
      return applied;
    });
    const head = (await this.store.get(T.head, this.headId(stream))) as Head;
    this.heads.set(stream, head);
    this.emit();
    return op;
  }

  /** Convenience for a single-mutation op. */
  recordMuts(intent: string, muts: Mutation[], extra: Partial<RecordSpec> = {}): Promise<OpEnvelope> {
    return this.record({ intent, build: () => muts, ...extra });
  }

  // ---- seals ---------------------------------------------------------------------------------

  private async storeSeals(tx: StoreTx, seals: Seal[]): Promise<void> {
    const byKey = new Map<string, Seal[]>();
    for (const s of seals) {
      const k = `${s.stream}|${s.origin}`;
      byKey.set(k, [...(byKey.get(k) ?? []), s]);
    }
    for (const [k, add] of byKey) {
      const cur = ((tx.get(T.seal, k)?.seals as Seal[] | undefined) ?? []).slice();
      for (const s of add) if (!cur.some((c) => c.seq === s.seq)) cur.push(s);
      cur.sort((a, b) => a.seq - b.seq);
      tx.put(T.seal, { id: k, tenant_id: this.tenantId, seals: cur });
    }
  }

  async sealsOf(stream: string, origin: string): Promise<Seal[]> {
    return ((await this.store.get(T.seal, `${stream}|${origin}`))?.seals as Seal[] | undefined) ?? [];
  }

  /** Seals own ops up to and including `seq` (default: the head). One keystore signature. */
  async sealOwn(stream: string, seq?: number): Promise<Seal | undefined> {
    const head = (await this.store.get(T.head, this.headId(stream))) as Head | undefined;
    if (!head || head.seq === 0) return undefined;
    const at = seq ?? head.seq;
    const existing = (await this.sealsOf(stream, this.deviceId)).find((s) => s.seq === at);
    if (existing) return existing;
    const row = (await this.store.get(T.op, opRowId({ origin: this.deviceId, stream, seq: at }))) as OpRow | undefined;
    if (!row) throw new Error(`sealOwn: no op at ${at}`);
    const seal = await makeSeal(this.signer, this.deviceId, stream, at, row.h);
    await this.store.transact(async (tx) => {
      await this.storeSeals(tx, [seal]);
      const cur = tx.get(T.head, this.headId(stream)) as Head;
      if (at > cur.sealedSeq) tx.put(T.head, { ...cur, sealedSeq: at, sealedAt: this.now() });
    });
    this.heads.set(stream, (await this.store.get(T.head, this.headId(stream))) as Head);
    return seal;
  }

  /** Seals the head when unsealed own ops are older than the seal interval (the key-loss tail stays short). */
  async sealIfDue(): Promise<void> {
    if (this.keyLost) return;
    for (const [stream, h] of this.heads) {
      if (h.seq > h.sealedSeq && this.now() - h.sealedAt >= this.sealIntervalMs) await this.sealOwn(stream);
    }
  }

  /** Own ops recorded after the last stored seal: what a lost key would leave unsigned. */
  unsealedTail(stream = this.outletStream): number {
    const h = this.heads.get(stream);
    return h ? h.seq - h.sealedSeq : 0;
  }

  // ---- vectors and delivery ------------------------------------------------------------------

  private bumpVv(tx: StoreTx, stream: string, origin: string, seq: number): void {
    const vv = ((tx.get(T.vv, stream)?.vv as VersionVector | undefined) ?? {});
    vv[origin] = seq;
    tx.put(T.vv, { id: stream, tenant_id: this.tenantId, vv });
  }

  /** Highest contiguous seq held per origin (the resume token, ADR-0002 S5). */
  async vector(stream = this.outletStream): Promise<VersionVector> {
    return { ...((await this.store.get(T.vv, stream))?.vv as VersionVector | undefined) };
  }

  upstreamVector(kind: "hub" | "cloud", stream = this.outletStream): VersionVector {
    return { ...(this.deliv.get(stream)?.[kind] ?? {}) };
  }

  /**
   * Records what an upstream confirmed. Vectors only move forward, except when `replace` is set after a
   * cloud restore: the cloud's vector then legitimately went backwards (S16).
   */
  async noteUpstream(kind: "hub" | "cloud", stream: string, vv: VersionVector, replace = false): Promise<void> {
    const cur = this.deliv.get(stream) ?? { hub: {}, cloud: {} };
    const next: VersionVector = replace ? { ...vv } : { ...cur[kind] };
    if (!replace) for (const [o, n] of Object.entries(vv)) next[o] = Math.max(next[o] ?? 0, n);
    const d: Deliv = { ...cur, [kind]: next };
    await this.store.transact((tx) => {
      tx.put(T.deliv, { id: stream, tenant_id: this.tenantId, hub: d.hub, cloud: d.cloud });
    });
    this.deliv.set(stream, d);
    this.emit();
  }

  /** Where one of this device's own ops is: local, at the hub, or confirmed by the cloud (S12 item 6). */
  delivery(seq: number, stream = this.outletStream): DeliveryState {
    const d = this.deliv.get(stream);
    if ((d?.cloud[this.deviceId] ?? 0) >= seq) return "in_cloud";
    if ((d?.hub[this.deviceId] ?? 0) >= seq) return "at_hub";
    return "local";
  }

  // ---- epoch and re-offer (S16) --------------------------------------------------------------

  get lastEpoch(): string | undefined {
    return this.epoch;
  }

  /** True while a re-offer is open: the epoch heard from any upstream differs from the one last re-offered under (A2.2). */
  get needsReoffer(): boolean {
    return this.reoffer || (this.epoch !== undefined && this.reofferedEpoch !== undefined && this.reofferedEpoch !== this.epoch);
  }

  /**
   * Called with the cloud's hello. A changed epoch, or a cloud vector below what the cloud confirmed to
   * us before, means the cloud was restored: forget its old confirmations and re-offer retained ops.
   */
  async noteCloudHello(epoch: string, vectors: Record<string, VersionVector>): Promise<{ restored: boolean }> {
    let restored = (this.reofferedEpoch !== undefined && this.reofferedEpoch !== epoch) || (this.epoch !== undefined && this.epoch !== epoch);
    for (const s of this.streams) {
      const known = this.deliv.get(s)?.cloud ?? {};
      for (const [o, n] of Object.entries(known)) if ((vectors[s]?.[o] ?? 0) < n) restored = true;
    }
    if (restored) {
      for (const s of this.streams) await this.noteUpstream("cloud", s, vectors[s] ?? {}, true);
    }
    const first = this.reofferedEpoch === undefined && !restored;
    await this.store.transact((tx) => {
      tx.put(T.meta, { id: "epoch", tenant_id: this.tenantId, v: epoch });
      if (restored) tx.put(T.meta, { id: "reoffer", tenant_id: this.tenantId, v: true });
      if (first) tx.put(T.meta, { id: "reoffered_epoch", tenant_id: this.tenantId, v: epoch });
    });
    this.epoch = epoch;
    if (restored) this.reoffer = true;
    if (first) this.reofferedEpoch = epoch;
    return { restored };
  }

  /**
   * Called with a hub's hello: its `epoch` is the cloud epoch. A hub's word may OPEN a re-offer (the worst a
   * lying hub causes is one extra push); only a direct cloud hello with nothing left to push closes it
   * (A2.2). The first epoch ever heard is taken as already re-offered under.
   */
  async noteHubEpoch(epoch: string | undefined): Promise<void> {
    if (!epoch || this.epoch === epoch) return;
    const first = this.epoch === undefined && this.reofferedEpoch === undefined;
    this.epoch = epoch;
    if (first) this.reofferedEpoch = epoch;
    await this.store.transact((tx) => {
      tx.put(T.meta, { id: "epoch", tenant_id: this.tenantId, v: epoch });
      if (first) tx.put(T.meta, { id: "reoffered_epoch", tenant_id: this.tenantId, v: epoch });
    });
  }

  /** Closes the re-offer: persists the epoch it was done under. Call only after a direct cloud hello left nothing to push. */
  async reofferDone(): Promise<void> {
    this.reoffer = false;
    this.reofferedEpoch = this.epoch;
    await this.store.transact((tx) => {
      tx.put(T.meta, { id: "reoffer", tenant_id: this.tenantId, v: false });
      if (this.epoch !== undefined) tx.put(T.meta, { id: "reoffered_epoch", tenant_id: this.tenantId, v: this.epoch });
    });
  }

  // ---- clock ---------------------------------------------------------------------------------

  /** Upstream time from a handshake: cloud time is trusted over hub time, hub over the local clock (S5). */
  async noteUpstreamTime(kind: "hub" | "cloud", upstreamIso: string): Promise<void> {
    if (kind === "hub" && this.skewSource === "cloud") return;
    const offset = Date.parse(upstreamIso) - this.now();
    if (Number.isNaN(offset)) return;
    this.skewMs = offset;
    this.skewSource = kind;
    this.clock.setOffset(offset);
    await this.store.transact((tx) => {
      tx.put(T.meta, { id: "clock", tenant_id: this.tenantId, offset, src: kind });
    });
    this.emit();
  }

  // ---- own-op read-back (A1.2) ---------------------------------------------------------------

  /** Replaces the held list with the cloud's current opinion: `own_held` from pull, or the push response. */
  async setHeld(items: HeldItem[]): Promise<void> {
    this.held = items.filter((i) => ["pending", "held_manager", "held_support"].includes(i.code));
    await this.store.transact((tx) => {
      tx.put(T.held, { id: "own", tenant_id: this.tenantId, items: this.held });
    });
    this.emit();
  }

  heldOps(): HeldItem[] {
    return [...this.held];
  }

  /** Own slots refused by the cloud (a `sync.void` named them). Shown as failed changes. */
  refusedOps(): OpRef[] {
    return [...this.refused].map((i) => {
      const [stream, origin, seq] = i.split("|") as [string, string, string];
      return { stream, origin, seq: Number(seq) };
    });
  }

  // ---- connectivity and status ---------------------------------------------------------------

  setConnectivity(c: { online: boolean; upstream: "hub" | "cloud" | "none"; lastSyncAt?: string }): void {
    this.conn = { ...this.conn, ...c };
    this.emit();
  }

  status(): SyncStatus {
    const head = this.heads.get(this.outletStream);
    const own = head?.seq ?? 0;
    const d = this.deliv.get(this.outletStream);
    const cloud = d?.cloud[this.deviceId] ?? 0;
    const hub = Math.max(d?.hub[this.deviceId] ?? 0, cloud);
    const pendingOps = Math.max(0, own - hub);
    const atHubOps = Math.max(0, hub - cloud);
    const checkingOps = this.held.filter((h) => h.code === "pending").length;
    const attentionOps = this.held.filter((h) => h.code !== "pending").length + this.refused.size + this.conflictCount + this.clockqCount;
    const state = attentionOps > 0 ? "conflict" : !this.conn.online ? "offline" : pendingOps + atHubOps + checkingOps > 0 ? "pending" : "synced";
    return {
      online: this.conn.online,
      pendingOps,
      atHubOps,
      attentionOps,
      checkingOps,
      upstream: this.conn.upstream,
      state,
      clockWrong: this.skewSource !== "none" && Math.abs(this.skewMs) > SKEW_WARN_MS,
      keyLost: this.keyLost,
      ...(this.conn.lastSyncAt ? { lastSyncAt: this.conn.lastSyncAt } : {}),
    };
  }

  onStatus(listener: (status: SyncStatus) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  // ---- outbox --------------------------------------------------------------------------------

  /**
   * Ops an upstream is missing, in origin-sequence order, with the seals that cover them. `own` sends
   * this device's ops; `all` also relays other origins (hub role, or the re-offer after a restore).
   * The own origin is sealed at the end of the batch: one signature per batch (S17).
   */
  async outbox(
    stream: string,
    upstream: VersionVector,
    scope: "own" | "all",
    maxOps = 500,
  ): Promise<{ items: WireItem[]; seals: Seal[] }> {
    const vv = await this.vector(stream);
    const origins = scope === "own" ? [this.deviceId] : Object.keys(vv).sort((a, b) => (a === this.deviceId ? -1 : b === this.deviceId ? 1 : a < b ? -1 : 1));
    const items: WireItem[] = [];
    const seals: Seal[] = [];
    for (const origin of origins) {
      const from = (upstream[origin] ?? 0) + 1;
      let to = vv[origin] ?? 0;
      if (to < from || items.length >= maxOps) continue;
      to = Math.min(to, from + (maxOps - items.length) - 1);
      let originSeals: Seal[] = [];
      if (origin !== this.deviceId) {
        // Only whole sealed runs travel: extend or trim to a stored seal so the receiver can verify.
        const all = (await this.sealsOf(stream, origin)).filter((s) => s.seq >= from);
        const fit = [...all].reverse().find((s) => s.seq <= to) ?? all[0];
        if (!fit) continue;
        to = fit.seq;
        originSeals = [fit];
      }
      const collected: WireItem[] = [];
      for (let seq = from; seq <= to; seq++) {
        const row = (await this.store.get(T.op, opRowId({ origin, stream, seq }))) as OpRow | undefined;
        if (row?.body === undefined) break; // placeholder or gap: cannot relay what we do not hold
        collected.push({ origin, stream, seq, h: row.h, body: row.body, ...(row.pii !== undefined ? { pii: row.pii } : {}) });
      }
      if (collected.length === 0) continue;
      if (origin === this.deviceId) {
        const seal = await this.sealOwn(stream, collected[collected.length - 1]!.seq);
        if (seal) originSeals = [seal];
      } else if (collected.length < to - from + 1) {
        continue;
      }
      items.push(...collected);
      seals.push(...originSeals);
    }
    return { items, seals };
  }

  // ---- applying remote ops -------------------------------------------------------------------

  private applyCtx(tx: StoreTx): ApplyCtx {
    const cloud = (stream: string): VersionVector => this.deliv.get(stream)?.cloud ?? {};
    const heldSet = new Set(this.held.map((h) => `${h.stream}|${this.deviceId}|${h.seq}`));
    void tx;
    return {
      tenantId: this.tenantId,
      schemas: this.schemas,
      confirmed: (r) => (cloud(r.stream)[r.origin] ?? 0) >= r.seq && !heldSet.has(opId(r)),
    };
  }

  /**
   * Verifies and applies items pulled from (or relayed by) an upstream. Each body is hashed exactly as
   * received; per origin the chain must link by `ph`, and every applied op must be covered by a valid
   * seal. Ops that are not are refused and the vector does not advance past them. Idempotent: an op at or
   * below the vector is skipped. A placeholder only advances the vector (A1.2).
   */
  async applyRemote(stream: string, items: WireItem[], seals: Seal[], proofs: { endorsements?: Endorsement[]; attestations?: Attestation[] } = {}): Promise<RemoteResult> {
    const result: RemoteResult = { applied: 0, skipped: 0, rejected: [], gaps: [] };
    if (!this.streams.includes(stream)) {
      result.rejected.push({ origin: "", seq: 0, reason: "stream not bound to this device" });
      return result;
    }
    await this.store.transact(async (tx) => {
      const ctx = this.applyCtx(tx);
      const vv = (tx.get(T.vv, stream)?.vv as VersionVector | undefined) ?? {};
      const byOrigin = new Map<string, WireItem[]>();
      for (const it of items) {
        if (it.stream !== stream) continue;
        byOrigin.set(it.origin, [...(byOrigin.get(it.origin) ?? []), it]);
      }
      const freshSeals: Seal[] = [];
      for (const [origin, list] of byOrigin) {
        if (origin === this.deviceId) {
          result.skipped += list.length; // our own ops are never taken back from an upstream
          continue;
        }
        list.sort((a, b) => a.seq - b.seq);
        let cur = vv[origin] ?? 0;
        // A placeholder slot we hold may come back as the released op: checked against the held hash.
        const fresh: WireItem[] = [];
        for (const it of list) {
          if (it.seq > cur) {
            fresh.push(it);
            continue;
          }
          const row = tx.get(T.op, opRowId(it)) as OpRow | undefined;
          if (row?.placeholder && it.body !== undefined) {
            const op = parseBody(it);
            if (op && (await sha256Hex(it.body)) === row.h && it.h === row.h && op.tenant_id === this.tenantId) {
              await this.applyOne(tx, ctx, op, it, false);
              tx.del(T.ph, opId(it));
              result.applied++;
            } else {
              result.rejected.push({ origin, seq: it.seq, reason: "released op does not match placeholder hash" });
            }
          } else {
            result.skipped++;
          }
        }
        // Chain check, on the bytes as sent.
        let prev = cur === 0 ? await genesisHash(origin, stream) : (tx.get(T.op, opRowId({ origin, stream, seq: cur })) as OpRow).h;
        const chain: Array<{ it: WireItem; op?: OpEnvelope }> = [];
        for (const it of fresh) {
          if (it.seq !== cur + chain.length + 1) {
            result.gaps.push(`${origin}:${cur + chain.length + 1}`);
            break;
          }
          if (it.body === undefined) {
            chain.push({ it }); // placeholder: its `h` carries the chain across the slot
            prev = it.h;
            continue;
          }
          const op = parseBody(it);
          if (!op || (await sha256Hex(it.body)) !== it.h) {
            result.rejected.push({ origin, seq: it.seq, reason: "body does not match its hash or its identity" });
            break;
          }
          if (op.ph !== prev) {
            result.rejected.push({ origin, seq: it.seq, reason: "chain broken: ph does not match previous op" });
            break;
          }
          chain.push({ it, op });
          prev = it.h;
        }
        if (chain.length === 0) continue;
        // Seal coverage: the highest valid seal that lands on a chain-verified op.
        const candidates = seals.filter((s) => s.origin === origin && s.stream === stream).sort((a, b) => b.seq - a.seq);
        let covered = 0;
        let sawSeal = false;
        for (const s of candidates) {
          const idx = s.seq - cur - 1;
          if (idx < 0 || idx >= chain.length) continue;
          sawSeal = true;
          if (chain[idx]!.it.h === s.h && (await verifySeal(this.verifier, s))) {
            covered = idx + 1;
            freshSeals.push(s);
            break;
          }
        }
        // Released tail of a key-lost origin (A2.1): no seal will ever cover it. Each op needs a gateway
        // endorsement, the identity-signed `recovers` credential and the adopting device's attestation.
        const endorsed = new Set<number>();
        if (covered < chain.length && proofs.endorsements?.length) {
          for (let j = covered; j < chain.length; j++) {
            const link = chain[j]!;
            if (!link.op || !(await this.endorsedTail(link.it, proofs, chain, cur))) break;
            endorsed.add(j);
            covered = j + 1;
          }
        }
        if (covered < chain.length) {
          result.rejected.push({
            origin,
            seq: cur + covered + 1,
            reason: covered === 0 && !sawSeal ? "no seal covers these ops" : "seal invalid or does not match the chain",
          });
        }
        for (const { it, op } of chain.slice(0, covered)) {
          if (!op) {
            tx.put(T.op, { id: opRowId(it), tenant_id: this.tenantId, h: it.h, placeholder: true, state: "placeholder" } satisfies OpRow);
            tx.put(T.ph, { id: opId(it), tenant_id: this.tenantId, origin, stream, seq: it.seq });
          } else if (op.tenant_id !== this.tenantId) {
            result.rejected.push({ origin, seq: it.seq, reason: "tenant mismatch" });
            break;
          } else {
            await this.applyOne(tx, ctx, op, it, true, endorsed.has(chain.findIndex((c) => c.it === it)));
            result.applied++;
          }
          cur = it.seq;
          vv[origin] = cur;
        }
      }
      tx.put(T.vv, { id: stream, tenant_id: this.tenantId, vv });
      await this.storeSeals(tx, freshSeals);
      tx.put(T.meta, { id: "hlc", tenant_id: this.tenantId, v: this.clock.last() });
    });
    await this.refreshCounts();
    this.emit();
    return result;
  }

  /** Ops accepted under a gateway endorsement: marked `unsealed` in local audit views (A2.1 item 4). */
  async unsealedOps(): Promise<OpRef[]> {
    const out: OpRef[] = [];
    for (const r of (await this.store.list(T.op)) as OpRow[]) {
      const op = r.unsealed ? rowOp(r) : undefined;
      if (op) out.push({ origin: op.origin, stream: op.stream, seq: op.seq });
    }
    return out.sort((x, y) => x.seq - y.seq);
  }

  /** Placeholder slots this node holds, so it can name them in a pull and receive them once released. */
  async placeholders(): Promise<OpRef[]> {
    return (await this.store.list(T.ph)).map((r) => ({ origin: r.origin as string, stream: r.stream as string, seq: r.seq as number }));
  }

  /**
   * The three-part rule of A2.1 item 3 for one op of an unsealed tail. `chain` holds the chain-verified
   * ops being applied, so an attestation whose seq is in this batch is checked against the op we hold.
   */
  private async endorsedTail(it: WireItem, proofs: { endorsements?: Endorsement[]; attestations?: Attestation[] }, chain: Array<{ it: WireItem }>, cur: number): Promise<boolean> {
    const v = this.verifier;
    if (!v.verifyEndorsement || !v.recoveredBy) return false;
    const e = (proofs.endorsements ?? []).find((x) => x.origin === it.origin && x.stream === it.stream && x.seq === it.seq && x.h === it.h);
    if (!e || !(await v.verifyEndorsement(e))) return false;
    const y = v.recoveredBy(it.origin);
    if (!y) return false;
    for (const a of proofs.attestations ?? []) {
      if (a.origin !== it.origin || a.stream !== it.stream || a.rec !== e.rec || a.by !== y || it.seq > a.seq) continue;
      if (!(await v.verify(y, a.kid, attestationMessage(a), a.sig))) continue;
      // The op we hold at the attested seq, once we hold it, must carry the attested hash.
      const inBatch = chain.find((c) => c.it.seq === a.seq);
      const held = inBatch ? inBatch.it.h : a.seq <= cur ? ((await this.store.get(T.op, opRowId({ origin: it.origin, stream: it.stream, seq: a.seq }))) as OpRow | undefined)?.h : undefined;
      if (held !== undefined && held !== a.h) continue;
      return true;
    }
    return false;
  }

  private async applyOne(tx: StoreTx, ctx: ApplyCtx, op: OpEnvelope, it: WireItem, fresh: boolean, unsealed = false): Promise<void> {
    const ref: OpRef = { origin: op.origin, stream: op.stream, seq: op.seq };
    const row: OpRow = {
      id: opRowId(ref),
      tenant_id: this.tenantId,
      body: it.body,
      ...(it.pii !== undefined ? { pii: it.pii } : {}),
      h: it.h,
      state: "applied",
      ...(unsealed ? { unsealed: true } : {}),
    };
    if (op.v !== 1) {
      row.state = "opaque"; // newer protocol: keep, do not interpret (invariant 8)
    } else if (op.intent === "sync.void" && op.origin.startsWith("cloud-")) {
      // Only the cloud's own origin can void; its ops are sealed by the gateway key.
      const t = op.muts.find((m) => m.e === "sync_void")?.f as { origin?: string; stream?: string; seq?: number } | undefined;
      if (t?.origin && t.stream && typeof t.seq === "number") {
        const target: OpRef = { origin: t.origin, stream: t.stream, seq: t.seq };
        const targetRow = tx.get(T.op, opRowId(target)) as OpRow | undefined;
        applyVoidTo(tx, ctx, target, targetRow?.state === "applied" ? rowOp(targetRow) : undefined);
        if (target.origin === this.deviceId) {
          this.refused.add(opId(target));
          tx.put(T.meta, { id: "refused", tenant_id: this.tenantId, list: [...this.refused] });
        }
      }
    } else if (tx.get(T.void, opId(ref))) {
      row.state = "void_skipped"; // voided before it arrived: slot advances, mutations are skipped
    } else if (fresh && touchesLww(ctx, op) && (op.clk === "manual" || unpackHlc(op.hlc).ms > this.correctedNow() + MAX_FUTURE_MS)) {
      row.state = "clock_quarantined"; // LWW op with an untrusted stamp: manager review, not applied (S5)
      tx.put(T.clockq, { id: opId(ref), tenant_id: this.tenantId, origin: op.origin, stream: op.stream, seq: op.seq });
    } else {
      applyMutations(tx, ctx, op);
    }
    if (fresh && op.v === 1) this.clock.observe(op.hlc);
    tx.put(T.op, row);
  }

  private async refreshCounts(): Promise<void> {
    this.conflictCount = (await this.conflicts()).length;
    this.clockqCount = (await this.store.list(T.clockq)).length;
  }

  // ---- manager review items ------------------------------------------------------------------

  /** Concurrent edits of a high-risk field that nobody has confirmed yet. Derived, never merged away. */
  async conflicts(): Promise<ConflictRow[]> {
    const all = (await this.store.list(T.conflict)) as ConflictRow[];
    const open: ConflictRow[] = [];
    for (const c of all) if (!(await this.store.get("conflict_ack", c.id))) open.push(c);
    return open;
  }

  /** A manager confirms a concurrent edit (append-only `conflict_ack`). */
  async confirmConflict(conflictId: string, opts: Partial<RecordSpec> = {}): Promise<OpEnvelope> {
    const op = await this.record({
      intent: "conflict.confirm",
      build: () => [{ e: "conflict_ack", id: conflictId, k: "insert", f: {} }],
      ...opts,
    });
    await this.refreshCounts();
    this.emit();
    return op;
  }

  async clockQuarantine(): Promise<OpRef[]> {
    return (await this.store.list(T.clockq)).map((r) => ({ origin: r.origin as string, stream: r.stream as string, seq: r.seq as number }));
  }

  /** A manager releases an LWW op that was held for its clock stamp; it is then applied normally. */
  async releaseClockQuarantine(ref: OpRef): Promise<void> {
    await this.store.transact((tx) => {
      const row = tx.get(T.op, opRowId(ref)) as OpRow | undefined;
      const op = row && rowOp(row);
      if (!row || !op || row.state !== "clock_quarantined") return;
      const ctx = this.applyCtx(tx);
      if (!tx.get(T.void, opId(ref))) applyMutations(tx, ctx, op);
      tx.put(T.op, { ...row, state: "applied" });
      tx.del(T.clockq, opId(ref));
    });
    await this.refreshCounts();
    this.emit();
  }

  // ---- series --------------------------------------------------------------------------------

  /** Installs the series grants from the signed offline pack. Issuing codes is online only (S7). */
  async setSeriesGrants(grants: SeriesGrant[]): Promise<void> {
    await this.store.transact((tx) => {
      // The pack is authoritative: a grant it no longer lists is gone, so a device that adopts a kept
      // database (A1.3) can never number in its predecessor's series.
      const keep = new Set(grants.map((g) => `${g.code}|${g.docType}`));
      for (const g of tx.list(T.grant)) if (!keep.has(g.id)) tx.del(T.grant, g.id);
      putGrants(tx, this.tenantId, grants);
    });
  }

  // ---- reads ---------------------------------------------------------------------------------

  async rows(entity: string): Promise<Row[]> {
    return (await this.store.list(entity)).map(visible);
  }

  /**
   * The stamp of the value currently showing for a field: what a writer puts in `prev` when it edits a
   * review field, so the edit says which value it saw (ADR-0002 S6).
   */
  async stampOf(entity: string, id: string, field: string): Promise<string | undefined> {
    const row = (await this.store.get(entity, id)) as (Row & { _g?: Record<string, Array<{ h: string; o: string }>> }) | undefined;
    const cands = row?._g?.[field];
    if (!cands?.length) return undefined;
    return cands.reduce((w, c) => (c.h > w.h || (c.h === w.h && c.o > w.o) ? c : w)).h;
  }

  async opAt(ref: OpRef): Promise<OpEnvelope | undefined> {
    const row = (await this.store.get(T.op, opRowId(ref))) as OpRow | undefined;
    return row && rowOp(row);
  }

  /** Hash of the op at `ref`, if held (also for placeholders). */
  async hashAt(ref: OpRef): Promise<string | undefined> {
    return ((await this.store.get(T.op, opRowId(ref))) as OpRow | undefined)?.h;
  }

  /**
   * Canonical state hash over the visible rows of every declared entity: what the convergence checks
   * compare (ADR-0002 S15). Internal tables, candidates and conflict rows are not part of it.
   */
  async stateHash(): Promise<string> {
    const out: Record<string, Row[]> = {};
    for (const name of this.schemas.names()) {
      const rows = (await this.store.list(name)).map(visible).sort((a, b) => (a.id < b.id ? -1 : 1));
      if (rows.length) out[name] = rows;
    }
    return sha256Hex(canonicalize(out));
  }

  // ---- key loss (A1.3) -----------------------------------------------------------------------

  /**
   * Own-origin ops of a key-lost device that the cloud has not confirmed, with their stored seals and an
   * attestation signed by the NEW device key that fixes the tail (svc-sync `Attestation`). The new device
   * uploads this to the quarantine endpoint with a recovery drain token. Built on the adopting engine,
   * over the old origin's retained ops, which stay in the kept database.
   */
  async recoveryUpload(
    oldOrigin: string,
    cloudVector: Record<string, VersionVector>,
    recoveryId: string,
  ): Promise<Array<{ stream: string; items: WireItem[]; seals: Seal[]; attestation: Attestation }>> {
    const out = [];
    for (const stream of this.streams) {
      const vv = await this.vector(stream);
      const from = (cloudVector[stream]?.[oldOrigin] ?? 0) + 1;
      const to = vv[oldOrigin] ?? 0;
      if (to < from) continue;
      const items: WireItem[] = [];
      for (let seq = from; seq <= to; seq++) {
        const row = (await this.store.get(T.op, opRowId({ origin: oldOrigin, stream, seq }))) as OpRow | undefined;
        if (row?.body === undefined) throw new Error(`recovery: old origin op ${seq} not held`);
        items.push({ origin: oldOrigin, stream, seq, h: row.h, body: row.body, ...(row.pii !== undefined ? { pii: row.pii } : {}) });
      }
      const a = { origin: oldOrigin, stream, seq: to, h: items[items.length - 1]!.h, by: this.deviceId, rec: recoveryId };
      out.push({
        stream,
        items,
        seals: (await this.sealsOf(stream, oldOrigin)).filter((s) => s.seq >= from),
        attestation: { ...a, kid: this.signer.kid, sig: await this.signer.sign(attestationMessage(a)) },
      });
    }
    return out;
  }
}
