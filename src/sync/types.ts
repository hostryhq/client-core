/**
 * Sync Protocol v1 types per ADR-0002 S4 (op envelope). Types and interface stubs only:
 * the engine (HLC, hash chain, seals, apply, transport) is built later and must stay in step
 * with go-common/sync through the shared conformance vectors. Schemas become contracts in
 * api-specs/sync/; replace these hand-written types with generated ones when that lands.
 */

import type { PiiCommit } from "./pii-commit";

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
  /** Opaque PIN-derived session or action proof (ADR-0005 s7-8); only the cloud checks it. */
  proof?: string;
  intent: string;
  intent_v: number;
  /** RFC 3339 UTC. */
  at: string;
  /** The legal document number this op allocates (S7), if any. The series code is the part before the first slash. */
  doc?: { type: string; number: string };
  /**
   * Every legal number the op allocates, in allocation order, when there is more than one (bill.rebill: the credit
   * note, then the replacement bills). `doc` is then `docs[0]`. Absent for zero or one number, so existing ops and
   * vectors are byte-identical. Additive; svc-sync and go-common must read it before a gateway accepts a re-bill
   * (ADR needed: op envelope with several document numbers).
   */
  docs?: Array<{ type: string; number: string }>;
  muts: Mutation[];
  /** Salted per-field commitments of the op's personal data (pii-commit.ts); the values travel beside the op. */
  pii_c?: PiiCommit;
};

/**
 * An op or a placeholder on the wire (svc-sync `syncproto.Item`). `body` is the canonical JSON text of the
 * op without `pii`; every relay forwards those exact bytes and `h` is SHA-256 of them. No `body` means
 * placeholder: the slot advances the vector but its content is not delivered. `pii` is outside the hash.
 */
export type WireItem = {
  origin: string;
  stream: string;
  seq: number;
  h: string;
  body?: string;
  pii?: unknown;
};

/** Highest contiguous seq held, per `origin` (per stream). Resume is by version vector. */
export type VersionVector = Record<string, number>;

/** Where one of this device's own ops is (ADR-0002 S12 item 6). "Sent to kitchen" needs `at_hub` or `in_cloud`. */
export type DeliveryState = "local" | "at_hub" | "in_cloud";

/**
 * The only things a device is told about a held op of its own (ADR-0002 A1.2, provisional). Never a flag
 * or a proof verdict: a flagged op is "simply accepted" to its origin. A voided op arrives as `sync.void`.
 */
export type HeldCode = "pending" | "held_manager" | "held_support";
export type HeldItem = { stream: string; seq: number; code: HeldCode };

/** Sync indicator states; match `sync.*` in docs/design/tokens.json (icon + label, never colour alone). */
export type SyncState = "synced" | "pending" | "offline" | "conflict";

/** What every screen that matters shows (offline-first-sync invariant 9). */
export type SyncStatus = {
  /** Some upstream (hub or cloud) answered on the last round. */
  online: boolean;
  /** Own ops written locally and not yet at any upstream (`local`). */
  pendingOps: number;
  /** Own ops at the hub but not yet confirmed by the cloud. */
  atHubOps: number;
  /** Own ops held for a manager or support, or refused (voided), plus open conflicts; never dropped silently. */
  attentionOps: number;
  /** Own configuration ops the cloud is still checking (`pending`). */
  checkingOps: number;
  /** Which upstream is in use. */
  upstream: "hub" | "cloud" | "none";
  /** Single state for the indicator: conflict > offline > pending > synced. */
  state: SyncState;
  /** Device clock differs from upstream time by more than 2 minutes: show the "clock wrong" banner. */
  clockWrong: boolean;
  /** The device key is unusable; nothing is recorded until recovery (ADR-0002 A1.3). */
  keyLost: boolean;
  lastSyncAt?: string;
};

/** A seal: the origin's signature over the hash of its op at `seq` (ADR-0002 S17). */
export type Seal = { origin: string; stream: string; seq: number; h: string; kid: string; sig: string };

/** Identity of an op. */
export type OpRef = { origin: string; stream: string; seq: number };

/** Fixes the tail of a key-lost origin; signed by the adopting device's new key (ADR-0002 A1.3 item 4). */
export type Attestation = { origin: string; stream: string; seq: number; h: string; by: string; rec: string; kid: string; sig: string };

/**
 * Gateway endorsement of one op of the released unsealed tail of a key-lost origin (ADR-0002 A2.1). Not a
 * seal: own domain tag, own list. Valid only together with the identity-signed `recovers` credential and
 * the adopting device's attestation.
 */
export type Endorsement = { origin: string; stream: string; seq: number; h: string; rec: string; kid: string; sig: string };

/** A slot with a hash: what the cloud states for a slot a node listed as `unbound` (A2.8 item 1.3). */
export type SlotHash = { origin: string; stream: string; seq: number; h: string };

/**
 * A recorded chain conflict (A2.8 item 1.4): the hash this node holds at the slot and the one an upstream
 * (or the cloud's answer) contradicted it with. `src` is the kind of upstream that contradicted it.
 */
export type ChainConflict = { origin: string; stream: string; seq: number; held: string; seen?: string };

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
