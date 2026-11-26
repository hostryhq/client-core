import { describe, expect, it } from "vitest";
import { GENERIC_80, LABELS_EN, layoutDocument, type LayoutContext } from "../printing";
import { TaxError } from "../tax";
import { issueCreditNote, rebill, taxInputOfBill, type OriginalBill } from "./credit";
import { finalizeBill, manualBookEntry, presentCheck, triggerForPresent } from "./finalize";
import { ctx, deps, DINE_IN, line, NOW_MS } from "./fixtures";
import { billMutations, rebillApprovedMutations, rebillMutations } from "./mutations";
import { boundValues } from "../ops";
import { toBillDoc, toCreditNoteDoc } from "./print";
import { DocumentError } from "./types";
import { calculateBill } from "../tax";

const LC: LayoutContext = { profile: GENERIC_80, labels: LABELS_EN, canRaster: () => false };
const two = [line("a"), line("b", { qty_milli: 2000, unit_price_paise: 5000 })]; // gross 20000, 5% = 500 + 500

function original(over = {}): OriginalBill {
  const f = finalizeBill(deps(), ctx(), DINE_IN, two, over);
  return { bill: f.bill, lines: f.lines, taxLines: f.taxLines };
}

describe("finalizeBill (bill.finalize)", () => {
  it("builds the complete bill from one calculation and takes one number", () => {
    const d = deps();
    const f = finalizeBill(d, ctx(), DINE_IN, two, { payments: [{ tender: "cash", amount_paise: 21000, tendered_paise: 50000, change_paise: 29000 }] });
    expect(f.bill).toMatchObject({
      number: "A07/2627/000001",
      series_code: "A07",
      doc_type: "tax_invoice",
      source_kind: "check",
      check_id: "check-1",
      business_date: "2026-11-24",
      invoice_date: "2026-11-24",
      financial_year: "2627",
      calc_v: 1,
      ruleset_id: "rs-1",
      gross_paise: 20000,
      taxable_paise: 20000,
      cgst_paise: 500,
      sgst_paise: 500,
      igst_paise: 0,
      total_paise: 21000,
    });
    expect(f.lines.map((l) => [l.line_no, l.order_line_id, l.net_paise])).toEqual([[1, "a", 10000], [2, "b", 10000]]);
    expect(f.taxLines).toHaveLength(1);
    expect(f.checkUpdate).toEqual({ id: "check-1", status: "billed", bill_id: f.bill.id });
    expect(f.payments[0]).toMatchObject({ tender: "cash", amount_paise: 21000, change_paise: 29000 });
    expect(d.allocator.issued).toEqual(["A07/2627/000001"]);
  });

  it("is a counter sale without a stored check: no check update, source counter", () => {
    const f = finalizeBill(deps(), ctx(), { order_type: "counter" }, two);
    expect(f.bill.source_kind).toBe("counter");
    expect(f.bill.check_id).toBeUndefined();
    expect(f.checkUpdate).toBeUndefined();
  });

  it("refuses without taking a number: empty check, bad discount, closed check, no open day, no rule set, unknown tax class", () => {
    const d = deps();
    expect(() => finalizeBill(d, ctx(), DINE_IN, [])).toThrow(DocumentError);
    expect(() => finalizeBill(d, ctx(), DINE_IN, [line("a", { discount_kind: "amount", discount_value: 10001 })])).toThrow(TaxError);
    expect(() => finalizeBill(d, ctx(), { ...DINE_IN, status: "billed" }, two)).toThrow(/check_not_open/);
    expect(() => finalizeBill(deps({ businessDays: [{ business_date: "2026-11-23", status: "closed" }] }), ctx(), DINE_IN, two)).toThrow(/no_open_day/);
    expect(() => finalizeBill(d, ctx({}, { ruleSets: [] }), DINE_IN, two)).toThrow(/no_rule_set/);
    expect(() => finalizeBill(d, ctx(), DINE_IN, [line("a", { tax_class: "mystery" })])).toThrow(/unknown_tax_class/);
    expect(d.allocator.issued).toEqual([]);
  });

  it("stamps the open day with the latest date and keeps the invoice date separate (IST midnight)", () => {
    const lateNight = Date.parse("2026-11-24T19:00:00Z"); // 00:30 IST on the 25th, the 24th's day still open
    const f = finalizeBill(deps({ nowMs: lateNight }), ctx(), DINE_IN, two);
    expect([f.bill.business_date, f.bill.invoice_date]).toEqual(["2026-11-24", "2026-11-25"]);
  });

  it("takes the financial year from the IST invoice date (31 March night is still FY 26-27)", () => {
    const d = deps({ nowMs: Date.parse("2027-03-31T20:00:00Z"), businessDays: [{ business_date: "2027-03-31", status: "open" }] }); // 01:30 IST 1 April = FY 27-28
    const f = finalizeBill(d, ctx(), DINE_IN, two);
    expect([f.bill.invoice_date, f.bill.financial_year, f.bill.number]).toEqual(["2027-04-01", "2728", "A07/2728/000001"]);
  });

  it("enforces the cashier discount limit unless approved", () => {
    const h = { ...DINE_IN, discount_kind: "percent" as const, discount_value: 1500 };
    expect(() => finalizeBill(deps(), ctx(), h, two)).toThrow(/discount_over_limit/);
    const f = finalizeBill(deps(), ctx(), h, two, { discountApproved: true });
    expect(f.bill).toMatchObject({ bill_discount_kind: "percent", bill_discount_value: 1500, discount_paise: 3000 });
    expect(() => finalizeBill(deps(), ctx(), { ...DINE_IN, discount_kind: "percent", discount_value: 1000 }, two)).not.toThrow(); // at the limit
  });

  it("a complimentary line is a discount of its whole value and is marked", () => {
    const f = finalizeBill(deps(), ctx(), DINE_IN, [line("a"), line("b", { comp: true })]);
    expect(f.lines[1]).toMatchObject({ comp: true, comp_value_paise: 10000, line_discount_paise: 10000, net_paise: 0 });
    expect(f.bill.total_paise).toBe(10500);
  });

  it("applies service charge by order type and removal, and packing on takeaway only", () => {
    const s = { service_charge_bp: 1000, packing_charge_paise: 500 };
    expect(finalizeBill(deps(), ctx(s), DINE_IN, two).bill.service_charge_paise).toBe(2000);
    expect(finalizeBill(deps(), ctx(s), { ...DINE_IN, service_charge_removed: true }, two).bill.service_charge_paise).toBe(0);
    expect(finalizeBill(deps(), ctx(s), { order_type: "counter" }, two).bill.service_charge_paise).toBe(0);
    const t = finalizeBill(deps(), ctx(s), { order_type: "takeaway" }, two).bill;
    expect([t.packing_charge_paise, t.service_charge_paise]).toEqual([500, 2000]);
    expect(finalizeBill(deps(), ctx(s), DINE_IN, two).bill.packing_charge_paise).toBe(0);
  });

  it("uses the eco rows for an aggregator order, and bill of supply for a composition outlet", () => {
    expect(finalizeBill(deps(), ctx(), { order_type: "counter", eco_channel: "swiggy" }, two).bill).toMatchObject({ eco: true, cgst_paise: 0, total_paise: 20000 });
    const c = finalizeBill(deps(), ctx({}, { regime: "composition" }), DINE_IN, two).bill;
    expect([c.doc_type, c.cgst_paise, c.total_paise]).toEqual(["bill_of_supply", 0, 20000]);
  });

  it("selects the rule set in force on the invoice date", () => {
    const old = { id: "rs-old", doc: { ...ctx().ruleSets[0]!.doc, effective_date: "2026-01-01" } };
    const next = { id: "rs-next", doc: { ...ctx().ruleSets[0]!.doc, effective_date: "2026-12-01" } };
    expect(finalizeBill(deps(), ctx({}, { ruleSets: [next, old] }), DINE_IN, two).bill.ruleset_id).toBe("rs-old");
  });

  it("numbers gaplessly per series across bills", () => {
    const d = deps();
    const nums = [1, 2, 3].map(() => finalizeBill(d, ctx(), DINE_IN, two).bill.number);
    expect(nums).toEqual(["A07/2627/000001", "A07/2627/000002", "A07/2627/000003"]);
  });

  it("the stored bill reproduces to the paisa from its own rows", () => {
    const o = original();
    expect(taxInputOfBill(o, ctx().settings).lines).toHaveLength(2);
    expect(calculateBill(taxInputOfBill(o, ctx().settings)).total_paise).toBe(o.bill.total_paise);
  });
});

describe("present (pre-bill) and number_at", () => {
  it("makes an unnumbered, recorded pre-bill with a tax estimate and takes no number", () => {
    const d = deps();
    const p = presentCheck(ctx(), { ...DINE_IN, id: "check-1" }, two, { presentCount: 1, mode: "printed", nowMs: NOW_MS, newId: d.newId, businessName: "Anand Bhavan", tableLabel: "T6" });
    expect(p.row).toMatchObject({ check_id: "check-1", present_count: 1, total_paise: 21000, mode: "printed" });
    expect(p.row.content_hash).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(p.doc).toMatchObject({ kind: "pre_bill", sequence: 1, subtotal: 20000, total: 21000 });
    expect(p.doc.estimatedTaxes).toEqual([{ label: "CGST 2.5%", amount: 500 }, { label: "SGST 2.5%", amount: 500 }]);
    expect("number" in p.doc).toBe(false);
    expect(d.allocator.issued).toEqual([]);
    const text = JSON.stringify(layoutDocument(p.doc, LC));
    expect(text).toContain("NOT A TAX INVOICE");
  });

  it("content hash changes when what the guest saw changes", () => {
    const d = deps();
    const mk = (ls: typeof two) => presentCheck(ctx(), { ...DINE_IN, id: "check-1" }, ls, { presentCount: 1, mode: "displayed", nowMs: NOW_MS, newId: d.newId, businessName: "X" }).row.content_hash;
    expect(mk(two)).toBe(mk([...two]));
    expect(mk(two)).not.toBe(mk([...two, line("c")]));
  });

  it("settle outlets record a pre-bill when shown; print outlets finalise at the first print", () => {
    expect(triggerForPresent("settle")).toBe("pre_bill");
    expect(triggerForPresent("print")).toBe("finalize");
  });

  it("inclusive price outlets show the menu price as the total and no separate estimate rows", () => {
    const d = deps();
    const p = presentCheck(ctx({ price_mode: "inclusive" }), { ...DINE_IN, id: "check-1" }, [line("a", { unit_price_paise: 10500 })], { presentCount: 1, mode: "printed", nowMs: NOW_MS, newId: d.newId, businessName: "X" });
    expect([p.doc.total, p.doc.estimatedTaxes]).toEqual([10500, []]);
  });
});

describe("manual bill-book entry", () => {
  const entry = { number: "MB1/2627/000042", invoiceDate: "2026-11-23", bookTotalPaise: 21000, header: { order_type: "dine_in" as const }, lines: two };

  it("keeps the book's number, allocates nothing, and converges on one id for the same page", () => {
    const d1 = deps();
    const a = manualBookEntry(d1, ctx(), entry);
    const b = manualBookEntry(deps(), ctx(), entry);
    expect(a.bill).toMatchObject({ number: "MB1/2627/000042", source_kind: "manual_book", invoice_date: "2026-11-23", business_date: "2026-11-24", book_total_paise: 21000 });
    expect(a.bill.check_id).toBeUndefined();
    expect(a.bill.id).toBe(b.bill.id);
    expect(a.matchesBook).toBe(true);
    expect(d1.allocator.issued).toEqual([]);
  });

  it("reports a difference from the book total without changing the computed bill", () => {
    const r = manualBookEntry(deps(), ctx(), { ...entry, bookTotalPaise: 21500 });
    expect([r.matchesBook, r.bill.total_paise, r.bill.book_total_paise]).toEqual([false, 21000, 21500]);
  });

  it("refuses a series that is not a registered book, a malformed number, and a number whose FY does not match the page date", () => {
    expect(() => manualBookEntry(deps(), ctx(), { ...entry, number: "A07/2627/000042" })).toThrow(/not_a_manual_book/);
    expect(() => manualBookEntry(deps(), ctx(), { ...entry, number: "42" })).toThrow(/book_number_invalid/);
    expect(() => manualBookEntry(deps(), ctx(), { ...entry, invoiceDate: "2027-04-02" })).toThrow(/wrong_financial_year/);
  });
});

describe("credit notes", () => {
  it("a full credit note equals the bill to the paisa and cites it", () => {
    const o = original();
    const d = deps({ allocator: deps().allocator });
    const r = issueCreditNote(d, ctx(), o, { lines: o.lines.map((l) => ({ bill_line_id: l.id, qty_milli: l.qty_milli })), reasonCodeId: "reason-1", refundTender: "cash" });
    expect(r.note).toMatchObject({ number: "C07/2627/000001", bill_id: o.bill.id, bill_number: o.bill.number, bill_invoice_date: "2026-11-24", total_paise: 21000, round_off_paise: 0, calc_v: 1, ruleset_id: "rs-1" });
    expect(r.taxLines[0]).toMatchObject({ taxable_paise: 20000, cgst_paise: 500, sgst_paise: 500 });
    expect(r.lines.map((l) => l.net_paise)).toEqual([10000, 10000]);
  });

  it("credits part of a line, and refuses more than was billed including earlier credits", () => {
    const o = original();
    const l = o.lines[1]!; // qty 2
    const part = issueCreditNote(deps(), ctx(), o, { lines: [{ bill_line_id: l.id, qty_milli: 1000 }] });
    expect(part.lines[0]).toMatchObject({ qty_milli: 1000, net_paise: 5000 });
    expect(part.note.total_paise).toBe(5250);
    expect(() => issueCreditNote(deps(), ctx(), o, { lines: [{ bill_line_id: l.id, qty_milli: 1500 }], previousCredited: { [l.id]: 1000 } })).toThrow(/credit_exceeds_original/);
    expect(() => issueCreditNote(deps(), ctx(), o, { lines: [{ bill_line_id: "nope", qty_milli: 1 }] })).toThrow(/unknown_line/);
    expect(() => issueCreditNote(deps(), ctx(), o, { lines: [] })).toThrow(/nothing_to_credit/);
  });

  it("reverses discounts, service charge and round-off exactly (full credit of a discounted, charged, rounded bill)", () => {
    const s = { service_charge_bp: 1000, round_off: true };
    const h = { ...DINE_IN, discount_kind: "percent" as const, discount_value: 500 };
    const f = finalizeBill(deps(), ctx(s), h, [line("a", { unit_price_paise: 3333, qty_milli: 3000 }), line("b", { unit_price_paise: 4999, tax_class: "fnb_non_gst" })]);
    const o: OriginalBill = { bill: f.bill, lines: f.lines, taxLines: f.taxLines };
    const r = issueCreditNote(deps(), ctx(s), o, { lines: o.lines.map((l) => ({ bill_line_id: l.id, qty_milli: l.qty_milli })) });
    expect([r.note.total_paise, r.note.round_off_paise]).toEqual([f.bill.total_paise, f.bill.round_off_paise]);
    expect(r.taxLines.reduce((s2, t) => s2 + t.cgst_paise, 0)).toBe(f.bill.cgst_paise);
  });

  it("refuses to credit a bill the engine cannot reproduce", () => {
    const o = original();
    const tampered: OriginalBill = { ...o, bill: { ...o.bill, total_paise: o.bill.total_paise + 1 } };
    expect(() => issueCreditNote(deps(), ctx(), tampered, { lines: [{ bill_line_id: o.lines[0]!.id, qty_milli: 1000 }] })).toThrow(/original_not_reproducible/);
  });

  it("takes no credit-note number when the request is refused", () => {
    const o = original();
    const d = deps();
    expect(() => issueCreditNote(d, ctx(), o, { lines: [{ bill_line_id: o.lines[0]!.id, qty_milli: 9999 }] })).toThrow();
    expect(d.allocator.issued).toEqual([]);
  });
});

describe("re-bill", () => {
  it("is one op: a full credit note and the replacement bills share a group and take numbers in order", () => {
    const o = original();
    const d = deps();
    const withGstin = { order_type: "dine_in" as const, customer_gstin: "33AAAAA0000A1Z5", id: "check-1" };
    const r = rebill(d, ctx(), o, [{ header: withGstin, lines: two }], { reasonCodeId: "r1" });
    expect(d.allocator.issued).toEqual(["C07/2627/000001", "A07/2627/000001"]);
    expect(r.credit.note).toMatchObject({ rebill_group_id: r.rebillGroupId, total_paise: 21000 });
    expect(r.bills[0]!.bill).toMatchObject({ replaces_bill_id: o.bill.id, rebill_group_id: r.rebillGroupId, customer_gstin: "33AAAAA0000A1Z5", total_paise: 21000 });
    expect(r.bills[0]!.checkUpdate).toBeUndefined();
    const kinds = rebillMutations(r).map((m) => m.e);
    expect(kinds.filter((k) => k === "credit_note")).toHaveLength(1);
    expect(kinds.filter((k) => k === "bill")).toHaveLength(1);
  });

  it("bill.rebill.approved records every value its approval binds, the credit note row first (the approval's target)", () => {
    const o = original();
    const r = rebill(deps(), ctx(), o, [{ header: { order_type: "dine_in" as const, id: "check-1" }, lines: two }], { reasonCodeId: "r1" });
    const muts = rebillApprovedMutations(r);
    expect(muts[0]).toMatchObject({ e: "credit_note", id: r.credit.note.id, k: "insert" });
    const { values, missing } = boundValues("bill.rebill.approved", muts);
    expect(missing).toEqual([]);
    expect(values).toEqual({ bill_id: o.bill.id, rebill_group_id: r.rebillGroupId, total_paise: r.credit.note.total_paise, replacement_total_paise: r.bills.reduce((s, b) => s + b.bill.total_paise, 0) });
    // the plain re-bill does not record the derived sum
    expect(boundValues("bill.rebill.approved", rebillMutations(r)).missing).toEqual(["replacement_total_paise"]);
  });

  it("a split makes two bills; a bad replacement refuses everything before any number is taken", () => {
    const o = original();
    const d = deps();
    const bad = { header: { order_type: "dine_in" as const }, lines: [line("x", { discount_kind: "amount", discount_value: 999999 })] };
    expect(() => rebill(d, ctx(), o, [{ header: { order_type: "dine_in" }, lines: [two[0]!] }, bad])).toThrow(TaxError);
    expect(d.allocator.issued).toEqual([]);
    const ok = rebill(d, ctx(), o, [{ header: { order_type: "dine_in" }, lines: [two[0]!] }, { header: { order_type: "dine_in" }, lines: [two[1]!] }]);
    expect(ok.bills.map((b) => b.bill.total_paise)).toEqual([10500, 10500]);
    expect(() => rebill(d, ctx(), o, [])).toThrow(/rebill_needs_replacement/);
  });
});

describe("print mapping", () => {
  it("maps a paid bill to the print model with figures unchanged and a drawer kick for cash", () => {
    const f = finalizeBill(deps(), ctx({ service_charge_bp: 1000 }), { ...DINE_IN, customer_name: "Sea Foods Ltd" }, two, { payments: [{ tender: "cash", amount_paise: 23100, tendered_paise: 50000, change_paise: 26900 }, ] });
    const doc = toBillDoc(f.bill, f.lines, f.taxLines, f.payments, { business: { name: "Anand Bhavan" }, issuedAt: "2026-11-24T07:35:00Z", tableLabel: "T6" });
    expect(doc).toMatchObject({ variant: "tax_invoice", number: f.bill.number, subtotal: 20000, serviceCharge: 2000, total: 23100, change: 26900, openDrawer: true, reverseCharge: false, orderType: "Dine-in", guest: { name: "Sea Foods Ltd" } });
    expect(doc.taxGroups).toEqual([{ rateLabel: "5%", taxable: 22000, taxes: [{ label: "CGST 2.5%", amount: 550 }, { label: "SGST 2.5%", amount: 550 }] }]);
    expect(doc.lines.map((l) => [l.qty, l.rate, l.amount])).toEqual([[1, 10000, 10000], [2, 5000, 10000]]);
    expect(layoutDocument(doc, LC).length).toBeGreaterThan(5);
  });

  it("shows the discount at line value so the printed bill adds up, and omits GST groups for a bill of supply", () => {
    const f = finalizeBill(deps(), ctx({}, { regime: "composition" }), { ...DINE_IN, discount_kind: "amount", discount_value: 1000 }, two);
    const doc = toBillDoc(f.bill, f.lines, f.taxLines, [], { business: { name: "X" }, issuedAt: "2026-11-24T07:35:00Z" });
    expect(doc.variant).toBe("bill_of_supply");
    expect(doc.taxGroups).toEqual([]);
    expect(doc.lines.reduce((s, l) => s + l.amount, 0) - (doc.discount?.amount ?? 0)).toBe(doc.total);
  });

  it("maps a credit note citing the original", () => {
    const o = original();
    const r = issueCreditNote(deps(), ctx(), o, { lines: [{ bill_line_id: o.lines[0]!.id, qty_milli: 1000 }] });
    const doc = toCreditNoteDoc(r.note, r.lines, r.taxLines, { business: { name: "X" }, issuedAt: "2026-11-24T07:35:00Z", refundMode: "Cash", reason: "Wrong item" });
    expect(doc).toMatchObject({ kind: "credit_note", originalNumber: o.bill.number, total: 10500 });
    expect(layoutDocument(doc, LC).length).toBeGreaterThan(5);
  });
});

describe("sync mutations", () => {
  it("bill.finalize writes bill, lines, tax lines, payments, and moves the check to billed", () => {
    const f = finalizeBill(deps(), ctx(), DINE_IN, two, { payments: [{ tender: "upi", amount_paise: 21000 }] });
    const m = billMutations(f);
    expect(m.map((x) => `${x.e}:${x.k}`)).toEqual(["bill:insert", "bill_line:insert", "bill_line:insert", "bill_tax_line:insert", "payment:insert", "check:rank", "check:set"]);
    expect(m[0]!.f).not.toHaveProperty("id");
    expect(m[3]!.f).toMatchObject({ bill_id: f.bill.id, tax_class: "fnb_standard" });
  });
});
