import { canonicalize } from "../canonical";
import { genesisHash, makeSeal, sha256Hex, verifySeal, type SealVerifier, type SoftwareSigner } from "../crypto";
import { packHlc } from "../hlc";
import {
  TransportError,
  fromWireVector,
  toWireVector,
  type HeldSlot,
  type HelloRequest,
  type HelloResponse,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Refusal,
  type SyncTransport,
  type WireVector,
} from "../transport";
import type { HeldCode, Mutation, OpEnvelope, OpRef, Seal, VersionVector, WireItem } from "../types";

/**
 * In-memory protocol node for tests: stands in for the cloud gateway or the LAN hub (a sync test double
 * in the sense of ADR-0002 D9). It verifies chain and seals like the real thing, can hold, void and
 * release slots, emit cloud-origin ops, be rolled back to an earlier state (a cloud restore) and inject
 * faults. It is test support, not production code.
 */
export type Verdict = { hold?: HeldCode; void?: boolean };

export type FakeNodeOpts = {
  role: "hub" | "cloud";
  nodeId: string;
  tenantId: string;
  streams: string[];
  verifier: SealVerifier;
  now: () => number;
  epoch?: string;
  /** Cloud only: signs cloud-origin ops and `sync.void`. */
  cloudSigner?: SoftwareSigner;
  /** Cloud only: verdict per accepted op (hold for a manager, void a configuration write). */
  policy?: (op: OpEnvelope) => Verdict | undefined;
};

type Slot = { item: WireItem; hold?: HeldCode; voided?: boolean };
type State = {
  slots: Map<string, Map<string, Slot[]>>; // stream -> origin -> dense by seq-1
  seals: Map<string, Seal[]>;
  epoch: string;
  cloudCounter: number;
  cloudLastMs: number;
};

export type Fault = { call: "hello" | "push" | "pull"; when: "before" | "after" };

export class FakeNode {
  up = true;
  readonly pushes: number[] = [];
  readonly refusals: Refusal[] = [];
  /** Hub: what the cloud last told it about held slots of relayed origins. */
  relayHeld = new Map<string, HeldCode>();
  lastCloudVector: WireVector = {};
  private faults: Fault[] = [];
  private st: State;

  constructor(private readonly o: FakeNodeOpts) {
    this.st = { slots: new Map(), seals: new Map(), epoch: o.epoch ?? "genesis", cloudCounter: 0, cloudLastMs: 0 };
  }

  get epoch(): string {
    return this.st.epoch;
  }

  /** Queue a fault for the next call of that kind. `after` applies the request and then loses the response. */
  inject(f: Fault): void {
    this.faults.push(f);
  }

  private fault(call: Fault["call"], when: Fault["when"]): void {
    const i = this.faults.findIndex((f) => f.call === call && f.when === when);
    if (i >= 0) {
      this.faults.splice(i, 1);
      throw new TransportError(0, `injected ${when} ${call}`, true);
    }
  }

  /** A transport as seen by one caller; `link.up` lets a test partition that one link. */
  connect(caller: string, link: { up: boolean } = { up: true }): SyncTransport {
    const gate = (): void => {
      if (!this.up || !link.up) throw new TransportError(0, "network unreachable", true);
    };
    return {
      hello: async (r) => (gate(), this.hello(r)),
      push: async (r) => (gate(), this.push(r)),
      pull: async (r) => (gate(), this.pull(r, caller)),
    };
  }

  // ---- state access ----------------------------------------------------------------------------

  private origins(stream: string): Map<string, Slot[]> {
    let m = this.st.slots.get(stream);
    if (!m) this.st.slots.set(stream, (m = new Map()));
    return m;
  }

  vector(): Record<string, VersionVector> {
    const out: Record<string, VersionVector> = {};
    for (const [stream, m] of this.st.slots) {
      out[stream] = {};
      for (const [origin, slots] of m) out[stream]![origin] = slots.length;
    }
    return out;
  }

  held(): Array<OpRef & { code: HeldCode }> {
    const out: Array<OpRef & { code: HeldCode }> = [];
    for (const [stream, m] of this.st.slots) {
      for (const [origin, slots] of m) {
        slots.forEach((s, i) => s.hold && out.push({ origin, stream, seq: i + 1, code: s.hold }));
      }
    }
    return out;
  }

  /** Ops held in order for an origin (for assertions on gapless sequences). */
  seqs(stream: string, origin: string): number[] {
    return (this.origins(stream).get(origin) ?? []).map((s) => s.item.seq);
  }

  bodies(stream: string, origin?: string): OpEnvelope[] {
    const out: OpEnvelope[] = [];
    for (const [o, slots] of this.origins(stream)) {
      if (origin && o !== origin) continue;
      for (const s of slots) if (s.item.body) out.push(JSON.parse(s.item.body) as OpEnvelope);
    }
    return out;
  }

  snapshot(): State {
    return structuredClone(this.st);
  }

  /** A cloud restore: state goes back; a new epoch is stamped and cloud ops restart under a new origin. */
  restore(snap: State, newEpoch: string): void {
    this.st = structuredClone(snap);
    this.st.epoch = newEpoch;
    this.st.cloudCounter = 0;
  }

  // ---- protocol --------------------------------------------------------------------------------

  async hello(req?: HelloRequest): Promise<HelloResponse> {
    void req; // the fake answers from its own state
    this.fault("hello", "before");
    const res: HelloResponse = {
      protocol: 1,
      role: this.o.role,
      node_id: this.o.nodeId,
      time: new Date(this.o.now()).toISOString(),
      epoch: this.st.epoch,
      vector: toWireVector(this.vector()),
      ...(this.o.role === "hub" ? { cloud_vector: this.lastCloudVector } : {}),
      min_supported_version: "0",
      snapshot_required: false,
      streams: this.o.streams,
    };
    this.fault("hello", "after");
    return res;
  }

  async push(req: PushRequest): Promise<PushResponse> {
    this.fault("push", "before");
    const held: HeldSlot[] = [];
    const refused: Refusal[] = [];
    const groups = new Map<string, WireItem[]>();
    for (const it of req.items) {
      const k = `${it.stream}\n${it.origin}`;
      groups.set(k, [...(groups.get(k) ?? []), it]);
    }
    for (const [k, run] of groups) {
      const [stream, origin] = k.split("\n") as [string, string];
      const r = await this.ingestRun(stream, origin, run, req.seals ?? [], true);
      held.push(...r.held);
      refused.push(...r.refused);
    }
    this.refusals.push(...refused);
    this.pushes.push(req.items.length);
    const res: PushResponse = { epoch: this.st.epoch, vector: toWireVector(this.vector()), held, refused };
    this.fault("push", "after");
    return res;
  }

  async pull(req: PullRequest, caller: string): Promise<PullResponse> {
    this.fault("pull", "before");
    const want = fromWireVector(req.vector);
    const limit = req.limit ?? 500;
    const items: WireItem[] = [];
    const seals: Seal[] = [];
    for (const stream of req.streams ?? this.o.streams) {
      for (const [origin, slots] of [...this.origins(stream)].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (origin === caller) continue;
        const from = want[stream]?.[origin] ?? 0;
        if (slots.length <= from || items.length >= limit) continue;
        let to = Math.min(slots.length, from + (limit - items.length));
        const stored = this.st.seals.get(`${stream}|${origin}`) ?? [];
        const fit = stored.find((s) => s.seq >= to) ?? [...stored].reverse().find((s) => s.seq <= to);
        if (!fit) continue;
        to = fit.seq;
        if (to <= from) continue;
        for (let seq = from + 1; seq <= to; seq++) {
          const s = slots[seq - 1]!;
          const hidden = s.hold || s.voided;
          items.push(hidden ? { origin, stream, seq, h: s.item.h } : s.item);
        }
        seals.push(fit);
      }
    }
    // Slots the caller holds as placeholders and that have since been released.
    for (const ref of req.placeholders ?? []) {
      const s = this.origins(ref.stream).get(ref.origin)?.[ref.seq - 1];
      if (s && !s.hold && !s.voided) items.push(s.item);
    }
    const own: HeldSlot[] = [];
    const relay: HeldSlot[] = [];
    for (const h of this.held()) {
      if (h.origin === caller) own.push(h);
      else relay.push(h);
    }
    // A hub answers each device from what the cloud told it.
    if (this.o.role === "hub") {
      for (const [k, code] of this.relayHeld) {
        const [stream, origin, seq] = k.split("|") as [string, string, string];
        if (origin === caller) own.push({ origin, stream, seq: Number(seq), code });
      }
    }
    const res: PullResponse = {
      epoch: this.st.epoch,
      items,
      seals,
      more: items.length >= limit,
      own_held: own,
      ...(this.o.role === "cloud" ? { relay_held: relay } : {}),
    };
    this.fault("pull", "after");
    return res;
  }

  // ---- ingest and verification ---------------------------------------------------------------

  private async ingestRun(
    stream: string,
    origin: string,
    run: WireItem[],
    seals: Seal[],
    judge: boolean,
  ): Promise<{ held: HeldSlot[]; refused: Refusal[] }> {
    const held: HeldSlot[] = [];
    const refused: Refusal[] = [];
    const slots = this.origins(stream).get(origin) ?? [];
    run.sort((a, b) => a.seq - b.seq);
    // A released op replaces the placeholder this node held for its slot.
    for (const it of run) {
      const held = slots[it.seq - 1];
      if (held && held.item.body === undefined && it.body !== undefined && it.h === held.item.h && (await sha256Hex(it.body)) === it.h) held.item = it;
    }
    const fresh = run.filter((it) => it.seq > slots.length);
    let prev = slots.length ? slots[slots.length - 1]!.item.h : await genesisHash(origin, stream);
    const chain: Array<{ it: WireItem; op?: OpEnvelope }> = [];
    for (const it of fresh) {
      const slot = slots.length + chain.length + 1;
      if (it.seq !== slot) {
        refused.push({ origin, stream, seq: it.seq, reason: "gap" });
        break;
      }
      if (it.body === undefined) {
        chain.push({ it });
        prev = it.h;
        continue;
      }
      if ((await sha256Hex(it.body)) !== it.h) {
        refused.push({ origin, stream, seq: it.seq, reason: "framing" });
        break;
      }
      const op = JSON.parse(it.body) as OpEnvelope;
      if (op.origin !== origin || op.stream !== stream || op.seq !== it.seq || op.tenant_id !== this.o.tenantId) {
        refused.push({ origin, stream, seq: it.seq, reason: "origin_not_in_outlet" });
        break;
      }
      if (op.ph !== prev) {
        refused.push({ origin, stream, seq: it.seq, reason: "chain_invalid" });
        break;
      }
      chain.push({ it, op });
      prev = it.h;
    }
    if (chain.length === 0) return { held, refused };
    let covered = 0;
    let used: Seal | undefined;
    for (const s of seals.filter((x) => x.origin === origin && x.stream === stream).sort((a, b) => b.seq - a.seq)) {
      const idx = s.seq - slots.length - 1;
      if (idx < 0 || idx >= chain.length) continue;
      if (chain[idx]!.it.h === s.h && (await verifySeal(this.o.verifier, s))) {
        covered = idx + 1;
        used = s;
        break;
      }
    }
    if (covered < chain.length) refused.push({ origin, stream, seq: slots.length + covered + 1, reason: covered === 0 ? "unsealed" : "seal_invalid" });
    const m = this.origins(stream);
    if (!m.has(origin)) m.set(origin, slots);
    for (const { it, op } of chain.slice(0, covered)) {
      const slot: Slot = { item: it };
      if (judge && this.o.role === "cloud" && op) {
        const v = this.o.policy?.(op);
        if (v?.hold) slot.hold = v.hold;
        if (v?.void) slot.voided = true;
      }
      slots.push(slot);
      if (slot.hold) held.push({ origin, stream, seq: it.seq, code: slot.hold });
      if (slot.voided && op) await this.emitVoid({ origin, stream, seq: it.seq });
    }
    if (used) {
      const k = `${stream}|${origin}`;
      const cur = this.st.seals.get(k) ?? [];
      if (!cur.some((s) => s.seq === used.seq)) this.st.seals.set(k, [...cur, used].sort((a, b) => a.seq - b.seq));
    }
    return { held, refused };
  }

  // ---- manager and cloud actions ---------------------------------------------------------------

  release(ref: OpRef): void {
    const s = this.origins(ref.stream).get(ref.origin)?.[ref.seq - 1];
    if (s) delete s.hold;
  }

  /** The cloud emits an op under its current epoch origin, sealed with the gateway key (a web edit, a void). */
  async emit(stream: string, intent: string, muts: Mutation[]): Promise<OpRef> {
    const signer = this.o.cloudSigner;
    if (!signer) throw new Error("emit: not a cloud node");
    const origin = `cloud-${this.st.epoch}`;
    const slots = this.origins(stream).get(origin) ?? [];
    if (!this.origins(stream).has(origin)) this.origins(stream).set(origin, slots);
    const ms = Math.max(this.o.now(), this.st.cloudLastMs);
    this.st.cloudCounter = ms === this.st.cloudLastMs ? this.st.cloudCounter + 1 : 0;
    this.st.cloudLastMs = ms;
    const body = canonicalize({
      v: 1,
      origin,
      stream,
      seq: slots.length + 1,
      ph: slots.length ? slots[slots.length - 1]!.item.h : await genesisHash(origin, stream),
      hlc: packHlc(ms, this.st.cloudCounter),
      clk: "sync",
      tenant_id: this.o.tenantId,
      actor: "cloud",
      sid: "cloud",
      pack_v: "0",
      intent,
      intent_v: 1,
      at: new Date(ms).toISOString(),
      muts,
    });
    const h = await sha256Hex(body);
    const seq = slots.length + 1;
    slots.push({ item: { origin, stream, seq, h, body } });
    const k = `${stream}|${origin}`;
    this.st.seals.set(k, [...(this.st.seals.get(k) ?? []), await makeSeal(signer, origin, stream, seq, h)]);
    return { origin, stream, seq };
  }

  private emitVoid(target: OpRef): Promise<OpRef> {
    return this.emit(target.stream, "sync.void", [
      { e: "sync_void", id: `${target.origin}|${target.stream}|${target.seq}`, k: "insert", f: { ...target, reason: "refused" } },
    ]);
  }

  /** Cloud voids an op it had already accepted and served (a refusal found later). */
  async voidOp(ref: OpRef): Promise<void> {
    const s = this.origins(ref.stream).get(ref.origin)?.[ref.seq - 1];
    if (!s) throw new Error("voidOp: no such slot");
    s.voided = true;
    await this.emitVoid(ref);
  }

  // ---- hub relay -------------------------------------------------------------------------------

  /** A hub is a client of the cloud with relay scope: push everything above the cloud's vector, pull the rest. */
  async relayWith(cloud: FakeNode, link: { up: boolean } = { up: true }): Promise<void> {
    if (!cloud.up || !link.up) throw new TransportError(0, "network unreachable", true);
    const hello = await cloud.hello({ protocol: 1 });
    const theirs = fromWireVector(hello.vector);
    for (const stream of this.o.streams) {
      for (const [origin, slots] of this.origins(stream)) {
        const from = theirs[stream]?.[origin] ?? 0;
        if (slots.length <= from) continue;
        const stored = (this.st.seals.get(`${stream}|${origin}`) ?? []).filter((s) => s.seq > from);
        const top = stored[stored.length - 1];
        if (!top) continue;
        const items = slots.slice(from, top.seq).map((s) => s.item);
        await cloud.push({ items, seals: [top] });
      }
    }
    const placeholders: OpRef[] = [];
    for (const stream of this.o.streams) {
      for (const [origin, slots] of this.origins(stream)) slots.forEach((s, i) => s.item.body === undefined && placeholders.push({ origin, stream, seq: i + 1 }));
    }
    const res = await cloud.pull({ vector: toWireVector(this.vector()), streams: this.o.streams, placeholders, limit: 100000 }, this.o.nodeId);
    const byKey = new Map<string, WireItem[]>();
    for (const it of res.items) byKey.set(`${it.stream}\n${it.origin}`, [...(byKey.get(`${it.stream}\n${it.origin}`) ?? []), it]);
    for (const [k, run] of byKey) {
      const [stream, origin] = k.split("\n") as [string, string];
      await this.ingestRun(stream, origin, run, res.seals ?? [], false);
    }
    this.relayHeld = new Map((res.relay_held ?? []).map((h) => [`${h.stream}|${h.origin}|${h.seq}`, h.code]));
    this.lastCloudVector = toWireVector(cloud.vector());
    this.st.epoch = cloud.epoch; // the hub reports the cloud epoch it last saw
  }
}
