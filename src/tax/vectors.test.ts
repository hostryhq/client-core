import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateBill, calculateCredit } from "./calc";
import { CALC_V, TaxError, type CreditLineInput, type TaxBillInput } from "./types";

type Vector = {
  id: string;
  title: string;
  kind: "bill" | "credit_note";
  invariant?: string;
  input: unknown;
  expected?: Record<string, unknown>;
  expected_error?: string;
  spec_expect?: Record<string, unknown>;
};

// Copied from api-specs tax/conformance/vectors.v1.json (see scripts/sync-tax-vectors.mjs); the Go reference passes the same file.
const file = JSON.parse(readFileSync(new URL("./__vectors__/vectors.v1.json", import.meta.url), "utf8")) as { calc_v: number; cases: Vector[] };

function run(v: Vector) {
  if (v.kind === "bill") return calculateBill(v.input as TaxBillInput);
  const i = v.input as { original: TaxBillInput; credit: CreditLineInput[] };
  return calculateCredit(i.original, i.credit);
}

describe("tax conformance vectors (calc_v 1)", () => {
  it("are for the calc_v this engine implements and have unique ids", () => {
    expect(file.calc_v).toBe(CALC_V);
    expect(new Set(file.cases.map((c) => c.id)).size).toBe(file.cases.length);
    expect(file.cases.length).toBe(64);
  });

  for (const v of file.cases) {
    it(`${v.id} ${v.title}`, () => {
      if (v.expected_error) {
        let err: unknown;
        try {
          run(v);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(TaxError);
        expect((err as TaxError).code).toBe(v.expected_error);
        return;
      }
      const got = run(v);
      expect(got).toEqual(v.expected);
      if (v.invariant === "totals_equal_original") {
        const bill = calculateBill((v.input as { original: TaxBillInput }).original);
        const c = got as ReturnType<typeof calculateCredit>;
        expect([c.total_paise, c.cgst_paise, c.sgst_paise, c.round_off_paise]).toEqual([bill.total_paise, bill.cgst_paise, bill.sgst_paise, bill.round_off_paise]);
      }
      if (v.spec_expect) {
        const m = got as unknown as Record<string, unknown>;
        for (const [k, want] of Object.entries(v.spec_expect)) {
          if (k === "ref") continue;
          if (k === "alloc") expect((m.lines as { bill_discount_alloc_paise: number }[]).map((l) => l.bill_discount_alloc_paise)).toEqual(want);
          else expect(m[k]).toEqual(want);
        }
      }
    });
  }
});
