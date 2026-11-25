import type { PreBillDoc } from "../printing";
import { sha1Hex, uuidv5 } from "./uuid5";
import type { Computation } from "./compute";
import { CALC_VERSION, computeCheck } from "./compute";
import { financialYearOfDate, istDateOf, stampingDate } from "./business-day";
import { parseDocumentNumber } from "./numbering";
import { toPreBillDoc, type PreBillMeta } from "./print";
import {
  DocumentError,
  type BillableLine,
  type BillLineRow,
  type BillRow,
  type CheckHeader,
  type CheckPresentRow,
  type DocumentDeps,
  type OutletBillingContext,
  type PaymentInput,
  type PaymentRow,
  type SourceKind,
  type TaxLineRow,
} from "./types";

/** Everything one bill.finalize / bill.manual_entry op writes, built in memory so the caller writes it in one local transaction. */
export type FinalizedBill = {
  bill: BillRow;
  lines: BillLineRow[];
  taxLines: TaxLineRow[];
  payments: PaymentRow[];
  /** Set for a bill made from a stored check: it moves to `billed` and points at the bill. */
  checkUpdate?: { id: string; status: "billed"; bill_id: string };
  computation: Computation;
};

export type FinalizeOptions = {
  payments?: PaymentInput[];
  /** A manager approved a discount above the cashier limit (the caller holds the approval record). */
  discountApproved?: boolean;
  replaces?: { billId: string; rebillGroupId: string };
};

type Assemble = {
  deps: DocumentDeps;
  ctx: OutletBillingContext;
  header: CheckHeader;
  lines: readonly BillableLine[];
  invoiceDate: string;
  businessDate: string;
  sourceKind: SourceKind;
  billId: string;
  number: string;
  seriesCode: string;
  financialYear: string;
  options: FinalizeOptions;
  bookTotalPaise?: number;
};

function checkDiscountLimit(ctx: OutletBillingContext, c: Computation, approved: boolean | undefined): void {
  const r = c.result;
  if (approved || r.bill_discount_paise === 0) return;
  const base = r.net_paise + r.bill_discount_paise; // sum of line nets before the bill discount
  if (r.bill_discount_paise * 10000 > ctx.settings.discount_limit_bp * base) {
    throw new DocumentError("discount_over_limit", `${r.bill_discount_paise} of ${base}`);
  }
}

function assemble(a: Assemble): FinalizedBill {
  const c = computeCheck(a.ctx, a.header, a.lines, a.invoiceDate);
  const r = c.result;
  const bill: BillRow = {
    id: a.billId,
    number: a.number,
    series_code: a.seriesCode,
    doc_type: c.docType,
    source_kind: a.sourceKind,
    order_type: a.header.order_type,
    eco: c.channel === "eco",
    business_date: a.businessDate,
    invoice_date: a.invoiceDate,
    financial_year: a.financialYear,
    calc_v: CALC_VERSION,
    ruleset_id: c.rulesetId,
    price_mode: c.input.price_mode,
    gross_paise: r.gross_paise,
    discount_paise: r.line_discount_paise + r.bill_discount_paise,
    service_charge_bp: c.serviceChargeBp,
    service_charge_paise: r.service_charge_paise,
    packing_charge_paise: r.packing_paise,
    non_gst_subtotal_paise: r.non_gst_subtotal_paise,
    taxable_paise: r.taxable_paise,
    cgst_paise: r.cgst_paise,
    sgst_paise: r.sgst_paise,
    igst_paise: 0,
    round_off_paise: r.round_off_paise,
    total_paise: r.total_paise,
  };
  if (a.header.id && a.sourceKind === "check") bill.check_id = a.header.id;
  if (a.header.token_no !== undefined) bill.token_no = a.header.token_no;
  if (a.header.customer_name) bill.customer_name = a.header.customer_name;
  if (a.header.customer_gstin) bill.customer_gstin = a.header.customer_gstin;
  if (a.header.waiter_id) bill.waiter_id = a.header.waiter_id;
  if (c.billDiscount) {
    bill.bill_discount_kind = c.billDiscount.kind;
    bill.bill_discount_value = c.billDiscount.value;
  }
  if (a.bookTotalPaise !== undefined) bill.book_total_paise = a.bookTotalPaise;
  if (a.options.replaces) {
    bill.replaces_bill_id = a.options.replaces.billId;
    bill.rebill_group_id = a.options.replaces.rebillGroupId;
  }

  const lines: BillLineRow[] = a.lines.map((l, i) => {
    const t = r.lines[i]!;
    const row: BillLineRow = {
      id: a.deps.newId(),
      bill_id: a.billId,
      line_no: i + 1,
      item_id: l.item_id,
      item_name: l.name,
      category_name: l.category_name,
      qty_milli: l.qty_milli,
      unit_price_paise: l.unit_price_paise,
      modifier_delta_paise: l.modifier_delta_paise,
      line_discount_paise: t.line_discount_paise,
      bill_discount_alloc_paise: t.bill_discount_alloc_paise,
      net_paise: t.net_paise,
      tax_class: l.tax_class,
    };
    if (a.sourceKind === "check") row.order_line_id = l.id;
    if (l.variant_name) row.variant_name = l.variant_name;
    if (l.category_id) row.category_id = l.category_id;
    if (l.hsn_sac) row.hsn_sac = l.hsn_sac;
    if (l.comp) {
      row.comp = true;
      row.comp_value_paise = t.line_discount_paise; // a comp line is a discount of its whole value
    }
    return row;
  });

  const taxLines: TaxLineRow[] = r.groups.map((g) => ({
    id: a.deps.newId(),
    owner_id: a.billId,
    tax_class: g.tax_class,
    rate_bp: g.rate_bp,
    gst_applies: g.gst_applies,
    charge_alloc_paise: g.charge_alloc_paise,
    taxable_paise: g.taxable_paise,
    cgst_paise: g.cgst_paise,
    sgst_paise: g.sgst_paise,
    igst_paise: 0,
  }));

  const pays = a.options.payments ?? [];
  if (pays.reduce((s, p) => s + p.amount_paise, 0) > r.total_paise) throw new DocumentError("payment_exceeds_total");
  const payments: PaymentRow[] = pays.map((p) => {
    const row: PaymentRow = {
      id: a.deps.newId(),
      bill_id: a.billId,
      target_kind: "bill",
      tender: p.tender,
      amount_paise: p.amount_paise,
      business_date: a.businessDate,
    };
    if (p.tender_name) row.tender_name = p.tender_name;
    if (p.tendered_paise !== undefined) row.tendered_paise = p.tendered_paise;
    if (p.change_paise !== undefined) row.change_paise = p.change_paise;
    if (p.reference) row.reference = p.reference;
    return row;
  });

  const out: FinalizedBill = { bill, lines, taxLines, payments, computation: c };
  if (a.sourceKind === "check" && a.header.id) out.checkUpdate = { id: a.header.id, status: "billed", bill_id: a.billId };
  return out;
}

function openDay(deps: DocumentDeps): string {
  const d = stampingDate(deps.businessDays);
  if (!d) throw new DocumentError("no_open_day");
  return d;
}

/**
 * bill.finalize: the first payment, Issue invoice, or Present when the outlet numbers at print. Takes the number
 * from the device series, so call it inside the store transaction that writes the op; nothing is allocated if the
 * calculation refuses the input (the allocation is the last step before the rows are built).
 * A counter sale has no `header.id`. A stored check must still be open.
 */
export function finalizeBill(deps: DocumentDeps, ctx: OutletBillingContext, header: CheckHeader, lines: readonly BillableLine[], options: FinalizeOptions = {}): FinalizedBill {
  if (header.status && header.status !== "open") throw new DocumentError("check_not_open", header.status);
  const invoiceDate = istDateOf(deps.nowMs);
  const businessDate = openDay(deps);
  // Dry run first: refuse bad input before a number is taken, so a refusal never burns a number.
  const trial = computeCheck(ctx, header, lines, invoiceDate);
  checkDiscountLimit(ctx, trial, options.discountApproved);

  const n = deps.allocator.allocate(trial.docType, deps.nowMs);
  const fy = financialYearOfDate(invoiceDate);
  if (n.financialYear !== fy) throw new DocumentError("wrong_financial_year", `${n.number} for invoice date ${invoiceDate}`);
  return assemble({
    deps,
    ctx,
    header,
    lines,
    invoiceDate,
    businessDate,
    sourceKind: header.id ? "check" : "counter",
    billId: deps.newId(),
    number: n.number,
    seriesCode: n.seriesCode,
    financialYear: fy,
    options,
  });
}

export type ManualEntryInput = {
  /** The paper book's number as written: `<code>/<FY>/<running>`. */
  number: string;
  /** Invoice date written on the paper page (IST). */
  invoiceDate: string;
  /** Total written on the paper, kept for verification. */
  bookTotalPaise: number;
  header: CheckHeader;
  lines: readonly BillableLine[];
  payments?: PaymentInput[];
};

/**
 * bill.manual_entry: a paper bill-book page typed in after a power cut. The book keeps its own number (never
 * allocated, never given a second number); the id is a UUIDv5 of series, FY and number so the same page typed
 * on two devices converges on one bill. Our total is computed from the rule set in force on the paper's date;
 * a difference from the book total is reported, never forced (billing records `manual_entry`).
 */
export function manualBookEntry(deps: DocumentDeps, ctx: OutletBillingContext, input: ManualEntryInput): FinalizedBill & { matchesBook: boolean } {
  const n = (() => {
    try {
      return parseDocumentNumber(input.number);
    } catch {
      throw new DocumentError("book_number_invalid", input.number);
    }
  })();
  if (!(ctx.manualBookCodes ?? []).includes(n.seriesCode)) throw new DocumentError("not_a_manual_book", n.seriesCode);
  const fy = financialYearOfDate(input.invoiceDate);
  if (n.financialYear !== fy) throw new DocumentError("wrong_financial_year", `${input.number} for invoice date ${input.invoiceDate}`);
  const header: CheckHeader = { ...input.header };
  delete header.id;
  const f = assemble({
    deps,
    ctx,
    header,
    lines: input.lines,
    invoiceDate: input.invoiceDate,
    businessDate: openDay(deps),
    sourceKind: "manual_book",
    billId: uuidv5(`bill|${n.seriesCode}|${fy}|${n.number}`),
    number: n.number,
    seriesCode: n.seriesCode,
    financialYear: fy,
    options: input.payments ? { payments: input.payments } : {},
    bookTotalPaise: input.bookTotalPaise,
  });
  return { ...f, matchesBook: f.bill.total_paise === input.bookTotalPaise };
}

export type PresentOptions = {
  /** Present count of this one: 1 for the first, then 2, 3. */
  presentCount: number;
  mode: "printed" | "displayed";
  nowMs: number;
  newId: () => string;
  businessName: string;
  tableLabel?: string;
  waiter?: string;
  upiUri?: string;
};

/** Content hash of what the guest was shown: the lines, discounts, charges and total. */
export function presentHash(lines: readonly BillableLine[], header: CheckHeader, c: Computation): string {
  const canon = JSON.stringify([
    lines.map((l) => [l.id, l.qty_milli, l.unit_price_paise, l.modifier_delta_paise, l.tax_class, l.discount_kind ?? null, l.discount_value ?? null, l.comp === true]),
    header.discount_kind ?? null,
    header.discount_value ?? null,
    c.serviceChargeBp,
    c.result.packing_paise,
    c.result.total_paise,
  ]);
  return `sha1:${sha1Hex(canon)}`;
}

/**
 * Present: the recorded, unnumbered pre-bill the guest sees before paying (ADR-0014 A1.5). It needs no series, so a
 * captain's handheld may print it. The tax rows are an estimate from the same rule set and engine as the bill.
 * With `number_at = print` the first print of the guest's bill is a numbered bill: call `finalizeBill` instead
 * (see `triggerForPresent`).
 */
export function presentCheck(ctx: OutletBillingContext, header: CheckHeader & { id: string }, lines: readonly BillableLine[], o: PresentOptions): { row: CheckPresentRow; doc: PreBillDoc; computation: Computation } {
  if (header.status && header.status !== "open") throw new DocumentError("check_not_open", header.status);
  const c = computeCheck(ctx, header, lines, istDateOf(o.nowMs));
  const row: CheckPresentRow = { id: o.newId(), check_id: header.id, present_count: o.presentCount, content_hash: presentHash(lines, header, c), total_paise: c.result.total_paise, mode: o.mode };
  const meta: PreBillMeta = { businessName: o.businessName, sequence: o.presentCount, presentedAt: new Date(o.nowMs).toISOString() };
  if (o.tableLabel) meta.tableLabel = o.tableLabel;
  if (o.waiter) meta.waiter = o.waiter;
  if (o.upiUri) meta.upiUri = o.upiUri;
  return { row, doc: toPreBillDoc(lines, c, meta), computation: c };
}

/**
 * What a "show the guest the bill" action does at this outlet: `settle` records an unnumbered pre-bill and
 * finalises on payment or Issue invoice; `print` numbers the bill at the first print (ADR-0014 A1.5, E1 kept as
 * a setting).
 */
export function triggerForPresent(numberAt: "settle" | "print"): "pre_bill" | "finalize" {
  return numberAt === "print" ? "finalize" : "pre_bill";
}
