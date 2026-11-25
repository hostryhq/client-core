import { actionHash, actionValues, type ActionHashFields, type Mutation, type RecordSpec } from "../sync";
import { intentDef } from "./intents";

/**
 * Intent builders for the identity control intents that carry a protocol record (api-specs `sync/intents/control.yaml`,
 * `records`). The gateway types a session from the `session` record of `session.open` and verifies an approval from the
 * `approval` record of `approval.grant` or `approval.self_confirm`; an op without its record leaves every PIN actor
 * unverified (soak finding F15).
 */

export type SessionType = "pin" | "strong" | "device";

/**
 * session.open. A `pin` session carries the session proof and the actor's `pin_v`, and `at` is the opening time the proof
 * binds (ADR-0005 A3.1). A `device` session (a KDS: no member, no PIN, no proof) names `actor` = `device:<origin>`.
 * A KDS opens a new one at the start of each business day, at most 26 hours apart (`deviceSessionDue`).
 */
export function sessionOpenSpec(a: { sid: string; actor: string; type: SessionType; proof?: string; pinV?: number; at?: string }): RecordSpec {
  const hasProof = a.proof !== undefined;
  if (a.type === "pin" && !hasProof) throw new RangeError("a pin session needs the session proof");
  if (a.type !== "pin" && hasProof) throw new RangeError("only a pin session carries a proof");
  if (hasProof && !(Number.isInteger(a.pinV) && (a.pinV as number) >= 1)) throw new RangeError("a proof needs pinV, an integer >= 1");
  return {
    intent: "session.open",
    actor: a.actor,
    sid: a.sid,
    ...(hasProof ? { proof: a.proof as string, pinV: a.pinV as number } : {}),
    ...(a.at ? { at: a.at } : {}),
    build: () => [{ e: "session", id: a.sid, k: "insert", f: { type: a.type } }],
  };
}

/** Longest life of a `device` session (api-specs protocol "Device-session lifetime", `x-provisional`). */
export const DEVICE_SESSION_MAX_MS = 26 * 60 * 60 * 1000;

/**
 * Whether a KDS must open a new device session before its next op: on the first op after it sees a new open business
 * day, or, whatever the business day, once the session is 26 hours old. The shell re-opens it without a person.
 */
export function deviceSessionDue(s: { openedAtMs: number; businessDate?: string }, now: { ms: number; businessDate?: string }): boolean {
  if (now.ms - s.openedAtMs >= DEVICE_SESSION_MAX_MS) return true;
  return now.businessDate !== undefined && s.businessDate !== undefined && now.businessDate !== s.businessDate;
}

/**
 * The values a citing op records for the intent's `proof.binds`: the fields those mutations set (api-specs "Action
 * hash"). `missing` lists bound names no mutation sets; the gateway reads a missing name as `mismatch`.
 */
export const boundValues = (intent: string, muts: readonly Mutation[]): { values: Record<string, unknown>; missing: string[] } => actionValues(intentDef(intent).binds, muts);

/**
 * The action hash an approval binds: `sha256:` plus the hex SHA-256 of the JCS of
 * {intent, permission, requester, target, approval_id, reason, values} (api-specs sync/protocol-v1.md). `intent`,
 * `target` and `values` are those of the citing op, which the approver's device knows before the op is recorded; the
 * op must record exactly them or the gateway answers `mismatch` (ADR-0014 test OV2).
 */
export const approvalActionHash = (a: ActionHashFields): Promise<string> => actionHash(a);

export type ApprovalFields = { approvalId: string; permission: string; requesterId: string; target: string };

/**
 * approval.grant: a manager's override at the counter, recorded under the approver's name in the session of the
 * requester's device. The record holds what the approval proof binds: permission, intent, target, action hash, requester and
 * reason; the approver is the op's actor and the approval time its `at` (take `at` from `engine.stampTime()` before the
 * proof is made and pass it here). With `self: true` the intent is `approval.self_confirm`: a member re-entering their own
 * PIN for an action they may do themselves, requester = approver (it never satisfies a two-person rule).
 */
export function approvalGrantSpec(
  a: ApprovalFields & { approverId: string; intent: string; reason: string; actionHash: string; sid: string; proof: string; pinV: number; at: string; self?: boolean },
): RecordSpec {
  if (!Number.isInteger(a.pinV) || a.pinV < 1) throw new RangeError("an approval needs pinV, an integer >= 1");
  if (a.self === true && a.requesterId !== a.approverId) throw new RangeError("a self confirmation has requester = approver");
  if (a.self !== true && a.requesterId === a.approverId) throw new RangeError("an approval needs an approver other than the requester; use self");
  return {
    intent: a.self === true ? "approval.self_confirm" : "approval.grant",
    actor: a.approverId,
    sid: a.sid,
    approval: a.approvalId,
    proof: a.proof,
    pinV: a.pinV,
    at: a.at,
    build: () => [
      {
        e: "approval",
        id: a.approvalId,
        k: "insert",
        f: { permission: a.permission, intent: a.intent, requester: a.requesterId, action_hash: a.actionHash, target: a.target, ...(a.reason ? { reason: a.reason } : {}) },
      },
    ],
  };
}
