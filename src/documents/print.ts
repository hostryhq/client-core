import type { BillDoc, Business, CreditNoteDoc, DocLine, Duplicate, LabelAmount, PreBillDoc, TaxGroup } from "../printing";
import type { Computation } from "./compute";
import type { BillableLine, BillLineRow, BillRow, CreditNoteLineRow, CreditNoteRow, PaymentRow, TaxLineRow } from "./types";

/**
 * Maps domain documents to the printing document model. Printing never recomputes: every figure here is already on
 * the document row. English display strings are defaults; the app passes translated ones (i18n keys live in the app).
 */

export const ORDER_TYPE_LABEL_EN: Record<string, string> = { dine_in: "Dine-in", takeaway: "Takeaway", counter: "Counter" };
export const TENDER_LABEL_EN: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", other: "Other", eco: "Aggregator" };

/** 250 -> "2.5", 500 -> "5", 225 -> "2.25". Display only; integer arithmetic. */
export function formatBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  const f = String(frac).padStart(2, "0").replace(/0$/, "");
  return `${whole}.${f}`;
}

export type PrintStrings = {
  discount: string;
  orderType: Record<string, string>;
  tender: Record<string, string>;
};

export const PRINT_STRINGS_EN: PrintStrings = { discount: "Discount", orderType: ORDER_TYPE_LABEL_EN, tender: TENDER_LABEL_EN };

type TaxLineLike = Pick<TaxLineRow, "tax_class" | "rate_bp" | "gst_applies" | "taxable_paise" | "cgst_paise" | "sgst_paise">;

function taxGroups(lines: readonly TaxLineLike[], sacOf: (taxClass: string) => string | undefined): TaxGroup[] {
  return lines
    .filter((t) => t.gst_applies)
    .map((t) => {
      const half = formatBp(t.rate_bp / 2);
      const g: TaxGroup = {
        rateLabel: `${formatBp(t.rate_bp)}%`,
        taxable: t.taxable_paise,
        taxes: [
          { label: `CGST ${half}%`, amount: t.cgst_paise },
          { label: `SGST ${half}%`, amount: t.sgst_paise },
        ],
      };
      const sac = sacOf(t.tax_class);
      if (sac) g.sac = sac;
      return g;
    });
}

const rateOf = (unit: number, mod: number) => Math.max(0, unit + mod);

export type BillPrintMeta = {
  business: Business;
  issuedAt: string;
  tableLabel?: string;
  waiter?: string;
  billLabel?: string;
  cashier?: string;
  footer?: string;
  placeOfSupply?: string;
  upiUri?: string;
  duplicate?: Duplicate;
  strings?: PrintStrings;
};

/** A numbered bill to the print model. Tax-invoice, bill-of-supply and plain-bill variants follow `doc_type`. */
export function toBillDoc(bill: BillRow, lines: readonly BillLineRow[], taxLines: readonly TaxLineRow[], payments: readonly PaymentRow[], meta: BillPrintMeta): BillDoc {
  const S = meta.strings ?? PRINT_STRINGS_EN;
  const docLines: DocLine[] = lines.map((l) => ({
    name: { en: l.item_name },
    qty: l.qty_milli / 1000,
    rate: rateOf(l.unit_price_paise, l.modifier_delta_paise),
    amount: l.net_paise + l.line_discount_paise + l.bill_discount_alloc_paise,
  }));
  const sac = (c: string) => lines.find((l) => l.tax_class === c && l.hsn_sac)?.hsn_sac;
  const tenders: LabelAmount[] = payments.map((p) => ({ label: p.tender === "other" && p.tender_name ? p.tender_name : (S.tender[p.tender] ?? p.tender), amount: p.amount_paise }));
  const change = payments.reduce((s, p) => s + (p.change_paise ?? 0), 0);
  const doc: BillDoc = {
    kind: "bill",
    variant: bill.doc_type,
    business: meta.business,
    number: bill.number,
    issuedAt: meta.issuedAt,
    orderType: S.orderType[bill.order_type] ?? bill.order_type,
    lines: docLines,
    subtotal: bill.gross_paise,
    taxGroups: taxGroups(taxLines, sac),
    total: bill.total_paise,
    tenders,
  };
  if (meta.tableLabel) doc.tableLabel = meta.tableLabel;
  if (meta.waiter) doc.waiter = meta.waiter;
  if (meta.billLabel) doc.billLabel = meta.billLabel;
  if (bill.customer_name || bill.customer_gstin) {
    doc.guest = {};
    if (bill.customer_name) doc.guest.name = bill.customer_name;
    if (bill.customer_gstin) doc.guest.gstin = bill.customer_gstin;
  }
  if (bill.discount_paise > 0) doc.discount = { label: S.discount, amount: bill.discount_paise };
  if (bill.service_charge_paise > 0) doc.serviceCharge = bill.service_charge_paise;
  if (bill.packing_charge_paise > 0) doc.packingCharge = bill.packing_charge_paise;
  if (bill.non_gst_subtotal_paise > 0 && bill.doc_type === "tax_invoice") doc.nonGstSubtotal = bill.non_gst_subtotal_paise;
  if (bill.round_off_paise !== 0) doc.roundOff = bill.round_off_paise;
  if (change > 0) doc.change = change;
  if (payments.some((p) => p.tender === "cash")) doc.openDrawer = true;
  if (meta.placeOfSupply) doc.placeOfSupply = meta.placeOfSupply;
  if (bill.doc_type === "tax_invoice") doc.reverseCharge = false;
  if (meta.cashier) doc.cashier = meta.cashier;
  if (meta.footer) doc.footer = meta.footer;
  if (meta.upiUri) doc.upiUri = meta.upiUri;
  if (meta.duplicate) doc.duplicate = meta.duplicate;
  return doc;
}

export type PreBillMeta = {
  businessName: string;
  /** 1 for the first Present of the check. */
  sequence: number;
  presentedAt: string;
  tableLabel?: string;
  waiter?: string;
  upiUri?: string;
  strings?: PrintStrings;
};

/**
 * The guest-facing pre-bill: unnumbered, "NOT A TAX INVOICE" (the layout prints the heading). Tax rows are the
 * estimate from the same rule set and are left out in inclusive mode, where the total is the menu price and the
 * tax is inside it (the numbered bill shows the breakup).
 */
export function toPreBillDoc(lines: readonly BillableLine[], c: Computation, meta: PreBillMeta): PreBillDoc {
  const S = meta.strings ?? PRINT_STRINGS_EN;
  const r = c.result;
  const docLines: DocLine[] = lines.map((l, i) => ({
    name: { en: l.variant_name ? `${l.name} (${l.variant_name})` : l.name },
    qty: l.qty_milli / 1000,
    rate: rateOf(l.unit_price_paise, l.modifier_delta_paise),
    amount: r.lines[i]!.value_paise,
  }));
  const estimatedTaxes: LabelAmount[] = [];
  if (c.input.price_mode === "exclusive") {
    for (const g of r.groups.filter((x) => x.gst_applies && (x.cgst_paise > 0 || x.sgst_paise > 0))) {
      const half = formatBp(g.rate_bp / 2);
      estimatedTaxes.push({ label: `CGST ${half}%`, amount: g.cgst_paise }, { label: `SGST ${half}%`, amount: g.sgst_paise });
    }
  }
  const doc: PreBillDoc = {
    kind: "pre_bill",
    businessName: meta.businessName,
    sequence: meta.sequence,
    presentedAt: meta.presentedAt,
    lines: docLines,
    subtotal: r.gross_paise,
    estimatedTaxes,
    total: r.total_paise,
  };
  const disc = r.line_discount_paise + r.bill_discount_paise;
  if (disc > 0) doc.discount = { label: S.discount, amount: disc };
  if (r.service_charge_paise > 0) doc.serviceCharge = r.service_charge_paise;
  if (r.packing_paise > 0) doc.packingCharge = r.packing_paise;
  if (r.round_off_paise !== 0) doc.roundOff = r.round_off_paise;
  if (meta.tableLabel) doc.tableLabel = meta.tableLabel;
  if (meta.waiter) doc.waiter = meta.waiter;
  if (meta.upiUri) doc.upiUri = meta.upiUri;
  return doc;
}

export type CreditNotePrintMeta = {
  business: Business;
  issuedAt: string;
  refundMode: string;
  reason: string;
  approvedBy?: string;
  duplicate?: Duplicate;
};

export function toCreditNoteDoc(cn: CreditNoteRow, lines: readonly CreditNoteLineRow[], taxLines: readonly TaxLineRow[], meta: CreditNotePrintMeta): CreditNoteDoc {
  const docLines: DocLine[] = lines.map((l) => ({
    name: { en: l.item_name },
    qty: l.qty_milli / 1000,
    rate: Math.round((l.net_paise * 1000) / l.qty_milli),
    amount: l.net_paise,
  }));
  const doc: CreditNoteDoc = {
    kind: "credit_note",
    business: meta.business,
    number: cn.number,
    issuedAt: meta.issuedAt,
    originalNumber: cn.bill_number,
    originalDate: `${cn.bill_invoice_date}T00:00:00+05:30`,
    lines: docLines,
    taxGroups: taxGroups(taxLines, () => undefined),
    total: cn.total_paise,
    refundMode: meta.refundMode,
    reason: meta.reason,
  };
  if (meta.approvedBy) doc.approvedBy = meta.approvedBy;
  if (meta.duplicate) doc.duplicate = meta.duplicate;
  return doc;
}
