/**
 * Tax calculation calc_v 1 (api-specs tax/README.md). Field names are the contract's (snake_case) so inputs and
 * outputs are the vector shapes and the bill/credit-note entity rows without renaming.
 * Integers only: amounts in paise, quantities in thousandths of a unit, rates in basis points.
 */

export const CALC_V = 1;

export type Regime = "regular" | "composition" | "unregistered";
export type PriceMode = "exclusive" | "inclusive";
export type OrderChannel = "dine_in" | "takeaway" | "counter" | "eco";
export type DocKind = "tax_invoice" | "bill_of_supply" | "plain_bill";

/** The rate row selected from the rule set for a tax class. */
export type Rule = { gst: boolean; cgst_bp: number; sgst_bp: number };

/** Line or bill discount: percent in basis points, or amount in paise. */
export type Discount = { kind: "percent" | "amount"; value: number };

export type TaxLineInput = {
  id: string;
  qty_milli: number;
  unit_price_paise: number;
  modifier_delta_paise: number;
  tax_class: string;
  discount?: Discount | null;
  comp?: boolean;
};

export type Packing = { amount_paise: number; tax_class: string };

export type TaxBillInput = {
  regime: Regime;
  price_mode: PriceMode;
  round_off: boolean;
  rules: Record<string, Rule>;
  lines: TaxLineInput[];
  bill_discount?: Discount | null;
  service_charge_bp?: number;
  packing?: Packing | null;
};

export type TaxLineResult = {
  id: string;
  value_paise: number;
  line_discount_paise: number;
  bill_discount_alloc_paise: number;
  net_paise: number;
};

export type TaxGroupResult = {
  tax_class: string;
  gst_applies: boolean;
  rate_bp: number;
  value_paise: number;
  charge_alloc_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
};

export type TaxBillResult = {
  lines: TaxLineResult[];
  gross_paise: number;
  line_discount_paise: number;
  bill_discount_paise: number;
  net_paise: number;
  service_charge_paise: number;
  packing_paise: number;
  groups: TaxGroupResult[];
  non_gst_subtotal_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  pre_round_total_paise: number;
  round_off_paise: number;
  total_paise: number;
};

export type CreditLineInput = { line_id: string; qty_milli: number };

export type CreditLineResult = { id: string; credited_qty_milli: number; credited_net_paise: number };

export type TaxCreditResult = {
  lines: CreditLineResult[];
  credited_net_paise: number;
  groups: TaxGroupResult[];
  non_gst_subtotal_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  pre_round_total_paise: number;
  round_off_paise: number;
  total_paise: number;
};

/** Codes for inputs the calculation refuses. The first three are the vectors' expected_error values. */
export type TaxErrorCode =
  | "discount_exceeds_value"
  | "credit_exceeds_original"
  | "unknown_line"
  | "invalid_input"
  | "unknown_tax_class";

export class TaxError extends Error {
  constructor(
    readonly code: TaxErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TaxError";
  }
}
