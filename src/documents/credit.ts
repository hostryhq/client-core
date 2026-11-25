import { calculateBill, calculateCredit, TaxError, type DocKind, type Regime, type Rule, type TaxBillInput } from "../tax";
import { financialYearOfDate, istDateOf, stampingDate } from "./business-day";
import { computeCheck, CALC_VERSION } from "./compute";
import { finalizeBill, type FinalizedBill, type FinalizeOptions } from "./finalize";
import {
  DocumentError,
  type BillableLine,
  type BillingSettings,
  type BillLineRow,
  type BillRow,
  type CheckHeader,
  type CreditNoteLineRow,
  type CreditNoteRow,
  type DocumentDeps,
  type OutletBillingContext,
  type RefundTender,
  type TaxLineRow,
} from "./types";

/** A numbered bill as stored: self-contained, so a credit note needs nothing from orders or catalog. */
export type OriginalBill = { bill: BillRow; lines: BillLineRow[]; taxLines: TaxLineRow[] };

export type CreditNoteResult = {
  note: CreditNoteRow;
  lines: CreditNoteLineRow[];
  taxLines: TaxLineRow[];
};

const REGIME_OF_DOC: Record<DocKind, Regime> = { tax_invoice: "regular", bill_of_supply: "composition", plain_bill: "unregistered" };

/**
 * Rebuilds the calculation input of a stored bill from its own rows: the tax lines carry the rates it used, the
 * line rows its discounts, so the credit note reverses exactly what the bill charged. The bill row does not say
 * whether round-off was on or what tax class its packing charge had, so those come from the caller (the outlet
 * settings, and the bill's round-off when non-zero). The rebuilt total must equal the stored total or the credit
 * is refused: a credit note never rests on a calculation that cannot reproduce the bill.
 */
export function taxInputOfBill(o: OriginalBill, settings: Pick<BillingSettings, "round_off" | "packing_tax_class">): TaxBillInput {
  const { bill } = o;
  const rules: Record<string, Rule> = {};
  for (const t of o.taxLines) rules[t.tax_class] = { gst: t.gst_applies, cgst_bp: t.rate_bp / 2, sgst_bp: t.rate_bp / 2 };
  const allocated = o.lines.reduce((s, l) => s + l.bill_discount_alloc_paise, 0);
  const input: TaxBillInput = {
    regime: REGIME_OF_DOC[bill.doc_type],
    price_mode: bill.price_mode,
    round_off: bill.round_off_paise !== 0 || settings.round_off,
    rules,
    lines: o.lines.map((l) => ({
      id: l.id,
      qty_milli: l.qty_milli,
      unit_price_paise: l.unit_price_paise,
      modifier_delta_paise: l.modifier_delta_paise,
      tax_class: l.tax_class,
      discount: !l.comp && l.line_discount_paise > 0 ? { kind: "amount", value: l.line_discount_paise } : null,
      comp: l.comp === true,
    })),
    bill_discount: allocated > 0 ? { kind: "amount", value: allocated } : null,
    service_charge_bp: bill.service_charge_bp,
    packing: null,
  };
  if (bill.packing_charge_paise > 0) {
    if (!settings.packing_tax_class) throw new DocumentError("missing_packing_class");
    input.packing = { amount_paise: bill.packing_charge_paise, tax_class: settings.packing_tax_class };
  }
  if (calculateBill(input).total_paise !== bill.total_paise) throw new DocumentError("original_not_reproducible", bill.number);
  return input;
}

export type CreditRequest = {
  /** Quantity to credit per bill line (thousandths). */
  lines: ReadonlyArray<{ bill_line_id: string; qty_milli: number }>;
  reasonCodeId?: string;
  refundTender?: RefundTender;
  /** Quantity already credited per bill line by earlier credit notes. */
  previousCredited?: Readonly<Record<string, number>>;
  rebillGroupId?: string;
};

/** Credit request that reverses everything not yet credited. */
export function fullCredit(o: OriginalBill, previousCredited: Readonly<Record<string, number>> = {}): CreditRequest["lines"] {
  return o.lines.map((l) => ({ bill_line_id: l.id, qty_milli: l.qty_milli - (previousCredited[l.id] ?? 0) })).filter((l) => l.qty_milli > 0);
}

/** creditnote.issue: the only correction of a numbered bill. Call inside the op's transaction (it takes a number). */
export function issueCreditNote(deps: DocumentDeps, ctx: OutletBillingContext, original: OriginalBill, req: CreditRequest): CreditNoteResult {
  const asked = req.lines.filter((l) => l.qty_milli > 0);
  if (asked.length === 0) throw new DocumentError("nothing_to_credit");
  const byId = new Map(original.lines.map((l) => [l.id, l]));
  for (const l of asked) {
    const orig = byId.get(l.bill_line_id);
    if (!orig) throw new TaxError("unknown_line", l.bill_line_id);
    if (l.qty_milli + (req.previousCredited?.[l.bill_line_id] ?? 0) > orig.qty_milli) throw new DocumentError("credit_exceeds_original", orig.id);
  }
  const input = taxInputOfBill(original, ctx.settings);
  const calc = calculateCredit(input, asked.map((l) => ({ line_id: l.bill_line_id, qty_milli: l.qty_milli })));

  const invoiceDate = istDateOf(deps.nowMs);
  const businessDate = stampingDate(deps.businessDays);
  if (!businessDate) throw new DocumentError("no_open_day");
  const n = deps.allocator.allocate("credit_note", deps.nowMs);
  const fy = financialYearOfDate(invoiceDate);
  if (n.financialYear !== fy) throw new DocumentError("wrong_financial_year", `${n.number} for ${invoiceDate}`);

  const id = deps.newId();
  const note: CreditNoteRow = {
    id,
    number: n.number,
    series_code: n.seriesCode,
    bill_id: original.bill.id,
    bill_number: original.bill.number,
    bill_invoice_date: original.bill.invoice_date,
    business_date: businessDate,
    invoice_date: invoiceDate,
    financial_year: fy,
    calc_v: CALC_VERSION,
    ruleset_id: original.bill.ruleset_id,
    total_paise: calc.total_paise,
    round_off_paise: calc.round_off_paise,
  };
  if (req.reasonCodeId) note.reason_code_id = req.reasonCodeId;
  if (req.rebillGroupId) note.rebill_group_id = req.rebillGroupId;
  if (req.refundTender) note.refund_tender = req.refundTender;

  let no = 0;
  const lines: CreditNoteLineRow[] = calc.lines
    .filter((l) => l.credited_qty_milli > 0)
    .map((l) => {
      const orig = byId.get(l.id)!;
      return { id: deps.newId(), credit_note_id: id, line_no: ++no, bill_line_id: l.id, item_name: orig.item_name, qty_milli: l.credited_qty_milli, net_paise: l.credited_net_paise, tax_class: orig.tax_class };
    });
  const taxLines: TaxLineRow[] = calc.groups
    .filter((g) => g.value_paise > 0)
    .map((g) => ({ id: deps.newId(), owner_id: id, tax_class: g.tax_class, rate_bp: g.rate_bp, gst_applies: g.gst_applies, charge_alloc_paise: g.charge_alloc_paise, taxable_paise: g.taxable_paise, cgst_paise: g.cgst_paise, sgst_paise: g.sgst_paise, igst_paise: 0 }));
  return { note, lines, taxLines };
}

export type Replacement = { header: CheckHeader; lines: BillableLine[]; options?: FinalizeOptions };

export type RebillResult = { rebillGroupId: string; credit: CreditNoteResult; bills: FinalizedBill[] };

/**
 * bill.rebill: split, add a GSTIN, change a discount or remove an item on a numbered bill. One op, one local
 * transaction: a full credit note for what is not yet credited, then the replacement bills, all in one rebill
 * group so no node sees half of it. Every replacement is calculated before any number is taken.
 */
export function rebill(deps: DocumentDeps, ctx: OutletBillingContext, original: OriginalBill, replacements: readonly Replacement[], opts: { reasonCodeId?: string; refundTender?: RefundTender; previousCredited?: Readonly<Record<string, number>> } = {}): RebillResult {
  if (replacements.length === 0) throw new DocumentError("rebill_needs_replacement");
  const invoiceDate = istDateOf(deps.nowMs);
  for (const r of replacements) computeCheck(ctx, r.header, r.lines, invoiceDate); // refuse bad input before any number is taken

  const rebillGroupId = deps.newId();
  const req: CreditRequest = { lines: fullCredit(original, opts.previousCredited), rebillGroupId };
  if (opts.reasonCodeId) req.reasonCodeId = opts.reasonCodeId;
  if (opts.refundTender) req.refundTender = opts.refundTender;
  if (opts.previousCredited) req.previousCredited = opts.previousCredited;
  const credit = issueCreditNote(deps, ctx, original, req);

  const bills = replacements.map((r) => {
    const header: CheckHeader = { ...r.header };
    delete header.status; // the check is already billed; the replacement is not a transition of it
    const f = finalizeBill(deps, ctx, header, r.lines, { ...r.options, replaces: { billId: original.bill.id, rebillGroupId } });
    delete f.checkUpdate;
    return f;
  });
  return { rebillGroupId, credit, bills };
}
