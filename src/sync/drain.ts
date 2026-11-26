import { canonicalize } from "./canonical";
import { sha256Hex } from "./crypto";

/** Domain tag of the drain statement signature (ADR-0005 A3.3). */
export const DRAIN_TAG = "hostry-drain-v1";

/**
 * The device-signed list of everything a revoked device holds and its last document numbers (ADR-0005 A3.3):
 * `streams` every stream in which its log holds an own-origin op, with the head; `series` every series in its
 * pack in the fields of a `series_close` record, 0 when never used. Ordinary drain: `by` = `origin`, signed
 * with the revoked device's key. Key loss: `by` = the adopting device and `rec` = the recovery id.
 */
export type DrainStatement = {
  origin: string;
  streams: Array<{ stream: string; seq: number; h: string }>;
  series: Array<{ series_id: string; code: string; fy: string; last_number: number }>;
  by: string;
  rec?: string;
  kid: string;
  /** RFC 3339 UTC, whole seconds. */
  at: string;
  sig: string;
};

export type UnsignedDrainStatement = Omit<DrainStatement, "sig">;

/** Text the signature covers: the tag, a newline and the canonical JSON (RFC 8785) of the statement without `sig`. */
export function drainSigningMessage(s: UnsignedDrainStatement): string {
  return `${DRAIN_TAG}\n${canonicalize(s)}`;
}

/** SHA-256 (hex) of the canonical JSON of the statement including `sig`: what the wipe order quotes (A3.3 item 6). */
export function drainStatementHash(s: DrainStatement): Promise<string> {
  return sha256Hex(canonicalize(s));
}
