import type { DeliveryState, DocType, RecordSpec, SyncClient, SyncStatus } from "../sync";

/**
 * The seams app-restaurant codes to (its `src/data/ports.ts`), under the same names, so an app passes the sync engine
 * wrapped in `EngineOpWriter` as its `OpWriter` and a `SyncPort` from `createSyncPort`, with no screen changing.
 * `BuildCtx` and `RecordSpec` are the sync engine's own types (same shape as the app's copies). Where the app's type
 * is narrower the client-core type is a structural superset.
 */

/** Document types that take a number from a device series. */
export type SeriesDocType = DocType;

/** What `record` returns. The sync engine's `OpEnvelope` is a superset. */
export type RecordedOp = {
  seq: number;
  intent: string;
  /** RFC 3339 UTC. */
  at: string;
  /** First legal number of the op. */
  doc?: { type: string; number: string };
  /** All legal numbers of the op, when there are several (re-bill). */
  docs?: Array<{ type: string; number: string }>;
};

/** The one way the UI changes data: an intent with mutations, written locally first. Implemented by `EngineOpWriter`. */
export interface OpWriter {
  record(spec: RecordSpec): Promise<RecordedOp>;
}

export type Delivery = DeliveryState;

/** What every screen shows. The engine's `SyncStatus` already carries every field the app reads. */
export type SyncView = SyncStatus;

/** The background sync surface of an app. */
export interface SyncPort extends Omit<SyncClient, "status" | "onStatus"> {
  status(): SyncView;
  onStatus(listener: (s: SyncView) => void): () => void;
  /** Where one of this device's own ops is: local, at the hub, or confirmed by the cloud. */
  delivery(seq: number): Delivery;
}
