import { uuidv7 } from "../ids";
import { InMemoryStore, type LocalStore, type Row, type StoreTx } from "../store";
import {
  applyMutations,
  eraseRowFields,
  fillRowFields,
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
import { MAX_OP_BODY_BYTES, MAX_PII_BYTES, OpTooLargeError, splitPii, utf8Bytes, withPii, type PiiObject } from "./pii";
import { commitPii, openPii, stripSalts, systemRandom, type PiiValues, type RandomBytes } from "./pii-commit";
import type { SchemaRegistry, DocType } from "./schema";
import { drainSigningMessage, drainStatementHash, type DrainStatement, type UnsignedDrainStatement } from "./drain";
import { allocateNumber, financialYear, putGrants, type SeriesGrant } from "./series";
import { digestRowText, entityDigest, stateDigest } from "./digest";
import type { PiiWire } from "./pii-commit";
import { missingPiiFields, mergePii, servesPii, withCommits, type DeviceKind } from "./pii-serve";
import type {
  Attestation,
  ChainConflict,
  Endorsement,
  ClockMode,
  DeliveryState,
  HeldItem,
  Mutation,
  OpEnvelope,
  OpRef,
  Seal,
  SlotHash,
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

export class DrainingError extends Error {
  constructor() {
    super("this device is in drain mode: it records nothing new (ADR-0005 A3.3)");
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
  packVersion: number;
  /**
   * Credential kind of this device (ADR-0014 A3.1). Decides whether it receives personal data: `pos`, `waiter`,
   * `personal` and `hub` do; a `kds` never does and never fetches it. Default `pos`.
   */
  deviceKind?: DeviceKind;
  /** Wall clock in ms; injectable. */
  now?: () => number;
  clockMode?: ClockMode;
  /** A device holding unpushed ops seals its head at least this often (ADR-0002 A1.3 item 8). Default 5 min. */
  sealIntervalMs?: number;
  newId?: () => string;
  /** Randomness of pii salts; injectable for tests. Default crypto.getRandomValues. */
  randomBytes?: RandomBytes;
  /**
   * Called after a cloud-signed erasure removed personal data from this node, with the values that were removed, so
   * other local holders (print spool, caches outside the sync store) can purge them too. The values are for matching only.
   */
  onPiiErased?: (e: { ref: OpRef; values: PiiValues }) => void;
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
  /** Opaque PIN-derived proof (ADR-0005); stamped by the auth layer. Sent only on `session.open` and `approval.grant`, where `pinV` is required (A3.1); ignored on any other intent. */
  proof?: string;
  /** PIN version the proof was made under (A3.1). */
  pinV?: number;
  /**
   * The time a proof binds: take it from `stampTime()` before the proof is made. Used as the op's `at` on `session.open`
   * (the opening time), `approval.grant` and `approval.self_confirm` (the approval time); ignored elsewhere (A3.1).
   */
  at?: string;
  /**
   * Personal data beside the op, outside its hash, as entity -> row id -> field -> value. Fields the entity schema
   * declares `pii` are moved here from the mutations automatically, so a builder normally passes nothing. Typed
   * loosely so older callers still compile; anything that is not that shape (the old flat form) is ignored.
   */
  pii?: PiiObject | Record<string, unknown>;
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
  /** Taken by hash with no seal and no neighbour that binds it (A2.8 item 1.3): never relayed, cross-checked with the cloud. */
  unbound?: boolean;
};

/** A node behind a hub reaches the cloud directly at least this often when it can (A2.8 item 1.3). */
export const DIRECT_CLOUD_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Most slots listed in one hello `unbound`, and in one pull `stale_seals`. */
const MAX_UNBOUND = 500;
const MAX_STALE_SEALS = 200;
/** Most erasures acknowledged in one hello (the gateway reads 500). */
const MAX_PII_ACKS = 500;
const PII_ERASE_INTENT = "sync.pii.erase";
const PII_ERASE_RECORD = "pii_erase";
const SESSION_OPEN = "session.open";
/** The only intents whose op carries `proof` and `pin_v` (ADR-0005 A3.1). */
const PROOF_INTENTS = new Set([SESSION_OPEN, "approval.grant", "approval.self_confirm"]);
/** Intents whose proof binds the op's own `at`: the shell stamps the time (`stampTime`), makes the proof and passes the time back (A3.1, the approval proof). */
const AT_INTENTS = new Set(PROOF_INTENTS);
const piiErasedId = (r: OpRef): string => `pii_erased:${opId(r)}`;

type CcRow = Row & { origin: string; stream: string; seq: number; held: string; seen?: string; src: "cloud" | "relay"; reported: boolean };
const ccId = (origin: string, stream: string, src: string): string => `${origin}|${stream}|${src}`;

/** Inverse of `opRowId`. */
function opRefOf(rowId: string): OpRef {
  const [stream, origin, seq] = rowId.split("|") as [string, string, string];
  return { stream, origin, seq: Number(seq) };
}

/** What `applyRemote` is told besides the items: proof that travels with them, and where they came from. */
export type RemoteProofs = {
  endorsements?: Endorsement[];
  attestations?: Attestation[];
  /** The batch comes from the cloud itself (a direct cloud route, or the hub's own upstream). Only the cloud may supply trailing placeholders or bodies above the sealed head (A2.8 item 1.1). */
  fromCloud?: boolean;
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
  private readonly random: RandomBytes;
  private readonly onPiiErased: ((e: { ref: OpRef; values: PiiValues }) => void) | undefined;
  private erasedNow: Array<{ ref: OpRef; values: PiiValues }> = [];
  readonly deviceKind: DeviceKind;
  private packVersion: number;
  private readonly clockMode: ClockMode;
  private readonly sealIntervalMs: number;

  private heads = new Map<string, Head>();
  private deliv = new Map<string, Deliv>();
  private held: HeldItem[] = [];
  private refused = new Set<string>();
  private draining = false;
  private conflictCount = 0;
  private chainConflictCount = 0;
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
    this.random = cfg.randomBytes ?? systemRandom;
    this.onPiiErased = cfg.onPiiErased;
    this.deviceKind = cfg.deviceKind ?? "pos";
    if (!Number.isInteger(cfg.packVersion) || cfg.packVersion < 1) throw new Error("packVersion must be an integer >= 1");
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
    e.draining = (await store.get(T.meta, "drain"))?.v === true;
    e.held = ((await store.get(T.held, "own"))?.items as HeldItem[] | undefined) ?? [];
    for (const s of e.streams) {
      const h = (await store.get(T.head, `${s}|${cfg.deviceId}`)) as Head | undefined;
      if (h) e.heads.set(s, h);
      const d = await store.get(T.deliv, s);
      if (d) e.deliv.set(s, { hub: d.hub as VersionVector, cloud: d.cloud as VersionVector });
    }
    e.conflictCount = (await e.conflicts()).length;
    e.chainConflictCount = (await store.list(T.cc)).length;
    // First-time activation is an online step with the cloud, so the 24-hour direct-check clock starts there.
    if (!(await store.get(T.meta, "cloud_hello_at"))) await store.transact((tx) => tx.put(T.meta, { id: "cloud_hello_at", tenant_id: store.tenantId, v: e.now() }));
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
    if (this.draining) throw new DrainingError();
    const stream = spec.stream ?? this.outletStream;
    const actor = spec.actor ?? this.session?.actor;
    const sid = spec.sid ?? this.session?.sid;
    if (!actor || !sid) throw new Error("record: no session (actor and sid are stamped on every op)");
    // A proof travels once, on the op that carries it, with the PIN version it was made under (ADR-0005 A3.1).
    const carriesProof = spec.proof !== undefined && PROOF_INTENTS.has(spec.intent);
    if (carriesProof && (!Number.isInteger(spec.pinV) || (spec.pinV as number) < 1)) throw new Error(`record: ${spec.intent} with a proof needs pinV (integer >= 1)`);
    if (AT_INTENTS.has(spec.intent) && spec.at !== undefined && new Date(spec.at).toISOString() !== spec.at) throw new Error(`record: ${spec.intent} at must be an RFC 3339 UTC time with milliseconds`);

    const op = await this.store.transact(async (tx) => {
      const head: Head =
        (tx.get(T.head, this.headId(stream)) as Head | undefined) ??
        ({ id: this.headId(stream), tenant_id: this.tenantId, seq: 0, h: await genesisHash(this.deviceId, stream), sealedSeq: 0, sealedAt: this.now() } as Head);
      const nowMs = this.correctedNow();
      // An op may take several legal numbers in this one transaction (bill.rebill: a credit note and the new bills);
      // they commit with the op or not at all, so no number is burnt or duplicated.
      const allocated: NonNullable<OpEnvelope["doc"]>[] = [];
      const built = spec.build({
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
      for (const m of built) {
        if (!this.schemas.get(m.e)) throw new Error(`record: unknown entity ${m.e}`);
      }
      // Personal data never enters the hashed body: declared fields move to the op's `pii` (S4).
      const { muts, pii } = splitPii(built, this.schemas, spec.pii);
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
        ...(carriesProof ? { proof: spec.proof, pin_v: spec.pinV } : {}),
        intent: spec.intent,
        intent_v: spec.intentV ?? 1,
        at: AT_INTENTS.has(spec.intent) && spec.at !== undefined ? spec.at : new Date(nowMs).toISOString(),
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
      // The sealed body carries a salted commitment per personal field; values and salts travel beside it (pii-commit.ts).
      const committed = await commitPii(pii, this.random);
      if (committed) envelope.pii_c = committed.commits;
      const body = canonicalize(envelope);
      // Refused before anything is recorded: throwing here rolls the transaction back, legal numbers included.
      const bodyBytes = utf8Bytes(body);
      if (bodyBytes > MAX_OP_BODY_BYTES) throw new OpTooLargeError("body", bodyBytes, MAX_OP_BODY_BYTES);
      const piiBytes = committed ? utf8Bytes(JSON.stringify(committed.wire)) : 0; // as sent: values and salts
      if (piiBytes > MAX_PII_BYTES) throw new OpTooLargeError("pii", piiBytes, MAX_PII_BYTES);
      const h = await sha256Hex(body);
      const applied = JSON.parse(body) as OpEnvelope; // apply exactly what receivers will parse
      applyMutations(tx, this.applyCtx(tx), withPii(withCommits(applied), pii));
      tx.put(T.op, {
        id: opRowId(applied),
        tenant_id: this.tenantId,
        body,
        ...(committed ? { pii: committed.wire } : {}),
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
      // A direct cloud hello: stamps the 24-hour check and clears the "refused a cloud seal" interim flag (A2.8).
      tx.put(T.meta, { id: "cloud_hello_at", tenant_id: this.tenantId, v: this.now() });
      tx.del(T.meta, "stale_cloud_seal");
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

  // ---- drain (ADR-0005 A3.3) -----------------------------------------------------------------

  get isDraining(): boolean {
    return this.draining;
  }

  /** Enters drain mode for good: the device records nothing new, so what it signs stays true. Survives a restart. */
  async beginDrain(): Promise<void> {
    this.draining = true;
    await this.store.transact((tx) => {
      tx.put(T.meta, { id: "drain", tenant_id: this.tenantId, v: true });
    });
    this.emit();
  }

  /**
   * The signed `hostry-drain-v1` statement: the head of every stream in which the log holds an op of `origin`
   * (default this device), and the last number of every series in the pack, 0 when never used. Signed with the
   * device key; for a key-lost device `origin` is the old one and `by`/`rec` name the adopting device and the
   * recovery. Built once: the cloud refuses a second, different statement for an origin, so later calls return
   * the stored one. Throws when a series in the pack carries no `seriesId`.
   */
  async drainStatement(opts: { origin?: string; rec?: string } = {}): Promise<DrainStatement> {
    const origin = opts.origin ?? this.deviceId;
    const key = `drain_statement:${origin}`;
    const kept = (await this.store.get(T.meta, key))?.statement as DrainStatement | undefined;
    if (kept) return kept;
    if (this.keyLost) throw new KeyLostError();
    const streams: DrainStatement["streams"] = [];
    for (const stream of this.streams) {
      const seq = (await this.vector(stream))[origin] ?? 0;
      if (seq < 1) continue;
      const h = await this.hashAt({ origin, stream, seq });
      if (h === undefined) throw new Error(`drain: op ${origin}/${stream}/${seq} not held`);
      streams.push({ stream, seq, h });
    }
    streams.sort((a, b) => (a.stream < b.stream ? -1 : 1));
    const counters = (await this.store.list(T.series)) as Array<Row & { next: number }>;
    const fyNow = financialYear(this.correctedNow());
    const series: DrainStatement["series"] = [];
    for (const g of (await this.store.list(T.grant)) as Array<Row & SeriesGrant>) {
      if (!g.seriesId) throw new Error(`drain: series ${g.code} has no series_id in the pack`);
      const rows = counters.filter((c) => c.id.startsWith(`${g.code}|${g.docType}|`));
      if (rows.length === 0) series.push({ series_id: g.seriesId, code: g.code, fy: fyNow, last_number: 0 });
      for (const c of rows) series.push({ series_id: g.seriesId, code: g.code, fy: c.id.split("|")[2]!, last_number: c.next });
    }
    series.sort((a, b) => (a.series_id + a.fy < b.series_id + b.fy ? -1 : 1));
    const unsigned: UnsignedDrainStatement = {
      origin,
      streams,
      series,
      by: this.deviceId,
      ...(opts.rec !== undefined ? { rec: opts.rec } : {}),
      kid: this.signer.kid,
      at: new Date(this.correctedNow()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const statement: DrainStatement = { ...unsigned, sig: await this.signer.sign(drainSigningMessage(unsigned)) };
    await this.store.transact((tx) => {
      tx.put(T.meta, { id: key, tenant_id: this.tenantId, statement });
    });
    return statement;
  }

  /**
   * True when `hash` is the hash of the statement this device signed and every op it holds is still covered by it:
   * the shell wipes only on an order quoting such a hash (ADR-0005 A3.3 item 6).
   */
  async ownsDrainStatement(hash: string): Promise<boolean> {
    const s = (await this.store.get(T.meta, `drain_statement:${this.deviceId}`))?.statement as DrainStatement | undefined;
    if (!s || (await drainStatementHash(s)) !== hash) return false;
    for (const stream of this.streams) {
      const stated = s.streams.find((x) => x.stream === stream)?.seq ?? 0;
      if (((await this.vector(stream))[this.deviceId] ?? 0) !== stated) return false;
    }
    return true;
  }

  /** Sets the pack version stamped on new ops (a pack refresh); an integer >= 1. */
  setPackVersion(v: number): void {
    if (!Number.isInteger(v) || v < 1) throw new Error("packVersion must be an integer >= 1");
    this.packVersion = v;
  }

  /**
   * The time the next op will carry, as the engine stamps it (corrected clock, RFC 3339 UTC, ms). The shell takes it
   * as the opening time before it makes a session proof and hands it back as `at` of `session.open` (A3.1).
   */
  stampTime(): string {
    return new Date(this.correctedNow()).toISOString();
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
    const attentionOps = this.held.filter((h) => h.code !== "pending").length + this.refused.size + this.conflictCount + this.chainConflictCount + this.clockqCount;
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
        if (row.unbound && origin !== this.deviceId) break; // an unbound op, and all after it, is never relayed (A2.8 item 1.3)
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
  async applyRemote(stream: string, items: WireItem[], seals: Seal[], proofs: RemoteProofs = {}): Promise<RemoteResult> {
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
      const fromCloud = proofs.fromCloud === true;
      const src = fromCloud ? "cloud" : "relay";
      // A cloud-origin seal under a key this node does not accept is not taken, and says so: the node reads
      // that origin from the cloud directly until its hub has refreshed the seal (A2.8 item 2, interim rule).
      if (this.verifier.acceptsCloudKid) {
        for (const s of seals) {
          if (s.stream === stream && s.origin.startsWith("cloud-") && !this.verifier.acceptsCloudKid(s.kid)) {
            tx.put(T.meta, { id: "stale_cloud_seal", tenant_id: this.tenantId, v: true });
          }
        }
      }
      for (const [origin, list] of byOrigin) {
        if (origin === this.deviceId) {
          result.skipped += list.length; // our own ops are never taken back from an upstream
          continue;
        }
        if (tx.get(T.cc, ccId(origin, stream, src))) {
          // A recorded conflict: nothing more of this origin from this kind of upstream (A2.8 item 1.4).
          for (const it of list) result.rejected.push({ origin, seq: it.seq, reason: "chain_conflict" });
          continue;
        }
        list.sort((a, b) => a.seq - b.seq);
        let cur = vv[origin] ?? 0;
        // A placeholder slot we hold may come back as the released op: bound where it can be, else marked unbound.
        const fresh: WireItem[] = [];
        for (const it of list) {
          if (it.seq > cur) {
            fresh.push(it);
            continue;
          }
          const row = tx.get(T.op, opRowId(it)) as OpRow | undefined;
          if (row?.placeholder && it.body !== undefined) {
            await this.fillPlaceholder(tx, ctx, row, it, list, seals, proofs, cur, src, result);
          } else if (row && it.body !== undefined && it.h !== row.h && (await sha256Hex(it.body)) === it.h) {
            // An upstream serves a body that contradicts what this node holds at the slot: never silent (A2.8 item 1.4).
            this.noteConflict(tx, { origin, stream, seq: it.seq, held: row.h, seen: it.h }, src);
            result.rejected.push({ origin, seq: it.seq, reason: "chain_conflict" });
          } else {
            // A slot already held that comes again with pii: it fills a field the row was missing (`pii_incomplete`).
            if (row && it.pii !== undefined && it.h === row.h) await this.fillPii(tx, row, it);
            result.skipped++;
          }
        }
        const headRow = cur > 0 ? (tx.get(T.op, opRowId({ origin, stream, seq: cur })) as OpRow | undefined) : undefined;
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
            if (chain.length === 0 && headRow?.unbound) {
              // The op above does not link to the head slot we took by hash: that slot is contradicted (A2.8 item 1.2).
              this.noteConflict(tx, { origin, stream, seq: cur, held: headRow.h, seen: op.ph }, src);
              result.rejected.push({ origin, seq: it.seq, reason: "chain_conflict" });
              break;
            }
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
        // Only the cloud may supply placeholders after the last covered slot; a relay's are refused (A2.8 item 1.1).
        if (fromCloud) while (covered < chain.length && !chain[covered]!.op) covered++;
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
        // The first accepted op links to the head slot taken by hash: that binds it.
        const first = chain[0]?.op;
        if (covered > 0 && headRow?.unbound && first && first.ph === headRow.h) this.clearUnbound(tx, headRow);
      }
      tx.put(T.vv, { id: stream, tenant_id: this.tenantId, vv });
      await this.storeSeals(tx, freshSeals);
      tx.put(T.meta, { id: "hlc", tenant_id: this.tenantId, v: this.clock.last() });
    });
    await this.refreshCounts();
    this.emit();
    return result;
  }

  // ---- placeholders, binding and conflicts (ADR-0002 A2.8) -----------------------------------

  /** Records a chain conflict once per (origin, stream, kind of upstream); the first stays. */
  private noteConflict(tx: StoreTx, c: ChainConflict, src: "cloud" | "relay"): void {
    const id = ccId(c.origin, c.stream, src);
    if (tx.get(T.cc, id)) return;
    tx.put(T.cc, { id, tenant_id: this.tenantId, ...c, src, reported: false } satisfies CcRow);
  }

  /** Removes the unbound mark of a stored slot. */
  private clearUnbound(tx: StoreTx, row: OpRow): void {
    if (!row.unbound) return;
    const next: OpRow = { ...row };
    delete next.unbound;
    tx.put(T.op, next);
    tx.del(T.unbound, opId(opRefOf(row.id)));
  }

  /** True when a valid seal of the slot's origin covers the slot: one stored, or one in the batch that verifies (A2.8 item 1.1). */
  private async sealedAtOrAbove(tx: StoreTx, seals: Seal[], ref: OpRef): Promise<boolean> {
    const stored = (tx.get(T.seal, `${ref.stream}|${ref.origin}`)?.seals as Seal[] | undefined) ?? [];
    if (stored.some((s) => s.seq >= ref.seq)) return true;
    for (const s of seals) {
      if (s.origin === ref.origin && s.stream === ref.stream && s.seq >= ref.seq && (await verifySeal(this.verifier, s))) return true;
    }
    return false;
  }

  /**
   * How a body that arrives over a held placeholder binds (A2.8 item 1.2), checked in order: its link to the
   * slot below, a seal that names the slot, then the op held (or in the batch) above. Nothing to bind it
   * means `unbound`. `seen` is the hash that contradicts the slot on a conflict.
   */
  private async bindSlot(tx: StoreTx, ref: OpRef, op: OpEnvelope, hb: string, batch: WireItem[], seals: Seal[]): Promise<{ r: "ok" | "unbound" } | { r: "conflict"; seen: string }> {
    // Below: the body must chain to what the node holds at seq-1.
    if (ref.seq === 1) {
      if (op.ph !== (await genesisHash(ref.origin, ref.stream))) return { r: "conflict", seen: op.ph };
    } else {
      const lo = tx.get(T.op, opRowId({ ...ref, seq: ref.seq - 1 })) as OpRow | undefined;
      if (lo?.h && op.ph !== lo.h) return { r: "conflict", seen: op.ph };
    }
    // A seal that names exactly this slot.
    const stored = ((tx.get(T.seal, `${ref.stream}|${ref.origin}`)?.seals as Seal[] | undefined) ?? []).find((s) => s.seq === ref.seq);
    if (stored) return stored.h === hb ? { r: "ok" } : { r: "conflict", seen: stored.h };
    for (const s of seals) {
      if (s.origin === ref.origin && s.stream === ref.stream && s.seq === ref.seq && (await verifySeal(this.verifier, s))) {
        return s.h === hb ? { r: "ok" } : { r: "conflict", seen: s.h };
      }
    }
    // Above: the op held at seq+1 names this slot as its predecessor. An op itself taken by hash with no binding proves nothing.
    const up = tx.get(T.op, opRowId({ ...ref, seq: ref.seq + 1 })) as OpRow | undefined;
    const upOp = up && !up.unbound ? rowOp(up) : undefined;
    if (upOp) return upOp.ph === hb ? { r: "ok" } : { r: "conflict", seen: upOp.ph };
    for (const it of batch) {
      if (it.seq !== ref.seq + 1 || it.body === undefined || (await sha256Hex(it.body)) !== it.h) continue;
      const b = parseBody(it);
      if (b) return b.ph === hb ? { r: "ok" } : { r: "conflict", seen: b.ph };
    }
    return { r: "unbound" };
  }

  /**
   * A body for a slot held as a placeholder (a released op, A2.8 item 1). Taken only if it hashes to the held
   * `h`, the tenant is ours, and (unless it comes from the cloud, or under a valid endorsement) a seal covers the
   * slot. Then bound by link, seal or the op above, else marked `unbound`. A contradiction is a `chain_conflict`.
   */
  private async fillPlaceholder(
    tx: StoreTx,
    ctx: ApplyCtx,
    row: OpRow,
    it: WireItem,
    batch: WireItem[],
    seals: Seal[],
    proofs: RemoteProofs,
    cur: number,
    src: "cloud" | "relay",
    result: RemoteResult,
  ): Promise<void> {
    const ref: OpRef = { origin: it.origin, stream: it.stream, seq: it.seq };
    const reject = (reason: string): void => {
      result.rejected.push({ origin: it.origin, seq: it.seq, reason });
    };
    const hb = await sha256Hex(it.body ?? "");
    if (hb !== row.h) {
      // The body contradicts the hash held for the slot: never silent.
      this.noteConflict(tx, { ...ref, held: row.h, seen: hb }, src);
      reject("chain_conflict");
      return;
    }
    const op = parseBody(it);
    if (!op) {
      reject("body does not match its identity");
      return;
    }
    if (op.tenant_id !== this.tenantId) {
      reject("tenant mismatch");
      return;
    }
    let unsealed = false;
    let bound: boolean;
    if ((proofs.endorsements ?? []).some((x) => x.origin === it.origin && x.stream === it.stream && x.seq === it.seq)) {
      // An endorsement that comes with the body must pass the rule of A2.1; it also binds the slot.
      if (!(await this.endorsedTail({ ...it, h: row.h }, proofs, batch.map((b) => ({ it: b })), cur))) {
        reject("endorsement does not verify");
        return;
      }
      unsealed = true;
      bound = true;
    } else {
      if (src !== "cloud" && !(await this.sealedAtOrAbove(tx, seals, ref))) {
        reject("unsealed"); // no placeholder is filled by hash above the origin's sealed head except by the cloud
        return;
      }
      const b = await this.bindSlot(tx, ref, op, hb, batch, seals);
      if (b.r === "conflict") {
        this.noteConflict(tx, { ...ref, held: row.h, seen: b.seen }, src);
        reject("chain_conflict");
        return;
      }
      bound = b.r === "ok";
    }
    await this.applyOne(tx, ctx, op, it, false, unsealed);
    tx.del(T.ph, opId(it));
    if (!bound) {
      tx.put(T.op, { ...(tx.get(T.op, opRowId(ref)) as OpRow), unbound: true });
      tx.put(T.unbound, { id: opId(ref), tenant_id: this.tenantId, ...ref });
    } else if (ref.seq > 1) {
      // A bound body links to the slot below: that binds it too, if it was taken unbound.
      const lo = tx.get(T.op, opRowId({ ...ref, seq: ref.seq - 1 })) as OpRow | undefined;
      if (lo?.unbound && lo.h === op.ph) this.clearUnbound(tx, lo);
    }
    result.applied++;
  }

  /** Slots this node took by hash with no binding yet (A2.8 item 1.3): the audit view, and what a direct hello lists. */
  async unboundSlots(limit = MAX_UNBOUND): Promise<OpRef[]> {
    const rows = (await this.store.list(T.unbound)).map((r) => ({ origin: r.origin as string, stream: r.stream as string, seq: r.seq as number }));
    return rows.sort((a, b) => (a.stream + a.origin).localeCompare(b.stream + b.origin) || a.seq - b.seq).slice(0, limit);
  }

  /** Chain conflicts this node recorded; `unreportedOnly` skips those already sent to the cloud (A2.8 item 1.4). */
  async chainConflicts(unreportedOnly = false): Promise<ChainConflict[]> {
    return ((await this.store.list(T.cc)) as CcRow[])
      .filter((c) => !unreportedOnly || !c.reported)
      .map((c) => ({ origin: c.origin, stream: c.stream, seq: c.seq, held: c.held, ...(c.seen !== undefined ? { seen: c.seen } : {}) }));
  }

  /** What every direct cloud `hello` carries besides the vectors: unbound slots and unreported chain conflicts. */
  async helloExtras(): Promise<{ unbound?: OpRef[]; chain_conflicts?: ChainConflict[]; pii_erased?: OpRef[] }> {
    const unbound = await this.unboundSlots();
    const conflicts = await this.chainConflicts(true);
    const erased = await this.pendingErasureAcks();
    return { ...(unbound.length ? { unbound } : {}), ...(conflicts.length ? { chain_conflicts: conflicts } : {}), ...(erased.length ? { pii_erased: erased } : {}) };
  }

  /** Erasures this node applied and has not yet told the cloud; sent in the next direct cloud hello (at most 500). */
  async pendingErasureAcks(limit = MAX_PII_ACKS): Promise<OpRef[]> {
    return ((await this.store.list(T.piiack)) as Array<Row & OpRef>)
      .map((r) => ({ origin: r.origin, stream: r.stream, seq: r.seq }))
      .sort((a, b) => (a.stream + a.origin).localeCompare(b.stream + b.origin) || a.seq - b.seq)
      .slice(0, limit);
  }

  /** Forgets acknowledgements a direct cloud hello carried, after it succeeded. */
  async clearErasureAcks(sent: OpRef[]): Promise<void> {
    if (sent.length === 0) return;
    await this.store.transact((tx) => {
      for (const r of sent) tx.del(T.piiack, opId(r));
    });
  }

  /**
   * Removes the personal data of one op from this node: the values and salts of its op row (the commitments in
   * the sealed body stay), the rows and field caches they were applied to, and later arrivals of its pii. Idempotent.
   */
  private erasePii(tx: StoreTx, ref: OpRef): void {
    const row = tx.get(T.op, opRowId(ref)) as OpRow | undefined;
    if (row?.pii !== undefined) {
      const values = stripSalts(row.pii);
      const { pii, ...rest } = row;
      void pii;
      tx.put(T.op, rest);
      if (values) {
        eraseRowFields(tx, ref, values); // rows, field candidates and conflict records that took the values
        this.erasedNow.push({ ref, values });
      }
    }
    tx.put(T.meta, { id: piiErasedId(ref), tenant_id: this.tenantId });
    if (!tx.get(T.piiack, opId(ref))) tx.put(T.piiack, { id: opId(ref), tenant_id: this.tenantId, ...ref });
  }

  /**
   * Takes the personal data a re-served op brings for fields this node holds a commitment for and no value (ADR-0014
   * A3.1 item 4). Only fields that verify against the commitment are kept; an erased op and a `kds` take nothing.
   */
  private async fillPii(tx: StoreTx, row: OpRow, it: WireItem): Promise<void> {
    if (!servesPii(this.deviceKind) || row.body === undefined || tx.get(T.meta, piiErasedId(opRefOf(row.id))) !== undefined) return;
    const op = rowOp(row);
    if (!op?.pii_c || missingPiiFields(op.pii_c, row.pii).length === 0) return;
    const opened = await openPii(it.pii, op.pii_c);
    if (!opened.verified) return;
    tx.put(T.op, { ...row, pii: mergePii(row.pii as PiiWire | undefined, opened.verified) });
    this.fillRows(tx, op, opened.values);
  }

  /** Puts newly arrived pii values into the rows whose winning write is this op's (ADR-0014 A3.1 item 4). */
  protected fillRows(tx: StoreTx, op: OpEnvelope, values: PiiValues | undefined): void {
    if (values) fillRowFields(tx, this.applyCtx(tx), op, values);
  }

  /**
   * Ops whose sealed body commits to a personal field this node holds no value for and that no erasure names:
   * `pii_incomplete`. The row applies and the field shows as pending; the next contact with any upstream fetches it
   * (the runner pulls with the vector just below the op). A `kds` expects no value and has none.
   */
  async piiIncomplete(): Promise<Array<OpRef & { fields: Array<{ e: string; id: string; f: string }> }>> {
    if (!servesPii(this.deviceKind)) return [];
    const out: Array<OpRef & { fields: Array<{ e: string; id: string; f: string }> }> = [];
    for (const row of (await this.store.list(T.op)) as OpRow[]) {
      if (row.state !== "applied" || row.body === undefined || !row.body.includes('"pii_c"')) continue;
      const op = rowOp(row);
      if (!op?.pii_c || (await this.store.get(T.meta, piiErasedId(op))) !== undefined) continue;
      const fields = missingPiiFields(op.pii_c, row.pii);
      if (fields.length) out.push({ origin: op.origin, stream: op.stream, seq: op.seq, fields });
    }
    return out;
  }

  /** Marks conflicts as sent: call with the ones a direct cloud hello carried, after it succeeded. */
  async markConflictsReported(sent: ChainConflict[]): Promise<void> {
    if (sent.length === 0) return;
    await this.store.transact((tx) => {
      for (const c of sent) {
        for (const src of ["cloud", "relay"] as const) {
          const row = tx.get(T.cc, ccId(c.origin, c.stream, src)) as CcRow | undefined;
          if (row && row.seq === c.seq && row.held === c.held) tx.put(T.cc, { ...row, reported: true });
        }
      }
    });
  }

  /**
   * Applies the cloud's answer to a hello that listed unbound slots: an equal hash clears the mark, a
   * different one is a chain conflict, reported at the next direct hello (A2.8 items 1.3 and 1.4).
   */
  async resolveUnbound(answers: SlotHash[]): Promise<void> {
    if (answers.length === 0) return;
    await this.store.transact((tx) => {
      for (const a of answers) {
        const row = tx.get(T.op, opRowId(a)) as OpRow | undefined;
        if (!row?.unbound) continue;
        if (row.h === a.h) this.clearUnbound(tx, row);
        else this.noteConflict(tx, { origin: a.origin, stream: a.stream, seq: a.seq, held: row.h, seen: a.h }, "relay");
      }
    });
    await this.refreshCounts();
    this.emit();
  }

  /**
   * True when a node whose upstream is a hub should now reach the cloud directly: 24 hours since its last direct
   * hello, an unbound slot or unreported conflict waiting, or a cloud seal it had to refuse under a dropped key.
   */
  async directCloudDue(): Promise<boolean> {
    const at = (await this.store.get(T.meta, "cloud_hello_at"))?.v as number | undefined;
    if (at === undefined || this.now() - at >= DIRECT_CLOUD_INTERVAL_MS) return true;
    if ((await this.store.get(T.meta, "stale_cloud_seal"))?.v) return true;
    if ((await this.store.list(T.unbound)).length > 0) return true;
    return ((await this.store.list(T.cc)) as CcRow[]).some((c) => !c.reported);
  }

  /** Stored cloud-origin seals under an op-signing key this node no longer accepts: what to ask the upstream to refresh. */
  async staleSeals(limit = MAX_STALE_SEALS): Promise<OpRef[]> {
    if (!this.verifier.acceptsCloudKid) return [];
    const out: OpRef[] = [];
    for (const row of await this.store.list(T.seal)) {
      for (const s of (row.seals as Seal[] | undefined) ?? []) {
        if (s.origin.startsWith("cloud-") && !this.verifier.acceptsCloudKid(s.kid) && out.length < limit) out.push({ origin: s.origin, stream: s.stream, seq: s.seq });
      }
    }
    return out;
  }

  /**
   * Replaces stored cloud-origin seals by the upstream's current ones after an op-signing key rotation. A
   * refreshed seal must verify under the key it names (never another held key) and name the hash already held.
   */
  async refreshSeals(seals: Seal[]): Promise<number> {
    let n = 0;
    for (const s of seals) {
      if (!s.origin.startsWith("cloud-") || !(await verifySeal(this.verifier, s))) continue;
      const id = `${s.stream}|${s.origin}`;
      const cur = (await this.store.get(T.seal, id))?.seals as Seal[] | undefined;
      const old = cur?.find((c) => c.seq === s.seq);
      if (!cur || !old || old.h !== s.h) continue;
      await this.store.transact((tx) => {
        const list = ((tx.get(T.seal, id)?.seals as Seal[] | undefined) ?? []).map((c) => (c.seq === s.seq ? s : c));
        tx.put(T.seal, { id, tenant_id: this.tenantId, seals: list });
      });
      n++;
    }
    return n;
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
  private async endorsedTail(it: WireItem, proofs: RemoteProofs, chain: Array<{ it: WireItem }>, cur: number): Promise<boolean> {
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
    // Personal data is kept only if it matches the commitments of the sealed body; an erased op keeps none.
    const erased = tx.get(T.meta, piiErasedId(ref)) !== undefined;
    const opened = erased || it.pii === undefined || !servesPii(this.deviceKind) ? undefined : await openPii(it.pii, op.pii_c);
    const row: OpRow = {
      id: opRowId(ref),
      tenant_id: this.tenantId,
      body: it.body,
      ...(opened?.verified ? { pii: opened.verified } : {}),
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
    } else if (op.intent === PII_ERASE_INTENT && op.origin.startsWith("cloud-")) {
      // A cloud-signed erasure: values and salts go from the named op, its commitments stay (piic.go).
      for (const m of op.muts) {
        if (m.e !== PII_ERASE_RECORD || m.k !== "insert") continue;
        const t = m.f as { origin?: string; stream?: string; seq?: number } | undefined;
        if (t?.origin && t.stream && typeof t.seq === "number" && t.seq >= 1) this.erasePii(tx, { origin: t.origin, stream: t.stream, seq: t.seq });
      }
    } else if (tx.get(T.void, opId(ref))) {
      row.state = "void_skipped"; // voided before it arrived: slot advances, mutations are skipped
    } else if (fresh && touchesLww(ctx, op) && (op.clk === "manual" || unpackHlc(op.hlc).ms > this.correctedNow() + MAX_FUTURE_MS)) {
      row.state = "clock_quarantined"; // LWW op with an untrusted stamp: manager review, not applied (S5)
      tx.put(T.clockq, { id: opId(ref), tenant_id: this.tenantId, origin: op.origin, stream: op.stream, seq: op.seq });
    } else {
      applyMutations(tx, ctx, withPii(withCommits(op), opened?.values));
    }
    if (fresh && op.v === 1) this.clock.observe(op.hlc);
    tx.put(T.op, row);
  }

  private async refreshCounts(): Promise<void> {
    const erased = this.erasedNow;
    this.erasedNow = [];
    for (const e of erased) this.onPiiErased?.(e);
    this.conflictCount = (await this.conflicts()).length;
    this.chainConflictCount = (await this.store.list(T.cc)).length;
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
      if (!tx.get(T.void, opId(ref))) applyMutations(tx, ctx, withPii(withCommits(op), stripSalts(row.pii)));
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
    return this.hashRows((name) => this.store.list(name));
  }

  /**
   * The convergence hash (api-specs "Projection digest", ADR-0014 A3.2): per entity the SHA-256 over the row texts, a
   * row text being its non-pii fields plus one `~c:<field>` commitment per pii field it holds one for, never a
   * value or a salt. So it is equal on a till, a kds, the hub and the cloud, and unchanged by an erasure.
   */
  private async hashRows(list: (entity: string) => Promise<Row[]>): Promise<string> {
    const entities: Array<{ name: string; rowCount: number; hash: string }> = [];
    for (const name of this.schemas.names()) {
      const pii = this.schemas.get(name)?.pii ?? [];
      const rows = (await list(name)).filter((r) => r.deleted !== true).map((r) => ({ id: String(r.id), text: digestRowText(r, pii) }));
      if (rows.length) entities.push({ name, ...(await entityDigest(rows)) });
    }
    return stateDigest(entities);
  }

  /**
   * State hash of what the cloud accepted: the same rows as `stateHash`, rebuilt from the op log without this
   * device's own ops the cloud holds (`pending`, `held_manager`, `held_support`). The origin applies such an op
   * locally at once while every peer holds only its placeholder until a release (ADR-0002 A1.2, RB3), so
   * `stateHash` differs between the origin and its peers by design; this one is what convergence is judged on
   * (Phase 2 soak T1). Costs a replay of the log: for checks and diagnostics, not the hot path.
   */
  async acceptedStateHash(): Promise<string> {
    const heldOwn = new Set(this.held.map((h) => `${h.stream}|${this.deviceId}|${h.seq}`));
    const rows = (await this.store.list(T.op)) as OpRow[];
    const ops: OpEnvelope[] = [];
    for (const r of rows) {
      if (r.state !== "applied" || r.body === undefined) continue;
      const op = rowOp(r);
      if (!op) continue;
      if (op.origin === this.deviceId && heldOwn.has(opId(op))) continue;
      ops.push(op);
    }
    ops.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.seq - b.seq));
    const scratch = new InMemoryStore(this.tenantId);
    const voids = await this.store.list(T.void);
    await scratch.transact((tx) => {
      for (const v of voids) tx.put(T.void, v);
      const ctx: ApplyCtx = { tenantId: this.tenantId, schemas: this.schemas, confirmed: () => true };
      for (const op of ops) if (!tx.get(T.void, opId(op))) applyMutations(tx, ctx, withCommits(op));
    });
    return this.hashRows((name) => scratch.list(name));
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
