import type { DocKind } from "../tax";

/**
 * Legal document numbers are allocated on the device from a gapless series, in the same local transaction as the
 * op (ADR-0002 S7). This module only names the interface the documents code needs; the implementation is the sync
 * engine's series allocator (client-core sync/series.ts `allocateNumber(tx, tenantId, docType, utcMs)`), wired with
 * `allocatorFromFn`. The documents code never invents or reuses a number, and never allocates outside the caller's
 * transaction: the caller calls `finalize*` inside the store transaction that writes the op.
 */

export type NumberedDocType = DocKind | "credit_note";

export type AllocatedNumber = {
  /** `<code>/<FY>/<running>`, at most 16 characters. */
  number: string;
  seriesCode: string;
  /** Four digits, "2627". */
  financialYear: string;
  running: number;
};

export interface DocumentNumberAllocator {
  /** Takes the next number of the first active series of `docType`. Throws when none is active or exhausted. */
  allocate(docType: NumberedDocType, atMs: number): AllocatedNumber;
}

const NUMBER_RE = /^([A-Z0-9]{3})\/(\d{4})\/(\d{1,6})$/;

export class DocumentNumberError extends Error {
  constructor(
    readonly reason: "bad_number" | "wrong_financial_year",
    message: string,
  ) {
    super(message);
    this.name = "DocumentNumberError";
  }
}

export function parseDocumentNumber(number: string): AllocatedNumber {
  const m = NUMBER_RE.exec(number);
  if (!m) throw new DocumentNumberError("bad_number", `${number} is not <code>/<FY>/<running>`);
  return { number, seriesCode: m[1]!, financialYear: m[2]!, running: Number(m[3]) };
}

/** Adapts the sync engine's `allocateNumber` (bound to the open transaction) to the allocator interface. */
export function allocatorFromFn(fn: (docType: NumberedDocType, atMs: number) => string): DocumentNumberAllocator {
  return { allocate: (docType, atMs) => parseDocumentNumber(fn(docType, atMs)) };
}
