import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocate, calculateBill, roundHalfUp } from "./calc";
import { loadRuleSet, resolveRules, RuleSetError, ruleSetInForce, validateRuleSet, type RuleSetDoc } from "./ruleset";
import { TaxError } from "./types";

// The api-specs example draft (YAML there, JSON here); validates against rule-set.schema.yaml.
const draft = JSON.parse(readFileSync(new URL("./__vectors__/draft-unreviewed.v1.json", import.meta.url), "utf8")) as RuleSetDoc;
const clone = () => structuredClone(draft) as RuleSetDoc;

describe("rule set validation", () => {
  it("accepts the example draft", () => {
    expect(validateRuleSet(draft)).toEqual([]);
    expect(loadRuleSet(draft).rules).toHaveLength(11);
  });

  it("refuses what the schema and the regime rules refuse, listing every problem", () => {
    const d = clone();
    d.calc_v = 2;
    d.effective_date = "2027-02-30";
    d.rules[0]!.cgst_bp = 300; // sgst differs
    d.rules[1]!.igst_bp = 100;
    d.rules[2]!.tax_class = "Bad Class";
    (d.rules[3] as unknown as Record<string, unknown>).rate = 5;
    d.rules.push({ ...d.rules[4]! }); // duplicate key
    const p = validateRuleSet(d);
    expect(p.join("\n")).toMatch(/calc_v 2 is not supported/);
    expect(p.join("\n")).toMatch(/effective_date/);
    expect(p.join("\n")).toMatch(/sgst_bp must equal cgst_bp/);
    expect(p.join("\n")).toMatch(/igst_bp must be 0/);
    expect(p.join("\n")).toMatch(/not a valid class key/);
    expect(p.join("\n")).toMatch(/rate is not allowed/);
    expect(p.join("\n")).toMatch(/duplicates/);
    expect(() => loadRuleSet(d)).toThrow(RuleSetError);
  });

  it("a non-GST row has zero rates, composition cannot charge GST, doc type follows the regime", () => {
    const d = clone();
    d.rules[2]!.cgst_bp = 250;
    d.rules[2]!.sgst_bp = 250; // fnb_non_gst with rates
    d.rules[9]!.gst_applies = true;
    d.rules[10]!.doc_type = "tax_invoice";
    const p = validateRuleSet(d).join("\n");
    expect(p).toMatch(/gst_applies false must have zero rates/);
    expect(p).toMatch(/cannot charge GST/);
    expect(p).toMatch(/doc_type must be plain_bill/);
  });

  it("rejects non-objects and empty rule lists", () => {
    expect(validateRuleSet(null)).toHaveLength(1);
    expect(validateRuleSet({ ...draft, rules: [] }).join()).toMatch(/non-empty/);
  });
});

describe("rule selection", () => {
  it("picks rows by regime, specified premises and channel; rates come only from data", () => {
    const low = resolveRules(draft, { regime: "regular", specifiedPremises: false, channel: "dine_in" })!;
    const high = resolveRules(draft, { regime: "regular", specifiedPremises: true, channel: "dine_in" })!;
    expect([low.rules.fnb_standard, high.rules.fnb_standard]).toEqual([{ gst: true, cgst_bp: 250, sgst_bp: 250 }, { gst: true, cgst_bp: 900, sgst_bp: 900 }]);
    expect(low.docType).toBe("tax_invoice");
    expect(resolveRules(draft, { regime: "composition", specifiedPremises: false, channel: "dine_in" })!.docType).toBe("bill_of_supply");
    expect(resolveRules(draft, { regime: "regular", specifiedPremises: false, channel: "eco" })!.rules.fnb_standard!.gst).toBe(false);
  });
  it("returns nothing when the set has no rows for the context", () => {
    expect(resolveRules(draft, { regime: "unregistered", specifiedPremises: true, channel: "counter" })).toBeUndefined();
  });
  it("chooses the latest set not after the invoice date", () => {
    const sets = [{ effective_date: "2026-04-01", n: 1 }, { effective_date: "2026-12-01", n: 2 }, { effective_date: "2025-04-01", n: 0 }];
    expect(ruleSetInForce(sets, "2026-11-30")?.n).toBe(1);
    expect(ruleSetInForce(sets, "2026-12-01")?.n).toBe(2);
    expect(ruleSetInForce(sets, "2025-01-01")).toBeUndefined();
  });
});

describe("calculation beyond the vectors", () => {
  const rules = { c: { gst: true, cgst_bp: 250, sgst_bp: 250 } };
  const base = { regime: "regular" as const, price_mode: "exclusive" as const, round_off: false, rules };

  it("stays exact when products pass 2^53 (large bill, bill discount allocation)", () => {
    const lines = [1, 2, 3].map((i) => ({ id: String(i), qty_milli: 1000, unit_price_paise: 3_000_000_000 + i, modifier_delta_paise: 0, tax_class: "c" }));
    const r = calculateBill({ ...base, lines, bill_discount: { kind: "amount", value: 2_000_000_001 } });
    expect(r.lines.reduce((s, l) => s + l.bill_discount_alloc_paise, 0)).toBe(2_000_000_001);
    expect(r.net_paise).toBe(9_000_000_006 - 2_000_000_001);
  });

  it("allocates by largest remainder with ties to the earlier line, parts summing to the total", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
    expect(roundHalfUp(5, 2)).toBe(3);
    expect(roundHalfUp(4, 2)).toBe(2);
  });

  it("refuses a class missing from the rule set under the regular regime instead of taxing it at zero", () => {
    expect(() => calculateBill({ ...base, lines: [{ id: "a", qty_milli: 1000, unit_price_paise: 100, modifier_delta_paise: 0, tax_class: "nope" }] })).toThrow(TaxError);
  });

  it("refuses non-integer or negative inputs", () => {
    const l = { id: "a", qty_milli: 1000, unit_price_paise: 100, modifier_delta_paise: 0, tax_class: "c" };
    expect(() => calculateBill({ ...base, lines: [{ ...l, unit_price_paise: 10.5 }] })).toThrow(/invalid_input/);
    expect(() => calculateBill({ ...base, lines: [{ ...l, qty_milli: -1 }] })).toThrow(/invalid_input/);
    expect(() => calculateBill({ ...base, lines: [l], service_charge_bp: 1.5 })).toThrow(/invalid_input/);
  });
});
