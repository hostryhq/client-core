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
