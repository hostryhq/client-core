import {
  CALC_V,
  calculateBill,
  resolveRules,
  ruleSetInForce,
  type DocKind,
  type Discount,
  type OrderChannel,
  type TaxBillInput,
  type TaxBillResult,
} from "../tax";
import { DocumentError, type BillableLine, type CheckHeader, type OutletBillingContext } from "./types";

export type Computation = {
  input: TaxBillInput;
  result: TaxBillResult;
  docType: DocKind;
  rulesetId: string;
  channel: OrderChannel;
  serviceChargeBp: number;
  billDiscount?: Discount;
};

export function channelOf(h: Pick<CheckHeader, "order_type" | "eco_channel">): OrderChannel {
  return h.eco_channel ? "eco" : h.order_type;
}

function lineDiscount(l: BillableLine): Discount | undefined {
  return l.discount_kind && l.discount_value !== undefined ? { kind: l.discount_kind, value: l.discount_value } : undefined;
}

/** Service charge rate that applies to this check: the outlet rate, if enabled for the order type and not removed. */
export function serviceChargeBpFor(ctx: OutletBillingContext, h: CheckHeader): number {
  const s = ctx.settings;
  const enabled = h.order_type === "dine_in" ? s.service_charge_dine_in : h.order_type === "takeaway" ? s.service_charge_takeaway : s.service_charge_counter;
  return enabled && !h.service_charge_removed ? s.service_charge_bp : 0;
}

/**
 * The one calculation both the pre-bill estimate and the finalised bill use. The rule set in force on the IST
 * invoice date is chosen from those held on the device; rates come only from it. Throws TaxError for refused
 * inputs and DocumentError when the device holds no rule set or no rows for the context (it must not guess a rate).
 */
export function computeCheck(ctx: OutletBillingContext, header: CheckHeader, lines: readonly BillableLine[], invoiceDate: string): Computation {
  if (lines.length === 0) throw new DocumentError("empty_check");
  const rs = ruleSetInForce(
    ctx.ruleSets.map((r) => ({ ...r, effective_date: r.doc.effective_date })),
    invoiceDate,
  );
  if (!rs) throw new DocumentError("no_rule_set", invoiceDate);
  const channel = channelOf(header);
  const resolved = resolveRules(rs.doc, { regime: ctx.regime, specifiedPremises: ctx.specifiedPremises, channel });
  if (!resolved) throw new DocumentError("no_rules_for_context", `${ctx.regime}/${channel}`);

  const billDiscount: Discount | undefined =
    header.discount_kind && header.discount_value !== undefined ? { kind: header.discount_kind, value: header.discount_value } : undefined;
  const bp = serviceChargeBpFor(ctx, header);
  const s = ctx.settings;
  const packing = header.order_type === "takeaway" && !header.packing_charge_removed && s.packing_charge_paise > 0 ? { amount_paise: s.packing_charge_paise, tax_class: s.packing_tax_class } : null;

  const input: TaxBillInput = {
    regime: ctx.regime,
    price_mode: s.price_mode,
    round_off: s.round_off,
    rules: resolved.rules,
    lines: lines.map((l) => ({
      id: l.id,
      qty_milli: l.qty_milli,
      unit_price_paise: l.unit_price_paise,
      modifier_delta_paise: l.modifier_delta_paise,
      tax_class: l.tax_class,
      discount: lineDiscount(l) ?? null,
      comp: l.comp === true,
    })),
    bill_discount: billDiscount ?? null,
    service_charge_bp: bp,
    packing,
  };
  const out: Computation = { input, result: calculateBill(input), docType: resolved.docType, rulesetId: rs.id, channel, serviceChargeBp: bp };
  if (billDiscount) out.billDiscount = billDiscount;
  return out;
}

/** CALC_V stamped on every document this engine produces. */
export const CALC_VERSION = CALC_V;
