import type { Mutation } from "../sync";
import type { CreditNoteResult, RebillResult } from "./credit";
import type { FinalizedBill } from "./finalize";

/**
 * Mutations of the sync ops that carry these documents (api-specs sync/intents/billing.yaml): bill.finalize and
 * bill.manual_entry insert the bill, its lines, tax lines and payments, and finalisation moves the check to
 * `billed` (rank) and points it at the bill (set). creditnote.issue inserts the credit note and its rows; bill.rebill
 * is both in one op. These are plain field maps; the sync engine stamps, hashes and applies them.
 */

const ins = (e: string, id: string, f: object): Mutation => ({ e, id, k: "insert", f: f as Record<string, unknown> });
const rest = <T extends { id: string }>(row: T): Omit<T, "id"> => {
  const { id: _id, ...r } = row;
  void _id;
  return r;
};

export function billMutations(f: FinalizedBill): Mutation[] {
  const m: Mutation[] = [ins("bill", f.bill.id, rest(f.bill))];
  for (const l of f.lines) m.push(ins("bill_line", l.id, rest(l)));
  for (const t of f.taxLines) {
    const { owner_id, ...r } = rest(t);
    m.push(ins("bill_tax_line", t.id, { bill_id: owner_id, ...r }));
  }
  for (const p of f.payments) m.push(ins("payment", p.id, rest(p)));
  if (f.checkUpdate) {
    m.push({ e: "check", id: f.checkUpdate.id, k: "rank", f: { status: f.checkUpdate.status } });
    m.push({ e: "check", id: f.checkUpdate.id, k: "set", f: { bill_id: f.checkUpdate.bill_id } });
  }
  return m;
}

export function creditNoteMutations(c: CreditNoteResult): Mutation[] {
  const m: Mutation[] = [ins("credit_note", c.note.id, rest(c.note))];
  for (const l of c.lines) m.push(ins("credit_note_line", l.id, rest(l)));
  for (const t of c.taxLines) {
    const { owner_id, ...r } = rest(t);
    m.push(ins("credit_note_tax_line", t.id, { credit_note_id: owner_id, ...r }));
  }
  return m;
}

export function rebillMutations(r: RebillResult): Mutation[] {
  return [...creditNoteMutations(r.credit), ...r.bills.flatMap(billMutations)];
}
