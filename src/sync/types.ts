/**
 * Sync Protocol v1 types per ADR-0002 S4 (op envelope). Types and interface stubs only:
 * the engine (HLC, hash chain, seals, apply, transport) is built later and must stay in step
 * with go-common/sync through the shared conformance vectors. Schemas become contracts in
 * api-specs/sync/; replace these hand-written types with generated ones when that lands.
 */

/** 16-char lowercase hex: 48-bit Unix ms plus 16-bit counter. Sorts as text. */
export type Hlc = string;

/** `sync` normally; `manual` when a manager confirmed the device clock (ADR-0005 s6). */
export type ClockMode = "sync" | "manual";

export type MutationKind = "insert" | "set" | "delta" | "rank" | "del" | "undel";

export type Mutation = {
  /** Entity name. */
  e: string;
  /** Entity id (client-generated, time-sortable). */
  id: string;
  k: MutationKind;
  /** Fields. Money in integer paise, quantities in integer milli-units. */
  f?: Record<string, unknown>;
  /** For `set`: the HLC stamp of each field group the writer saw (conflict detection). */
  prev?: Record<string, Hlc>;
};

export type OpEnvelope = {
  v: 1;
  /** Node id: the device id from identity. */
  origin: string;
  /** `outlet:<outlet_id>` */
  stream: string;
  /** Gapless per origin per stream. Identity of an op is (origin, stream, seq). */
  seq: number;
  /** SHA-256 of this origin's previous op in this stream (hex). */
  ph: string;
  hlc: Hlc;
  clk: ClockMode;
  tenant_id: string;
  /** Member id. */
  actor: string;
  /** Id of the session.open op this op belongs to. */
  sid: string;
  /** Offline pack version the device held. */
  pack_v: string;
  /** Approval id, when the action needed one. */
  approval?: string;
  intent: string;
  intent_v: number;
  /** RFC 3339 UTC. */
  at: string;
  muts: Mutation[];
  /** Personal data; outside the op hash. */
  pii?: Record<string, unknown>;
};

/** Highest contiguous seq held, per `origin` (per stream). Resume is by version vector. */
export type VersionVector = Record<string, number>;

/** Verdicts the gateway can return for a pushed op (ADR-0002 S11); nothing is silently dropped. */
export type OpState = "accepted" | "accepted_flagged" | "quarantined" | "voided";

/** What every screen that matters shows (offline-first-sync invariant 9). */
export type SyncStatus = {
  online: boolean;
  /** Ops written locally and not yet acknowledged upstream. */
  pendingOps: number;
  /** Ops needing attention (quarantined or voided); never dropped silently. */
  attentionOps: number;
  lastSyncAt?: string;
};

export type Unsubscribe = () => void;

/** Stub for the background sync client. UI never awaits it; writes go to the local store first. */
export interface SyncClient {
  start(): void;
  stop(): void;
  status(): SyncStatus;
  onStatus(listener: (status: SyncStatus) => void): Unsubscribe;
  /** Request a sync round now (e.g. on reconnect). Resolves when the round ends; never required for UI. */
  syncNow(): Promise<void>;
}
