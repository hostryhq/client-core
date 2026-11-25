import {
  type Discount,
  type Rule,
  type TaxBillInput,
  type TaxBillResult,
  type TaxCreditResult,
  type TaxGroupResult,
  type CreditLineInput,
  type CreditLineResult,
  type TaxLineResult,
  TaxError,
} from "./types";

/*
 * Reference: api-specs tax/README.md and tax/reference/calc.go. Integers only. Intermediate products (value x
 * basis points, discount x net) can pass 2^53 on large bills, so the multiply-divide steps run in BigInt and
 * come back as numbers.
 */

/** a*b/c rounded half up, a,b >= 0, c > 0. */
function mulDivRound(a: number, b: number, c: number): number {
  const C = BigInt(c);
  return Number((2n * BigInt(a) * BigInt(b) + C) / (2n * C));
}

/** floor(a*b/c) and the remainder a*b - floor*c as a bigint, a,b >= 0, c > 0. */
function mulDivFloor(a: number, b: number, c: number): [number, bigint] {
  const p = BigInt(a) * BigInt(b);
  const C = BigInt(c);
  const q = p / C;
  return [Number(q), p - q * C];
}

/** Round half up of a/b for a >= 0, b > 0. */
export function roundHalfUp(a: number, b: number): number {
  return mulDivRound(a, 1, b);
}

/** Largest-remainder split of `total` over `weights`; remainder ties go to the earlier index. Parts sum to `total`. */
export function allocate(total: number, weights: readonly number[]): number[] {
  const out = weights.map(() => 0);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || sum === 0) return out;
  const rem: bigint[] = [];
  let given = 0;
  weights.forEach((w, i) => {
    const [q, r] = mulDivFloor(total, w, sum);
    out[i] = q;
    rem[i] = r;
    given += q;
  });
  const order = weights.map((_, i) => i).sort((a, b) => (rem[b]! > rem[a]! ? 1 : rem[b]! < rem[a]! ? -1 : 0)); // stable
  for (let k = 0; k < total - given; k++) out[order[k]!]! += 1;
  return out;
}

function int(v: unknown, what: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new TaxError("invalid_input", `${what} must be an integer >= ${min}`);
  return v;
}

function checkDiscount(d: Discount | null | undefined, what: string): void {
  if (!d) return;
  if (d.kind !== "percent" && d.kind !== "amount") throw new TaxError("invalid_input", `${what} kind`);
  int(d.value, `${what} value`);
}

function validate(b: TaxBillInput): void {
  if (b.regime !== "regular" && b.regime !== "composition" && b.regime !== "unregistered") throw new TaxError("invalid_input", "regime");
  if (b.price_mode !== "exclusive" && b.price_mode !== "inclusive") throw new TaxError("invalid_input", "price_mode");
  int(b.service_charge_bp ?? 0, "service_charge_bp");
  if (b.packing) int(b.packing.amount_paise, "packing amount");
  checkDiscount(b.bill_discount, "bill_discount");
  for (const l of b.lines) {
    int(l.qty_milli, `qty_milli of ${l.id}`);
    int(l.unit_price_paise, `unit price of ${l.id}`);
    int(l.modifier_delta_paise, `modifier delta of ${l.id}`, Number.MIN_SAFE_INTEGER);
    checkDiscount(l.discount, `discount of ${l.id}`);
  }
}

/** Regime other than regular carries no GST whatever the rows say. An unknown class under `regular` is refused, never taxed at zero. */
function ruleOf(b: TaxBillInput, taxClass: string): Rule {
  if (b.regime !== "regular") return { gst: false, cgst_bp: 0, sgst_bp: 0 };
  const r = b.rules[taxClass];
  if (!r) throw new TaxError("unknown_tax_class", taxClass);
  return r;
}

type CalcLine = { id: string; cls: string; qty: number; value: number; ld: number; alloc: number; net: number };

function discountOf(d: Discount, base: number): number {
  if (d.kind === "percent") {
    if (d.value > 10000) throw new TaxError("discount_exceeds_value");
    return roundHalfUp(base * d.value, 10000);
  }
  return d.value;
}

function calcLines(b: TaxBillInput): { lines: CalcLine[]; billDiscount: number } {
  const lines: CalcLine[] = [];
  let sum = 0;
  for (const l of b.lines) {
    const unit = Math.max(0, l.unit_price_paise + l.modifier_delta_paise); // RM-M3
    const value = mulDivRound(unit, l.qty_milli, 1000);
    let ld = 0;
    if (l.comp) ld = value;
    else if (l.discount) {
      ld = discountOf(l.discount, value);
      if (ld > value) throw new TaxError("discount_exceeds_value");
    }
    lines.push({ id: l.id, cls: l.tax_class, qty: l.qty_milli, value, ld, alloc: 0, net: value - ld });
    sum += value - ld;
  }
  let billDiscount = 0;
  if (b.bill_discount) {
    billDiscount = discountOf(b.bill_discount, sum);
    if (billDiscount > sum) throw new TaxError("discount_exceeds_value");
  }
  const parts = allocate(billDiscount, lines.map((l) => l.net));
  lines.forEach((l, i) => {
    l.alloc = parts[i]!;
    l.net -= parts[i]!;
  });
  return { lines, billDiscount };
}

function taxGroup(b: TaxBillInput, taxClass: string, value: number, charge: number): TaxGroupResult {
  const r = ruleOf(b, taxClass);
  const g: TaxGroupResult = {
    tax_class: taxClass,
    gst_applies: r.gst,
    rate_bp: r.cgst_bp + r.sgst_bp,
    value_paise: value,
    charge_alloc_paise: charge,
    taxable_paise: value,
    cgst_paise: 0,
    sgst_paise: 0,
  };
  if (r.gst) {
    const taxable = b.price_mode === "inclusive" ? mulDivRound(value, 10000, 10000 + r.cgst_bp + r.sgst_bp) : value;
    g.taxable_paise = taxable;
    g.cgst_paise = mulDivRound(taxable, r.cgst_bp, 10000);
    g.sgst_paise = mulDivRound(taxable, r.sgst_bp, 10000);
  }
  return g;
}

type Totals = Pick<TaxCreditResult, "non_gst_subtotal_paise" | "taxable_paise" | "cgst_paise" | "sgst_paise" | "pre_round_total_paise" | "round_off_paise" | "total_paise">;

function totalsOf(b: TaxBillInput, groups: TaxGroupResult[]): Totals {
  let nonGst = 0, taxable = 0, cgst = 0, sgst = 0, gross = 0;
  for (const g of groups) {
    gross += g.value_paise;
    if (g.gst_applies) taxable += g.taxable_paise;
    else nonGst += g.value_paise;
    cgst += g.cgst_paise;
    sgst += g.sgst_paise;
  }
  const pre = b.price_mode === "inclusive" ? gross : nonGst + taxable + cgst + sgst;
  const total = b.round_off ? roundHalfUp(pre, 100) * 100 : pre;
  return {
    non_gst_subtotal_paise: nonGst,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    pre_round_total_paise: pre,
    round_off_paise: total - (nonGst + taxable + cgst + sgst),
    total_paise: total,
  };
}

function buildGroups(b: TaxBillInput, lines: CalcLine[]): { groups: TaxGroupResult[]; service: number; packing: number } {
  const base = lines.reduce((s, l) => s + l.net, 0);
  const service = mulDivRound(base, b.service_charge_bp ?? 0, 10000);
  const classes = new Set(lines.map((l) => l.cls));
  const pack = b.packing && b.packing.amount_paise > 0 ? b.packing : null;
  if (pack) classes.add(pack.tax_class);
  const sorted = [...classes].sort();
  const vals = sorted.map((c) => lines.filter((l) => l.cls === c).reduce((s, l) => s + l.net, 0));
  const share = allocate(service, vals);
  let packing = 0;
  const groups = sorted.map((c, i) => {
    let charge = share[i]!;
    if (pack && pack.tax_class === c) {
      charge += pack.amount_paise;
      packing = pack.amount_paise;
    }
    return taxGroup(b, c, vals[i]! + charge, charge);
  });
  return { groups, service, packing };
}

/** Computes a bill (calc_v 1). Throws TaxError for refused inputs. */
export function calculateBill(b: TaxBillInput): TaxBillResult {
  validate(b);
  const { lines, billDiscount } = calcLines(b);
  const { groups, service, packing } = buildGroups(b, lines);
  const t = totalsOf(b, groups);
  const out: TaxLineResult[] = lines.map((l) => ({
    id: l.id,
    value_paise: l.value,
    line_discount_paise: l.ld,
    bill_discount_alloc_paise: l.alloc,
    net_paise: l.net,
  }));
  return {
    lines: out,
    gross_paise: lines.reduce((s, l) => s + l.value, 0),
    line_discount_paise: lines.reduce((s, l) => s + l.ld, 0),
    bill_discount_paise: billDiscount,
    net_paise: lines.reduce((s, l) => s + l.net, 0),
    service_charge_paise: service,
    packing_paise: packing,
    groups,
    ...t,
  };
}

/**
 * Computes a credit note against the original bill's inputs: a credited line is its value after the original
 * discounts, prorated by quantity; each group's charges are prorated with its credited value.
 */
export function calculateCredit(original: TaxBillInput, credit: readonly CreditLineInput[]): TaxCreditResult {
  validate(original);
  const { lines } = calcLines(original);
  const known = new Set(lines.map((l) => l.id));
  const qty = new Map<string, number>();
  for (const c of credit) {
    if (!known.has(c.line_id)) throw new TaxError("unknown_line", c.line_id);
    qty.set(c.line_id, int(c.qty_milli, "credited qty"));
  }
  const origGroups = buildGroups(original, lines).groups;
  const credited = new Map<string, number>();
  const orig = new Map<string, number>();
  const out: CreditLineResult[] = [];
  let creditedNet = 0;
  for (const l of lines) {
    const q = qty.get(l.id) ?? 0;
    if (q > l.qty) throw new TaxError("credit_exceeds_original", l.id);
    const cn = q > 0 ? mulDivRound(l.net, q, l.qty) : 0;
    out.push({ id: l.id, credited_qty_milli: q, credited_net_paise: cn });
    creditedNet += cn;
    credited.set(l.cls, (credited.get(l.cls) ?? 0) + cn);
    orig.set(l.cls, (orig.get(l.cls) ?? 0) + l.net);
  }
  const groups = origGroups.map((g) => {
    const o = orig.get(g.tax_class) ?? 0;
    const c = credited.get(g.tax_class) ?? 0;
    const cc = o > 0 ? mulDivRound(g.charge_alloc_paise, c, o) : 0;
    return taxGroup(original, g.tax_class, c + cc, cc);
  });
  return { lines: out, credited_net_paise: creditedNet, groups, ...totalsOf(original, groups) };
}
