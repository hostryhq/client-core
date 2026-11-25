import { sha256Hex, type RecordSpec } from "../sync";

/**
 * Intent builders for the two identity control intents that carry a protocol record (api-specs `sync/intents/control.yaml`,
 * `records`). The gateway types a session from the `session` record of `session.open` and verifies an approval from the
 * `approval` record of `approval.grant`; an op without its record leaves every PIN actor unverified (soak finding F15).
 */

export type SessionType = "pin" | "strong" | "device";

/**
 * session.open. A `pin` session carries the session proof and the actor's `pin_v`, and `at` is the opening time the proof
 * binds (ADR-0005 A3.1). A `device` session (a KDS: no member, no PIN, no proof) names `actor` = `device:<origin>`.
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

export type ApprovalFields = { approvalId: string; permission: string; requesterId: string; target: string };

/**
 * The action hash an approval binds: SHA-256 (lower-case hex) of the permission, requester, target and approval id, one
 * per line. The gateway passes it to identity inside the proof and does not recompute it from the citing op, so the
 * approver's device and the verifier only need to agree on the text; the fields are the ones known when the approver
 * enters the PIN. x-provisional: ADR-0005 section 8 says "the fields the intent registry names"; confirm with security-reviewer.
 */
export const approvalActionHash = (a: ApprovalFields): Promise<string> => sha256Hex([a.permission, a.requesterId, a.target, a.approvalId].join("\n"));

/**
 * approval.grant: a manager's override at the counter, recorded under the approver's name in the session of the
 * requester's device. The record holds what the approval proof binds (approver, permission, requester, action hash,
 * target, reason); the op carries the proof and the approver's `pin_v`.
 */
export function approvalGrantSpec(a: ApprovalFields & { approverId: string; reason: string; actionHash: string; sid: string; proof: string; pinV: number }): RecordSpec {
  if (!Number.isInteger(a.pinV) || a.pinV < 1) throw new RangeError("an approval needs pinV, an integer >= 1");
  return {
    intent: "approval.grant",
    actor: a.approverId,
    sid: a.sid,
    approval: a.approvalId,
    proof: a.proof,
    pinV: a.pinV,
    build: () => [
      {
        e: "approval",
        id: a.approvalId,
        k: "insert",
        f: { approver: a.approverId, permission: a.permission, requester: a.requesterId, action_hash: a.actionHash, target: a.target, reason: a.reason },
      },
    ],
  };
}
