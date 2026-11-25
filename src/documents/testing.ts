import { financialYearOfDate, istDateOf } from "./business-day";
import { type AllocatedNumber, type DocumentNumberAllocator, type NumberedDocType } from "./numbering";

/**
 * In-memory gapless series for tests and browser fakes: one counter per (code, FY). It stands in for the sync
 * engine's series allocator, which takes the number inside the op's store transaction.
 */
export class MemorySeriesAllocator implements DocumentNumberAllocator {
  private readonly counters = new Map<string, number>();
  readonly issued: string[] = [];

  constructor(private readonly codes: Partial<Record<NumberedDocType, string>> = { tax_invoice: "A07", bill_of_supply: "A07", plain_bill: "A07", credit_note: "C07" }) {}

  allocate(docType: NumberedDocType, atMs: number): AllocatedNumber {
    const seriesCode = this.codes[docType];
    if (!seriesCode) throw new Error(`no active ${docType} series on this device`);
    const financialYear = financialYearOfDate(istDateOf(atMs));
    const key = `${seriesCode}|${docType}|${financialYear}`;
    const running = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, running);
    const number = `${seriesCode}/${financialYear}/${String(running).padStart(6, "0")}`;
    this.issued.push(number);
    return { number, seriesCode, financialYear, running };
  }
}

/** Deterministic ids for tests: "id-1", "id-2", ... (valid wherever the domain only needs uniqueness). */
export function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
