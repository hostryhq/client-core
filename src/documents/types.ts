import type { DocKind, Discount, OrderChannel, PriceMode, Regime } from "../tax";
import type { RuleSetDoc } from "../tax";
import type { DocumentNumberAllocator } from "./numbering";

/**
 * Domain shapes for the trading documents. Rows mirror api-specs entities/restaurant (snake_case, the wire) so the
 * data layer writes them without renaming; only fields the logic reads or produces are typed. Money is integer
 * paise, quantities thousandths, rates basis points, dates "YYYY-MM-DD" (IST), instants RFC 3339 UTC.
 */

export type OrderType = "dine_in" | "takeaway" | "counter";
export type SourceKind = "check" | "counter" | "manual_book";
export type NumberAt = "settle" | "print";
export type Tender = "cash" | "upi" | "card" | "other" | "eco";
export type RefundTender = "cash" | "upi" | "card" | "other" | "adjusted";

export type BillingSettings = {
  number_at: NumberAt;
  price_mode: PriceMode;
  round_off: boolean;
  service_charge_bp: number;
  service_charge_dine_in: boolean;
  service_charge_takeaway: boolean;
  service_charge_counter: boolean;
  packing_charge_paise: number;
  packing_tax_class: string;
  /** Cashier discount limit in basis points of the bill-level discount base. */
  discount_limit_bp: number;
};

/** Everything an outlet contributes to a calculation. Loaded from the local store; the domain never reads the store. */
export type OutletBillingContext = {
  outletId: string;
  settings: BillingSettings;
  regime: Regime;
  /** Outlet tax profile of the financial year of the invoice date. */
  specifiedPremises: boolean;
  /** Published rule sets held on the device (id and document); the one in force on the invoice date is used. */
  ruleSets: Array<{ id: string; doc: RuleSetDoc }>;
  /** Entry-only series codes of paper bill books (manual_book), if any. */
  manualBookCodes?: string[];
};

/** Header of a check (or of a counter sale, which has no stored check). */
export type CheckHeader = {
  /** Absent for a counter sale. */
  id?: string;
  order_type: OrderType;
  status?: "open" | "closed_internal" | "billed";
  token_no?: number;
  discount_kind?: "percent" | "amount";
  discount_value?: number;
  service_charge_removed?: boolean;
  packing_charge_removed?: boolean;
  customer_name?: string;
  customer_gstin?: string;
  /** Aggregator order (RM-C8); selects the `eco` rule rows. */
  eco_channel?: "swiggy" | "zomato" | "other";
  waiter_id?: string;
};

/** An order line (or a counter line) as billed. */
export type BillableLine = {
  /** Order line id; a counter sale uses any unique id. */
  id: string;
  item_id: string;
  name: string;
  variant_name?: string;
  category_id?: string;
  category_name: string;
  qty_milli: number;
  unit_price_paise: number;
  modifier_delta_paise: number;
  tax_class: string;
  hsn_sac?: string;
  discount_kind?: "percent" | "amount";
  discount_value?: number;
  comp?: boolean;
};

export type BillRow = {
  id: string;
  number: string;
  series_code: string;
  doc_type: DocKind;
  source_kind: SourceKind;
  check_id?: string;
  order_type: OrderType;
  eco: boolean;
  token_no?: number;
  customer_name?: string;
  customer_gstin?: string;
  business_date: string;
  invoice_date: string;
  financial_year: string;
  calc_v: number;
  ruleset_id: string;
  price_mode: PriceMode;
  waiter_id?: string;
  gross_paise: number;
  discount_paise: number;
  bill_discount_kind?: "percent" | "amount";
  bill_discount_value?: number;
  service_charge_bp: number;
  service_charge_paise: number;
  packing_charge_paise: number;
  non_gst_subtotal_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  total_paise: number;
  book_total_paise?: number;
  replaces_bill_id?: string;
  rebill_group_id?: string;
};

export type BillLineRow = {
  id: string;
  bill_id: string;
  line_no: number;
  order_line_id?: string;
  item_id: string;
  item_name: string;
  variant_name?: string;
  category_id?: string;
  category_name: string;
  qty_milli: number;
  unit_price_paise: number;
  modifier_delta_paise: number;
  line_discount_paise: number;
  bill_discount_alloc_paise: number;
  net_paise: number;
  comp?: boolean;
  comp_value_paise?: number;
  tax_class: string;
  hsn_sac?: string;
};

export type TaxLineRow = {
  id: string;
  /** bill_id or credit_note_id depending on the owner. */
  owner_id: string;
  tax_class: string;
  rate_bp: number;
  gst_applies: boolean;
  charge_alloc_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
};

export type PaymentRow = {
  id: string;
  bill_id: string;
  target_kind: "bill";
  tender: Tender;
  tender_name?: string;
  amount_paise: number;
  tendered_paise?: number;
  change_paise?: number;
  reference?: string;
  business_date: string;
};

export type PaymentInput = {
  tender: Tender;
  amount_paise: number;
  tendered_paise?: number;
  change_paise?: number;
  tender_name?: string;
  reference?: string;
};

export type CreditNoteRow = {
  id: string;
  number: string;
  series_code: string;
  bill_id: string;
  bill_number: string;
  bill_invoice_date: string;
  reason_code_id?: string;
  rebill_group_id?: string;
  business_date: string;
  invoice_date: string;
  financial_year: string;
  calc_v: number;
  ruleset_id: string;
  total_paise: number;
  round_off_paise: number;
  refund_tender?: RefundTender;
};

export type CreditNoteLineRow = {
  id: string;
  credit_note_id: string;
  line_no: number;
  bill_line_id: string;
  item_name: string;
  qty_milli: number;
  net_paise: number;
  tax_class: string;
};

export type CheckPresentRow = {
  id: string;
  check_id: string;
  present_count: number;
  content_hash: string;
  total_paise: number;
  mode: "printed" | "displayed";
};

export type { Discount, OrderChannel };

export type DocumentErrorCode =
  | "no_open_day"
  | "no_rule_set"
  | "no_rules_for_context"
  | "empty_check"
  | "check_not_open"
  | "discount_over_limit"
  | "payment_exceeds_total"
  | "wrong_financial_year"
  | "not_a_manual_book"
  | "book_number_invalid"
  | "credit_exceeds_original"
  | "nothing_to_credit"
  | "missing_packing_class"
  | "rebill_needs_replacement"
  | "original_not_reproducible"
  | "bill_not_found";

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DocumentError";
  }
}

/** Services the document functions take. All injectable so tests are deterministic. */
export type DocumentDeps = {
  allocator: DocumentNumberAllocator;
  /** Time-sortable id generator (UUIDv7). */
  newId: () => string;
  nowMs: number;
  /** Business days this device knows, to stamp the document. */
  businessDays: ReadonlyArray<{ business_date: string; status: "open" | "closed" }>;
};
