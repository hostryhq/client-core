import type { LocalStore } from "../store";

/**
 * Detectors for `guarded` data (anything involving money or tax). They are derived queries over the
 * applied facts, never ops: a violation shows on every node holding the same facts, and a manager
 * resolves it with a compensating op (refund, adjustment, credit note). Nothing is merged or discarded.
 */
export type Violation = {
  kind: "overpayment" | "duplicate_finalisation";
  /** bill id for an overpayment, order id for a duplicate finalisation. */
  key: string;
  detail: string;
};

export async function detect(store: LocalStore): Promise<Violation[]> {
  const out: Violation[] = [];
  const bills = await store.list("bill");
  const payments = await store.list("payment");

  const paid = new Map<string, number>();
  for (const p of payments) {
    const bill = p.bill_id as string | undefined;
    const amount = p.amount_paise as number | undefined;
    if (bill && typeof amount === "number") paid.set(bill, (paid.get(bill) ?? 0) + amount); // refunds are negative payments
  }
  for (const b of bills) {
    const total = b.total_paise as number | undefined;
    const sum = paid.get(b.id) ?? 0;
    if (typeof total === "number" && sum > total) {
      out.push({ kind: "overpayment", key: b.id, detail: `paid ${sum} paise against a bill of ${total} paise` });
    }
  }

  const byOrder = new Map<string, string[]>();
  for (const b of bills) {
    const order = b.order_id as string | undefined;
    if (order) byOrder.set(order, [...(byOrder.get(order) ?? []), b.id]);
  }
  for (const [order, ids] of byOrder) {
    if (ids.length > 1) {
      out.push({ kind: "duplicate_finalisation", key: order, detail: `${ids.length} finalised bills: ${ids.sort().join(", ")}` });
    }
  }
  return out.sort((a, b) => (a.kind + a.key < b.kind + b.key ? -1 : 1));
}

export type SeriesGap = { series: string; docType: string; financialYear: string; missing: number[]; duplicates: string[] };

/**
 * Gap check over the document series register (ADR-0002 S7; api-specs bill detector "gap in the series register"):
 * per (series code, document type, financial year) the running numbers of the bills and credit notes held must run
 * 1..n with no gap and no number twice. A gap in what one node holds can also be ops not yet delivered, so run it
 * after convergence; a gap that stays is a quarantined or lost number for a manager to explain.
 */
export async function seriesGaps(store: LocalStore): Promise<SeriesGap[]> {
  const groups = new Map<string, { docType: string; series: string; fy: string; nums: number[]; seen: string[] }>();
  const add = (docType: string, number: unknown): void => {
    const m = /^([A-Z0-9]{3})\/(\d{4})\/(\d{1,6})$/.exec(String(number));
    if (!m) return;
    const key = `${m[1]!}|${docType}|${m[2]!}`;
    const g = groups.get(key) ?? { docType, series: m[1]!, fy: m[2]!, nums: [], seen: [] };
    g.nums.push(Number(m[3]));
    g.seen.push(String(number));
    groups.set(key, g);
  };
  for (const b of await store.list("bill")) if (b.source_kind !== "manual_book") add(String(b.doc_type ?? "tax_invoice"), b.number);
  for (const c of await store.list("credit_note")) add("credit_note", c.number);
  const out: SeriesGap[] = [];
  for (const g of groups.values()) {
    const have = new Set(g.nums);
    const max = Math.max(...g.nums);
    const missing: number[] = [];
    for (let n = 1; n <= max; n++) if (!have.has(n)) missing.push(n);
    const duplicates = g.seen.filter((x, i) => g.seen.indexOf(x) !== i);
    if (missing.length || duplicates.length) out.push({ series: g.series, docType: g.docType, financialYear: g.fy, missing, duplicates });
  }
  return out;
}
