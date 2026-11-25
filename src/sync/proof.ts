import { canonicalize } from "./canonical";
import { sha256Hex } from "./crypto";
import type { Mutation } from "./types";

/**
 * Proof messages and the action hash (api-specs sync/protocol-v1.md "Proof messages"; vectors `approval_proof`,
 * `action_hash`; ADR-0005 sections 7 and 8, A3.1; ADR-0014 A3.3). The HMAC itself is made by the auth layer
 * with the PIN-derived proof key; this file builds the exact bytes it signs and the hash the approval binds.
 */

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const hex = (n: number, w: number): string => n.toString(16).padStart(w, "0");

/**
 * Go `strconv.Quote`: double quotes; `\"` `\\` `\a \b \f \n \r \t \v`; other control characters as `\xNN`;
 * non-printable code points as `\uNNNN` or `\UNNNNNNNN`; printable Unicode, `|` and `/` unescaped. A lone
 * surrogate is U+FFFD, as Go sees it after UTF-8 encoding.
 */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    switch (cp) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 7:
        out += "\\a";
        continue;
      case 8:
        out += "\\b";
        continue;
      case 12:
        out += "\\f";
        continue;
      case 10:
        out += "\\n";
        continue;
      case 13:
        out += "\\r";
        continue;
      case 9:
        out += "\\t";
        continue;
      case 11:
        out += "\\v";
        continue;
    }
    const c = String.fromCodePoint(cp);
    if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`;
    else if (cp === 0x20 || PRINTABLE.test(c)) out += c;
    else if (cp < 0x10000) out += `\\u${hex(cp, 4)}`;
    else out += `\\U${hex(cp, 8)}`;
  }
  return out + '"';
}

/** UTC time with exactly three millisecond digits, as the proof messages carry it. */
export function proofTime(at: string | number | Date): string {
  return new Date(at).toISOString();
}

export type SessionProofFields = { sessionId: string; deviceId: string; memberId: string; packV: number; pinV: number; openedAt: string };

/** `session|<sid>|<device id>|<member id>|<pack_v>|<pin_v>|<opened at>` */
export function sessionProofMessage(f: SessionProofFields): string {
  return ["session", f.sessionId, f.deviceId, f.memberId, f.packV, f.pinV, proofTime(f.openedAt)].join("|");
}

/** What the action hash binds (api-specs "Action hash"). `target` and `reason` are empty strings when there is none. */
export type ActionHashFields = {
  /** The intent of the citing op, e.g. `bill.discount.apply`. */
  intent: string;
  permission: string;
  /** The citing op's actor. */
  requester: string;
  /** `<entity>:<row id>` of the row the citing op inserts or sets. */
  target: string;
  approvalId: string;
  reason: string;
  /** The overridden fields and new values the citing op records: one member per name of the intent's `proof.binds`. */
  values: Record<string, unknown>;
};

/** `sha256:` plus the lower-case hex SHA-256 of the JCS of {intent, permission, requester, target, approval_id, reason, values}. */
export async function actionHash(f: ActionHashFields): Promise<string> {
  const jcs = canonicalize({
    intent: f.intent,
    permission: f.permission,
    requester: f.requester,
    target: f.target,
    approval_id: f.approvalId,
    reason: f.reason,
    values: f.values,
  });
  return `sha256:${await sha256Hex(jcs)}`;
}

/**
 * The `values` of an action hash: for each name in the intent's `proof.binds`, the value from the first mutation of
 * the op that sets a field of that name. `missing` lists bound names the op does not set (the gateway judges those
 * `mismatch`, so a caller must not record such an op under an approval).
 */
export function actionValues(binds: readonly string[], muts: readonly Mutation[]): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const name of binds) {
    const m = muts.find((x) => x.f !== undefined && x.f[name] !== undefined);
    if (m) values[name] = m.f![name];
    else missing.push(name);
  }
  return { values, missing };
}

export type ApprovalProofFields = {
  actionHash: string;
  deviceId: string;
  /** The approver. */
  memberId: string;
  packV: number;
  pinV: number;
  approvalId: string;
  permission: string;
  target: string;
  requesterId: string;
  /** The op's `at`. */
  approvedAt: string;
  reason: string;
};

/** `approval|<action hash>|<device id>|<approver>|<pack_v>|<pin_v>|<approval id>|<permission>|<quoted target>|<requester>|<approved at>|<quoted reason>` */
export function approvalProofMessage(f: ApprovalProofFields): string {
  return [
    "approval",
    f.actionHash,
    f.deviceId,
    f.memberId,
    f.packV,
    f.pinV,
    f.approvalId,
    f.permission,
    goQuote(f.target),
    f.requesterId,
    proofTime(f.approvedAt),
    goQuote(f.reason),
  ].join("|");
}
