/**
 * Printing document model and layout types (ADR-0014 R8; docs/design/restaurant-app-flows.md section 4).
 * Product-neutral: restaurant, bakery counter, stall and hotel billing build their documents from these.
 * Money is integer paise. Timestamps are RFC 3339 UTC strings; they print in IST.
 * Documents carry already-computed figures: printing never recomputes tax or totals.
 */

export type Paise = number;
export type Script = "ta" | "ml";

/** An item name. `en` always prints; `local` prints as a raster line when a font is available. */
export type LocalName = { en: string; local?: string; script?: Script };

export type LabelAmount = { label: string; amount: Paise };

export type Business = {
  name: string;
  addressLines?: string[];
  gstin?: string;
  fssai?: string;
};

export type DocLine = {
  name: LocalName;
  /** Printed with up to 3 decimals (weighed goods). */
  qty: number;
  rate: Paise;
  amount: Paise;
};

export type TaxGroup = {
  /** e.g. "5%" */
  rateLabel: string;
  taxable: Paise;
  /** e.g. { label: "CGST 2.5%", amount: 750 } */
  taxes: LabelAmount[];
  sac?: string;
};

export type Duplicate = { copy: number; reprintedAt: string };

export type BillVariant = "tax_invoice" | "bill_of_supply" | "plain_bill";

export type BillDoc = {
  kind: "bill";
  variant: BillVariant;
  business: Business;
  number: string;
  issuedAt: string;
  tableLabel?: string;
  orderType?: string;
  waiter?: string;
  billLabel?: string;
  guest?: { name?: string; gstin?: string };
  lines: DocLine[];
  subtotal: Paise;
  discount?: { label: string; amount: Paise };
  serviceCharge?: Paise;
  nonGstSubtotal?: Paise;
  taxGroups: TaxGroup[];
  roundOff?: Paise;
  total: Paise;
  tenders: LabelAmount[];
  change?: Paise;
  placeOfSupply?: string;
  reverseCharge?: boolean;
  cashier?: string;
  footer?: string;
  duplicate?: Duplicate;
  /** Kick the cash drawer before printing (cash tender). */
  openDrawer?: boolean;
  /** `upi://pay?...` URI to print as a QR under the total. */
  upiUri?: string;
};

/** Guest-facing check before payment (ADR-0014 A1.5). Never has an invoice number or tax-invoice heading. */
export type PreBillDoc = {
  kind: "pre_bill";
  businessName: string;
  /** 1 for the first Present; a later one prints "Replaces pre-bill n-1". */
  sequence: number;
  presentedAt: string;
  tableLabel?: string;
  waiter?: string;
  lines: DocLine[];
  subtotal: Paise;
  discount?: { label: string; amount: Paise };
  /** Estimated tax lines from the same rule set; printed marked "(estimate)". */
  estimatedTaxes: LabelAmount[];
  total: Paise;
  upiUri?: string;
};

export type CreditNoteDoc = {
  kind: "credit_note";
  business: Business;
  number: string;
  issuedAt: string;
  originalNumber: string;
  originalDate: string;
  lines: DocLine[];
  taxGroups: TaxGroup[];
  total: Paise;
  refundMode: string;
  reason: string;
  approvedBy?: string;
  duplicate?: Duplicate;
};

export type KotVariant = "original" | "duplicate" | "cancel" | "moved" | "fallback" | "late";

export type KotLine = {
  qty: number;
  name: LocalName;
  /** Variant text, e.g. "Half". */
  variant?: string;
  /** Modifiers and per-line notes, printed indented under the item. */
  modifiers?: string[];
};

/** Kitchen ticket. Deliberately has no prices and no customer name or phone (flows 4.4). */
export type KotDoc = {
  kind: "kot";
  variant: KotVariant;
  station: string;
  /** Station language: lines with a `local` name print it as raster. Absent = English only. */
  stationScript?: Script;
  /** "T6" or "TAKEAWAY #27"; printed large. */
  tableLabel: string;
  orderType?: string;
  waiter?: string;
  billLabel?: string;
  kotNumber: string;
  /** When the KOT was created (UTC). Drives the stale rule in PrintService. */
  createdAt: string;
  lines: KotLine[];
  note?: string;
  /** cancel variant */
  reason?: string;
  /** moved variant */
  movedFrom?: string;
  movedTo?: string;
  /** duplicate variant */
  reprintedAt?: string;
  /** late variant: age at the time a person printed it */
  ageMinutes?: number;
  /** A person gave this KOT to the kitchen by hand/verbally (ADR-0014 A1.6); never auto-printed. */
  handedOver?: boolean;
};

export type ZReportDoc = {
  kind: "z_report";
  /** Display number, e.g. "Z/2026-11-24/A07" or "Z/2026-11-24/A07/R1". */
  number: string;
  revision?: boolean;
  outletName: string;
  businessDate: string;
  closedAt: string;
  closedBy: string;
  /** Gross .. round-off rows, in order. */
  rows: LabelAmount[];
  total: Paise;
  bills: number;
  covers?: number;
  /** Average bill in paise. */
  average?: Paise;
  tenders: LabelAmount[];
  channels: LabelAmount[];
  control: { voids: number; cancels: number; comps: number; refunds: number; creditNotes: number };
  series: string[];
  variances: LabelAmount[];
  unpaidCarried?: number;
  preBills?: { shown: number; billed: number; cancelled: number; carried: number };
  duplicate?: Duplicate;
};

export type PrintDocument = BillDoc | PreBillDoc | CreditNoteDoc | KotDoc | ZReportDoc;

/** How a particular printer model is driven. Layout is generated from the profile, never hard-coded. */
export type PrinterProfile = {
  id: string;
  name: string;
  widthMm: 58 | 80;
  /** Characters per line in font A. */
  columns: number;
  /** Printable dots per line (raster width). */
  dots: number;
  /** ESC t n selected after init; undefined leaves the printer default. Text is ASCII-folded either way. */
  codePage?: number;
  /** Can take GS v 0 raster; false means Tamil/Malayalam fall back to the English name. */
  raster: boolean;
  /** Rows per GS v 0 block (some printers have small buffers). */
  rasterBandRows: number;
  /** GS ( k QR support. */
  qr: boolean;
  qrModuleSize: number;
  cut: "partial" | "full" | "none";
  feedBeforeCut: number;
  /** Cash drawer pin: 0 = pin 2, 1 = pin 5. */
  drawerPin: 0 | 1;
};

export type Align = "left" | "center" | "right";
export type TextStyle = { align?: Align; bold?: boolean; w?: 1 | 2 | 3 | 4; h?: 1 | 2 | 3 | 4; invert?: boolean };

/** Layout output: device-independent lines the encoder turns into bytes. */
export type LayoutOp =
  | { t: "text"; text: string; style: TextStyle }
  | { t: "raster"; text: string; script: Script; indentCols: number; scale: 1 | 2 | 3; bold: boolean; align: Align }
  | { t: "qr"; data: string }
  | { t: "feed"; lines: number }
  | { t: "drawer" }
  | { t: "cut" };
