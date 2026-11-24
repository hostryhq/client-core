import { businessDate, formatPaise, formatQty, istDate, istDateTime, istTime } from "./money";
import type { Labels } from "./labels";
import { flow, justify, padLeft, padRight, printable, wrapWords } from "./text";
import type {
  Align,
  BillDoc,
  Business,
  CreditNoteDoc,
  DocLine,
  KotDoc,
  LabelAmount,
  LayoutOp,
  PreBillDoc,
  PrinterProfile,
  PrintDocument,
  Script,
  TaxGroup,
  TextStyle,
  ZReportDoc,
} from "./types";

export type LayoutContext = {
  profile: PrinterProfile;
  labels: Labels;
  /** True when this printer can raster AND the app has a font for the script. Otherwise English prints. */
  canRaster: (script: Script) => boolean;
};

class Builder {
  readonly ops: LayoutOp[] = [];
  readonly cols: number;
  constructor(readonly ctx: LayoutContext) {
    this.cols = ctx.profile.columns;
  }
  get L(): Labels {
    return this.ctx.labels;
  }

  /** Text, wrapped at word boundaries to the width available at the given character size. */
  text(s: string, style: TextStyle = {}, indent = 0): void {
    const cap = Math.max(1, Math.floor(this.cols / (style.w ?? 1)));
    const clean = printable(s);
    if (!clean) return;
    const lines = wrapWords(clean, Math.max(1, cap - indent));
    for (const l of lines) this.ops.push({ t: "text", text: " ".repeat(indent) + l, style });
  }
  /** A pre-formatted, exactly-fitted line (tables). Never wrapped. */
  raw(s: string, style: TextStyle = {}): void {
    this.ops.push({ t: "text", text: s, style });
  }
  center(s: string, style: TextStyle = {}): void {
    this.text(s, { ...style, align: "center" });
  }
  rule(): void {
    this.raw("-".repeat(this.cols));
  }
  row(left: string, right: string, style: TextStyle = {}): void {
    this.raw(justify(printable(left), printable(right), Math.floor(this.cols / (style.w ?? 1))), style);
  }
  raster(text: string, script: Script, o: { indentCols?: number; scale?: 1 | 2 | 3; bold?: boolean; align?: Align } = {}): void {
    this.ops.push({ t: "raster", text, script, indentCols: o.indentCols ?? 0, scale: o.scale ?? 1, bold: o.bold ?? false, align: o.align ?? "left" });
  }
  money(p: number, o: { sign?: boolean } = {}): string {
    return formatPaise(p, o);
  }
  finish(): LayoutOp[] {
    this.ops.push({ t: "cut" });
    return this.ops;
  }
}

function header(b: Builder, biz: Business): void {
  b.center(biz.name, { bold: true });
  for (const a of biz.addressLines ?? []) b.center(a);
  if (biz.gstin) b.center(`${b.L["print.gstin"]} ${biz.gstin}`);
  if (biz.fssai) b.center(`${b.L["print.fssai"]} ${biz.fssai}`);
}

function duplicateBanner(b: Builder, d: { copy: number; reprintedAt: string }): void {
  b.center(`${b.L["print.duplicateCopy"]} ${d.copy} ***`, { h: 2, bold: true });
  b.center(`${b.L["print.reprinted"]} ${istDateTime(d.reprintedAt)}`);
}

/** Item table. Quantity, rate and amount stay on the first line of an item; only the name wraps. */
function itemTable(b: Builder, lines: DocLine[], withHeader = true): void {
  const wide = b.cols >= 44;
  const rows = lines.map((l) => ({ l, qty: formatQty(l.qty), rate: formatPaise(l.rate), amt: formatPaise(l.amount) }));
  const max = (f: (r: (typeof rows)[number]) => string) => rows.reduce((m, r) => Math.max(m, f(r).length), 0);
  const qtyW = Math.max(wide ? 5 : 2, max((r) => r.qty) + 1);
  const rateW = Math.max(wide ? 8 : 7, max((r) => r.rate) + 1);
  const amtW = Math.max(wide ? 11 : 8, max((r) => r.amt));
  const L = b.L;
  // Compact grid: when huge figures leave under 10 columns for the name, the quantity and rate move to a
  // second line ("2 x 250.00") and only the amount stays on the name line. Amounts are never split.
  const compact = b.cols - qtyW - rateW - amtW < 10;
  const nameW = compact ? b.cols - amtW : Math.max(8, b.cols - qtyW - rateW - amtW);
  if (withHeader) {
    b.rule();
    b.raw(
      compact
        ? padRight(L["print.colItem"], nameW) + padLeft(L["print.colAmount"], amtW)
        : padRight(L["print.colItem"], nameW) +
            padLeft(wide ? L["print.colQty"] : L["print.colQtyShort"], qtyW) +
            padLeft(L["print.colRate"], rateW) +
            padLeft(L["print.colAmount"], amtW),
    );
  }
  b.rule();
  for (const r of rows) {
    const name = printable(r.l.name.en);
    const first = wrapWords(name, nameW - 1)[0] ?? "";
    const rest = name.slice(first.length).trim();
    if (compact) {
      b.raw(padRight(first, nameW) + padLeft(r.amt, amtW));
      if (rest) for (const c of wrapWords(rest, nameW - 3)) b.raw(`  ${c}`);
      b.raw(`  ${r.qty} x ${r.rate}`);
    } else {
      b.raw(padRight(first, nameW) + padLeft(r.qty, qtyW) + padLeft(r.rate, rateW) + padLeft(r.amt, amtW));
      if (rest) for (const c of wrapWords(rest, nameW - 3)) b.raw(`  ${c}`);
    }
    const { local, script } = r.l.name;
    if (local && script && b.ctx.canRaster(script)) b.raster(local, script, { indentCols: 2 });
  }
  b.rule();
}

function taxBlock(b: Builder, groups: TaxGroup[]): void {
  const L = b.L;
  const taxable = b.cols >= 44 ? L["print.taxable"] : L["print.taxableShort"];
  for (const g of groups) {
    b.row(`${taxable} (${g.rateLabel})`, b.money(g.taxable));
    if (g.sac) b.text(`SAC ${g.sac}`);
    for (const t of g.taxes) b.row(t.label, b.money(t.amount));
  }
}

function totalRow(b: Builder, label: string, p: number): void {
  b.row(label, `${b.L["print.currency"]} ${b.money(p)}`, { bold: true });
}

function upiQr(b: Builder, uri: string | undefined): void {
  if (!uri || !b.ctx.profile.qr) return;
  b.center(b.L["print.scanToPay"]);
  b.ops.push({ t: "qr", data: uri });
}

function bill(b: Builder, d: BillDoc): void {
  const L = b.L;
  if (d.openDrawer) b.ops.push({ t: "drawer" });
  if (d.duplicate) duplicateBanner(b, d.duplicate);
  const title = d.variant === "tax_invoice" ? L["print.taxInvoice"] : d.variant === "bill_of_supply" ? L["print.billOfSupply"] : L["print.plainBill"];
  b.center(title, { h: 2, bold: true });
  header(b, d.business);
  b.rule();

  const numLabel = d.variant === "plain_bill" ? L["print.billShort"] : L["print.invoiceShort"];
  const when = istDateTime(d.issuedAt);
  const num = `${numLabel} ${d.number}`;
  if (num.length + 1 + when.length <= b.cols) b.raw(justify(num, when, b.cols), { bold: true });
  else {
    // The number is never wrapped: the label moves above it if the line would not fit.
    if (num.length > b.cols) {
      b.text(numLabel, { bold: true });
      if (d.number.length <= b.cols) b.raw(d.number, { bold: true });
      else b.text(d.number, { bold: true }); // longer than the paper: hard-split, never overflow the line
    } else b.raw(num, { bold: true });
    b.raw(when);
  }
  const ctxParts = [
    d.tableLabel ? `${L["print.table"]} ${d.tableLabel}` : "",
    d.orderType ?? "",
    d.waiter ? `${L["print.waiter"]} ${d.waiter}` : "",
    d.billLabel ? `${L["print.bill"]} ${d.billLabel}` : "",
  ].map(printable);
  for (const l of flow(ctxParts, "  ", b.cols)) b.raw(l);
  if (d.guest && (d.guest.name || d.guest.gstin)) {
    const parts = [d.guest.name ? `${L["print.guest"]}: ${d.guest.name}` : "", d.guest.gstin ? `${L["print.gstin"]} ${d.guest.gstin}` : ""].map(printable);
    for (const l of flow(parts, "  ", b.cols)) b.raw(l);
  }

  itemTable(b, d.lines);
  b.row(L["print.subtotal"], b.money(d.subtotal));
  if (d.discount) b.row(d.discount.label, b.money(-Math.abs(d.discount.amount)));
  if (d.serviceCharge !== undefined) b.row(L["print.serviceCharge"], b.money(d.serviceCharge));
  if (d.nonGstSubtotal !== undefined) b.row(L["print.nonGst"], b.money(d.nonGstSubtotal));
  taxBlock(b, d.taxGroups);
  if (d.roundOff) b.row(L["print.roundOff"], b.money(d.roundOff, { sign: true }));
  b.rule();
  totalRow(b, L["print.total"], d.total);
  b.rule();
  upiQr(b, d.upiUri);
  if (d.tenders.length) {
    for (const t of d.tenders) b.row(t.label, b.money(t.amount));
    if (d.change !== undefined && d.change > 0) b.row(L["print.change"], b.money(d.change));
    b.rule();
  }
  if (d.placeOfSupply) b.text(`${L["print.placeOfSupply"]}: ${d.placeOfSupply}`);
  if (d.reverseCharge !== undefined) b.text(`${L["print.reverseCharge"]}: ${d.reverseCharge ? L["print.yes"] : L["print.no"]}`);
  if (d.variant === "bill_of_supply") b.text(L["print.compositionStatement"]);
  if (d.cashier) b.text(`${L["print.cashier"]}: ${d.cashier}`);
  const footer = d.footer ?? L["print.thanks"];
  if (footer) b.center(footer);
}

function preBill(b: Builder, d: PreBillDoc): void {
  const L = b.L;
  b.center(`${L["print.preBill"]} ${d.sequence}`, { h: 2, bold: true, invert: true });
  b.center(L["print.notTaxInvoiceCheck"]);
  b.center(d.businessName, { bold: true });
  if (d.sequence > 1) b.center(`${L["print.replacesPreBill"]} ${d.sequence - 1}`);
  b.rule();
  const parts = [istDateTime(d.presentedAt), d.tableLabel ? `${L["print.table"]} ${d.tableLabel}` : "", d.waiter ?? ""].map(printable);
  for (const l of flow(parts, "   ", b.cols)) b.raw(l);
  itemTable(b, d.lines);
  b.row(L["print.subtotal"], b.money(d.subtotal));
  if (d.discount) b.row(d.discount.label, b.money(-Math.abs(d.discount.amount)));
  for (const t of d.estimatedTaxes) b.row(`${t.label} ${L["print.estimate"]}`, b.money(t.amount));
  b.rule();
  totalRow(b, L["print.totalToPay"], d.total);
  b.rule();
  upiQr(b, d.upiUri);
  b.center(L["print.preBillFoot"]);
  b.center(L["print.notTaxInvoice"], { bold: true });
}

function creditNote(b: Builder, d: CreditNoteDoc): void {
  const L = b.L;
  if (d.duplicate) duplicateBanner(b, d.duplicate);
  b.center(L["print.creditNote"], { h: 2, bold: true });
  header(b, d.business);
  b.rule();
  const cn = `${L["print.creditNoteNo"]} ${d.number}`;
  const when = istDateTime(d.issuedAt);
  if (cn.length + 1 + when.length <= b.cols) b.raw(justify(cn, when, b.cols), { bold: true });
  else {
    b.text(cn.length <= b.cols ? cn : d.number, { bold: true });
    b.raw(when);
  }
  const orig = `${L["print.original"]} ${d.originalNumber}`;
  const od = istDate(d.originalDate);
  if (orig.length + 1 + od.length <= b.cols) b.raw(justify(orig, od, b.cols));
  else {
    b.text(orig.length <= b.cols ? orig : d.originalNumber);
    b.raw(od);
  }
  itemTable(b, d.lines);
  taxBlock(b, d.taxGroups);
  b.rule();
  totalRow(b, L["print.totalCredit"], d.total);
  b.rule();
  b.text(`${L["print.refund"]}: ${d.refundMode}`);
  const reason = printable(`${L["print.reason"]}: ${d.reason}`);
  const appr = d.approvedBy ? printable(`${L["print.approved"]}: ${d.approvedBy}`) : "";
  if (appr && reason.length + 2 + appr.length <= b.cols) b.raw(justify(reason, appr, b.cols));
  else {
    b.text(reason);
    if (appr) b.text(appr);
  }
}

function kot(b: Builder, d: KotDoc): void {
  const L = b.L;
  const hdr: TextStyle = { h: 2, bold: true, invert: true };
  switch (d.variant) {
    case "duplicate":
      b.center(L["print.kot.duplicate"], hdr);
      if (d.reprintedAt) b.center(`${L["print.reprinted"]} ${istDateTime(d.reprintedAt)}`);
      break;
    case "cancel":
      b.center(L["print.kot.cancel"], hdr);
      break;
    case "moved":
      b.center(`${L["print.kot.moved"]} ${d.movedFrom ?? "?"} -> ${d.movedTo ?? "?"} ***`, hdr);
      break;
    case "fallback":
      b.center(L["print.kot.fallback"], hdr);
      b.text(`${L["print.kot.kot"]} ${d.kotNumber}  ${L["print.kot.fallbackDetail"]}`, { bold: true });
      break;
    case "late":
      b.center(L["print.kot.late"], hdr);
      b.text(`${L["print.kot.kot"]} ${d.kotNumber} (${d.ageMinutes ?? "?"} ${L["print.kot.minOld"]})`, { bold: true });
      break;
    case "original":
      break;
  }
  b.raw(justify(printable(d.station), istTime(d.createdAt), b.cols), { bold: true });
  const label = printable(d.tableLabel);
  const w = ([3, 2, 1] as const).find((n) => label.length * n <= b.cols) ?? 1;
  b.text(label, { w, h: w, bold: true });
  const parts = [d.orderType ?? "", d.waiter ? `${L["print.kot.waiter"]}: ${d.waiter}` : "", d.billLabel ? `${L["print.bill"]} ${d.billLabel}` : ""].map(printable);
  for (const l of flow(parts, "   ", b.cols)) b.raw(l);
  b.text(`${L["print.kot.kot"]} ${d.kotNumber}`);
  b.rule();
  const modIndent = b.cols >= 44 ? 6 : 4;
  for (const ln of d.lines) {
    const script = ln.name.script ?? d.stationScript;
    const variant = ln.variant ? ` ${ln.variant}` : "";
    if (d.stationScript && ln.name.local && script && b.ctx.canRaster(script)) {
      // Quantity is drawn inside the bitmap: a raster block cannot share a line with native text.
      b.raster(`${formatQty(ln.qty)} x ${ln.name.local}${variant}`, script, { indentCols: 1, scale: 2 });
    } else {
      b.text(`${formatQty(ln.qty)} x ${ln.name.en}${variant}`, { h: 2 }, 1);
    }
    for (const m of ln.modifiers ?? []) b.text(m, {}, modIndent);
  }
  b.rule();
  if (d.reason) b.text(`${L["print.reason"]}: ${d.reason}`, { h: 2, bold: true });
  if (d.note) b.text(`${L["print.kot.note"]}: ${d.note}`);
}

function zReport(b: Builder, d: ZReportDoc): void {
  const L = b.L;
  if (d.duplicate) duplicateBanner(b, d.duplicate);
  b.center(`${L["print.z.title"]} ${d.number}`, { h: 2, bold: true });
  if (d.revision) b.center(L["print.z.revision"], { bold: true });
  b.center(d.outletName);
  const meta = [`${L["print.z.businessDate"]} ${businessDate(d.businessDate)}`, `${L["print.z.closed"]} ${istTime(d.closedAt)} ${L["print.z.by"]} ${d.closedBy}`].map(printable);
  for (const l of flow(meta, "   ", b.cols)) b.raw(l);
  b.rule();
  for (const r of d.rows) b.row(r.label, b.money(r.amount));
  totalRow(b, L["print.total"], d.total);
  b.rule();
  const stats = [`${L["print.z.bills"]} ${d.bills}`];
  if (d.covers !== undefined) stats.push(`${L["print.z.covers"]} ${d.covers}`);
  if (d.average !== undefined) stats.push(`${L["print.z.average"]} ${b.money(d.average)}`);
  for (const l of flow(stats, "   ", b.cols)) b.raw(l);
  const amts = (xs: LabelAmount[]) => xs.map((x) => `${printable(x.label)} ${b.money(x.amount)}`);
  for (const group of [d.tenders, d.channels]) for (const l of flow(amts(group), "  ", b.cols)) b.raw(l);
  const c = d.control;
  const ctl = [
    `${L["print.z.voids"]} ${c.voids}`,
    `${L["print.z.cancels"]} ${c.cancels}`,
    `${L["print.z.comps"]} ${c.comps}`,
    `${L["print.z.refunds"]} ${c.refunds}`,
    `${L["print.z.creditNotes"]} ${c.creditNotes}`,
  ];
  for (const l of flow(ctl, "  ", b.cols)) b.raw(l);
  for (const s of d.series) b.text(`${L["print.z.series"]} ${s}`);
  if (d.variances.length) b.text(`${L["print.z.variances"]}: ${amts(d.variances).join("  ")}`);
  if (d.unpaidCarried !== undefined) b.text(`${L["print.z.unpaidCarried"]}: ${d.unpaidCarried}`);
  if (d.preBills) {
    const p = d.preBills;
    b.text(`${L["print.z.preBills"]} ${p.shown}, ${L["print.z.billed"]} ${p.billed}, ${L["print.z.cancelled"]} ${p.cancelled}, ${L["print.z.carried"]} ${p.carried}`);
  }
}

/** Lay a document out for a printer profile. Pure: no I/O, no clock. */
export function layoutDocument(doc: PrintDocument, ctx: LayoutContext): LayoutOp[] {
  const b = new Builder(ctx);
  switch (doc.kind) {
    case "bill":
      bill(b, doc);
      break;
    case "pre_bill":
      preBill(b, doc);
      break;
    case "credit_note":
      creditNote(b, doc);
      break;
    case "kot":
      kot(b, doc);
      break;
    case "z_report":
      zReport(b, doc);
      break;
  }
  return b.finish();
}
