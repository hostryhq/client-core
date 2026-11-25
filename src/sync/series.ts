import type { StoreTx } from "../store";
import { T } from "./apply";
import type { DocType } from "./schema";

/**
 * Legal document numbers (ADR-0002 S7). One gapless series per billing device per document type;
 * the number is `<code>/<FY>/<running>` with a 3-character code unique per tax registration, the FY as
 * four digits (2627 = 2026-27) and a six-digit running number: 15 characters, under the 16 GST allows.
 *
 * Codes are issued online by the tenancy registry and arrive in the signed offline pack as grants;
 * this module never invents one. The number is allocated inside the same local transaction as the op,
 * so a crash can neither burn nor duplicate a number.
 */
export type SeriesState = "active" | "dormant" | "closed";

export type SeriesGrant = {
  code: string;
  docType: DocType;
  state: SeriesState;
  /** Tenancy's series id, from the offline pack: named by the drain statement (ADR-0005 A3.3). */
  seriesId?: string;
};

/**
 * Code shape. S7 says the registry issues codes from an alphabet without I, O, 0, 1, but its own example
 * (`A07`) contains a 0, so the client checks only the shape (3 capitals or digits); the registry is the authority.
 */
const CODE_RE = /^[A-Z0-9]{3}$/;
export const MAX_RUNNING = 999_999;

export class SeriesError extends Error {
  constructor(
    readonly reason: "no_active_series" | "exhausted" | "bad_code",
    message: string,
  ) {
    super(message);
  }
}

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Financial year (April to March) of an instant, by the IST calendar date; "2627" for 2026-27. */
export function financialYear(utcMs: number): string {
  const d = new Date(utcMs + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  const two = (n: number) => String(n % 100).padStart(2, "0");
  return two(start) + two(start + 1);
}

export function formatNumber(code: string, fy: string, running: number): string {
  if (!CODE_RE.test(code)) throw new SeriesError("bad_code", `series code ${code} is not valid`);
  if (running < 1 || running > MAX_RUNNING) throw new SeriesError("exhausted", "series running number out of range");
  return `${code}/${fy}/${String(running).padStart(6, "0")}`;
}

export function putGrants(tx: StoreTx, tenantId: string, grants: SeriesGrant[]): void {
  for (const g of grants) {
    if (!CODE_RE.test(g.code)) throw new SeriesError("bad_code", `series code ${g.code} is not valid`);
    tx.put(T.grant, { id: `${g.code}|${g.docType}`, tenant_id: tenantId, ...g });
  }
}

/** Allocates the next number of the first active series of `docType`. Call only inside the op's transaction. */
export function allocateNumber(tx: StoreTx, tenantId: string, docType: DocType, utcMs: number): string {
  const grant = (tx.list(T.grant) as unknown as Array<SeriesGrant & { id: string }>)
    .filter((g) => g.docType === docType && g.state === "active")
    .sort((a, b) => (a.code < b.code ? -1 : 1))[0];
  if (!grant) throw new SeriesError("no_active_series", `no active ${docType} series on this device`);
  const fy = financialYear(utcMs);
  const id = `${grant.code}|${docType}|${fy}`;
  const next = ((tx.get(T.series, id)?.next as number | undefined) ?? 0) + 1;
  const number = formatNumber(grant.code, fy, next); // throws before the counter moves when exhausted
  tx.put(T.series, { id, tenant_id: tenantId, next });
  return number;
}
