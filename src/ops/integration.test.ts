import { describe, expect, it } from "vitest";
import type { OrderLineDraft } from "../catalog";
import type { BillableLine } from "../documents";
import { ctx as outletCtx, DINE_IN, line } from "../documents/fixtures";
import type { Row } from "../store";
import { restaurantRegistry, seriesGaps, type OpEnvelope } from "../sync";
import { makeWorld, type Device, type World } from "../sync/testkit/harness";
import { availabilitySpec, orderLineAddSpec, orderLineQtySpec, priceSetSpec } from "./catalog";
import { creditNoteSpec, finalizeBillSpec, presentSpec, rebillSpec, type DocumentEnv } from "./documents";
import { IntentError } from "./intents";
import { EngineOpWriter } from "./writer";

const ENV: DocumentEnv = { outlet: outletCtx(), businessDays: [{ business_date: "2026-11-24", status: "open" }] };
const sale = (code: string) => [
  { code, docType: "tax_invoice", state: "active" },
  { code, docType: "credit_note", state: "active" },
] as const;

type Till = Device & { w: EngineOpWriter };
const till = async (w: World, id: string, code?: string): Promise<Till> => {
  const d = await w.addDevice(id, { schemas: restaurantRegistry(), grants: code ? [...sale(code)] : [] });
  return Object.assign(d, { w: new EngineOpWriter(d.engine) });
};
const offline = (...ds: Device[]): void => ds.forEach((d) => ((d.hubLink.up = false), (d.cloudLink.up = false)));

const draft = (n: string, qty: number, price: number): OrderLineDraft => ({
  item_id: `item-${n}`, name: `Item ${n}`, kitchen_name: n, category_id: "cat-1", category_name: "Mains", qty_milli: qty,
  unit_price_paise: price, modifier_delta_paise: 0, tax_class: "fnb_standard", station_code: "kitchen", state: "draft",
});

/** The billable lines of a check as this device's store holds them (what the till bills from). */
const billable = async (d: Device, checkId: string): Promise<BillableLine[]> =>
  (await d.engine.rows("order_line"))
    .filter((r) => r.check_id === checkId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((r) => ({ id: r.id, item_id: r.item_id as string, name: r.name as string, category_name: r.category_name as string, qty_milli: r.qty_milli as number, unit_price_paise: r.unit_price_paise as number, modifier_delta_paise: 0, tax_class: r.tax_class as string }));

const header = (c: Row) => ({
  ...DINE_IN,
  id: c.id,
  ...(c.discount_kind ? { discount_kind: c.discount_kind as "percent", discount_value: c.discount_value as number } : {}),
});

async function openCheck(waiter: Till, checkId: string, orderId: string, lines: Array<[string, number, number]>): Promise<void> {
  await waiter.w.record({ intent: "order.create", build: () => [{ e: "order", id: orderId, k: "insert", f: { order_type: "dine_in", business_date: "2026-11-24", source: "pos" } }] });
  await waiter.w.record({ intent: "check.create", build: () => [{ e: "check", id: checkId, k: "insert", f: { order_type: "dine_in", business_date: "2026-11-24", status: "open" } }] });
  for (const [n, q, p] of lines) await waiter.w.record(orderLineAddSpec({ orderId, checkId, draft: draft(n, q, p) }));
}

describe("documents -> ops -> multi-device sync (Phase 2 integration)", () => {
  it("converges: unique gapless numbers per series on every device, with re-bills made offline on two tills", async () => {
    const w = await makeWorld({ seed: 7 });
    const waiter = await till(w, "waiter");
    const pos1 = await till(w, "pos1", "A07");
    const pos2 = await till(w, "pos2", "B3K");

    // The waiter takes two orders, then the tills see them (hub / cloud rounds).
    await openCheck(waiter, "c1", "o1", [["dosa", 2000, 9000], ["tea", 3000, 2000]]);
    await openCheck(waiter, "c2", "o2", [["thali", 1000, 25000]]);
    await w.settle();
    const dosa = (await waiter.engine.rows("order_line")).find((l) => l.item_id === "item-dosa")!;
    await waiter.w.record(orderLineQtySpec({ lineId: dosa.id, deltaMilli: 1000 })); // a third dosa
    await w.settle();
    expect((await pos1.engine.rows("order_line")).find((l) => l.id === dosa.id)?.qty_milli).toBe(3000);

    // Both tills edit the same check's discount from the same base while apart: one conflict, same winner everywhere.
    const base = (m: Device) => m.engine.stampOf("check", "c1", "discount_value");
    await pos1.w.record({ intent: "bill.discount.apply", build: () => [{ e: "check", id: "c1", k: "set", f: { discount_kind: "percent", discount_value: 400 } }] });
    await w.settle();
    offline(pos1, pos2);
    const prev = (await base(pos1))!;
    w.clock.advance(5);
    await pos1.w.record({ intent: "bill.discount.apply", build: () => [{ e: "check", id: "c1", k: "set", f: { discount_value: 500 }, prev: { discount_value: prev } }, { e: "check", id: "c1", k: "set", f: { label: "T4" } }] });
    w.clock.advance(5);
    await pos2.w.record({ intent: "bill.discount.apply", build: () => [{ e: "check", id: "c1", k: "set", f: { discount_value: 800 }, prev: { discount_value: prev } }, { e: "check", id: "c1", k: "set", f: { service_charge_removed: true } }] });
    await w.settle();
    for (const d of [waiter, pos1, pos2]) {
      expect((await d.engine.rows("check")).find((c) => c.id === "c1")).toMatchObject({ discount_value: 800, label: "T4", service_charge_removed: true }); // fields merged one by one
      expect((await d.engine.conflicts()).map((c) => c.field)).toEqual(["discount_value"]);
    }

    // Finalise on two tills at once: no hub, no cloud. Each takes its own series.
    offline(pos1, pos2);
    const pos1Bills: OpEnvelope[] = [];
    const rec = async (d: Till, spec: ReturnType<typeof finalizeBillSpec>) => (await d.w.record(spec)) as OpEnvelope;
    const c1 = (await pos1.engine.rows("check")).find((c) => c.id === "c1")!;
    const c2 = (await pos2.engine.rows("check")).find((c) => c.id === "c2")!;
    pos1Bills.push(await rec(pos1, finalizeBillSpec({ env: ENV, header: header(c1), lines: await billable(pos1, "c1"), options: { payments: [] } })));
    for (let i = 0; i < 3; i++) pos1Bills.push(await rec(pos1, finalizeBillSpec({ env: ENV, header: { order_type: "counter" }, lines: [line(`x${i}`)] })));
    const b2 = await rec(pos2, finalizeBillSpec({ env: ENV, header: header(c2), lines: await billable(pos2, "c2") }));
    for (let i = 0; i < 3; i++) await rec(pos2, finalizeBillSpec({ env: ENV, header: { order_type: "counter" }, lines: [line(`y${i}`)] }));
    expect(pos1Bills.map((o) => o.doc?.number)).toEqual(["A07/2627/000001", "A07/2627/000002", "A07/2627/000003", "A07/2627/000004"]);
    expect(b2.doc?.number).toBe("B3K/2627/000001");

    // Both tills re-bill while still apart: pos1 splits its dine-in bill in two; pos2 re-bills its bill once.
    const l1 = await billable(pos1, "c1");
    const bill1 = (await pos1.engine.rows("bill")).find((b) => b.number === "A07/2627/000001")!;
    const split = await pos1.w.record(rebillSpec({ env: ENV, billId: bill1.id, replacements: [{ header: header(c1), lines: [l1[0]!] }, { header: header(c1), lines: [l1[1]!] }] }));
    const again = await pos2.w.record(rebillSpec({ env: ENV, billId: (await pos2.engine.rows("bill")).find((b) => b.number === "B3K/2627/000001")!.id, replacements: [{ header: { order_type: "dine_in" }, lines: await billable(pos2, "c2") }] }));

    // One op, several numbers: the credit note first, then each new bill; `doc` is the first.
    expect((split as OpEnvelope).docs?.map((d) => d.number)).toEqual(["A07/2627/000001", "A07/2627/000005", "A07/2627/000006"]);
    expect((split as OpEnvelope).docs?.map((d) => d.type)).toEqual(["credit_note", "tax_invoice", "tax_invoice"]);
    expect(split.doc).toEqual((split as OpEnvelope).docs![0]);
    expect((again as OpEnvelope).docs?.map((d) => d.number)).toEqual(["B3K/2627/000001", "B3K/2627/000005"]);

    // Reconnect: everything converges.
    await w.settle();
    const hashes = await Promise.all([waiter, pos1, pos2].map((d) => d.engine.stateHash()));
    expect(new Set(hashes).size).toBe(1);
    expect(w.cloud.vector()["outlet:o1"]).toEqual(await pos1.engine.vector());

    for (const d of [waiter, pos1, pos2]) {
      expect(await seriesGaps(d.store)).toEqual([]);
      const bills = await d.engine.rows("bill");
      const notes = await d.engine.rows("credit_note");
      expect(bills).toHaveLength(11); // pos1: 4 bills + 2 replacements; pos2: 4 bills + 1 replacement
      expect(notes.map((n) => n.number).sort()).toEqual(["A07/2627/000001", "B3K/2627/000001"]);
      const all = [...bills, ...notes].map((r) => `${r.doc_type ?? "credit_note"}:${r.number}`);
      expect(new Set(all).size).toBe(all.length);
      // The re-bill is whole everywhere: the credit note and its two replacements share one group, and cite the bill.
      const cn = notes.find((n) => n.number === "A07/2627/000001")!;
      const repl = bills.filter((b) => b.replaces_bill_id === bill1.id);
      expect(repl.map((b) => b.number).sort()).toEqual(["A07/2627/000005", "A07/2627/000006"]);
      expect(new Set([cn.rebill_group_id, ...repl.map((b) => b.rebill_group_id)]).size).toBe(1);
      expect(cn).toMatchObject({ bill_id: bill1.id, bill_number: "A07/2627/000001" });
      expect((await d.engine.rows("check")).filter((c) => c.status === "billed").map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    }
    // Money survives the trip: the credit note reverses the bill, the replacements add back to it.
    const bills = await waiter.engine.rows("bill");
    const orig = bills.find((b) => b.id === bill1.id)!;
    const replTotal = bills.filter((b) => b.replaces_bill_id === bill1.id).reduce((s, b) => s + (b.total_paise as number), 0);
    expect((await waiter.engine.rows("credit_note")).find((n) => n.bill_id === bill1.id)?.total_paise).toBe(orig.total_paise);
    expect(Math.abs(replTotal - (orig.total_paise as number))).toBeLessThanOrEqual(5); // rounding per bill only
  });

  it("a re-bill is all or nothing: a number that cannot be taken for the new bill burns no credit-note number", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("pos", { schemas: restaurantRegistry(), grants: [{ code: "A07", docType: "tax_invoice", state: "active" }, { code: "A07", docType: "credit_note", state: "active" }] });
    const writer = new EngineOpWriter(d.engine);
    await writer.record(finalizeBillSpec({ env: ENV, header: { order_type: "counter" }, lines: [line("a")] }));
    const billId = (await d.engine.rows("bill"))[0]!.id;
    // The tax-invoice series closes (a dormant grant), then the re-bill fails after the credit note took its number.
    await d.engine.setSeriesGrants([{ code: "A07", docType: "tax_invoice", state: "closed" }, { code: "A07", docType: "credit_note", state: "active" }]);
    await expect(writer.record(rebillSpec({ env: ENV, billId, replacements: [{ header: { order_type: "counter" }, lines: [line("a")] }] }))).rejects.toThrow(/no active tax_invoice series/);
    expect(await d.engine.rows("credit_note")).toHaveLength(0);
    await d.engine.setSeriesGrants([{ code: "A07", docType: "tax_invoice", state: "active" }, { code: "A07", docType: "credit_note", state: "active" }]);
    const ok = (await writer.record(rebillSpec({ env: ENV, billId, replacements: [{ header: { order_type: "counter" }, lines: [line("a")] }] }))) as OpEnvelope;
    expect(ok.docs?.map((x) => x.number)).toEqual(["A07/2627/000001", "A07/2627/000002"]); // the credit note got 1: nothing was burnt
    expect(await seriesGaps(d.store)).toEqual([]);
  });

  it("bill.rebill.approved is accepted by the writer and the engine, and the credit note carries the bound replacement total", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("pos", { schemas: restaurantRegistry(), grants: [{ code: "A07", docType: "tax_invoice", state: "active" }, { code: "A07", docType: "credit_note", state: "active" }] });
    const writer = new EngineOpWriter(d.engine);
    await writer.record(finalizeBillSpec({ env: ENV, header: { order_type: "counter" }, lines: [line("a")] }));
    const billId = (await d.engine.rows("bill"))[0]!.id;
    const op = (await writer.record(rebillSpec({ env: ENV, billId, approved: true, replacements: [{ header: { order_type: "counter" }, lines: [line("a")] }] }))) as OpEnvelope;
    expect(op.intent).toBe("bill.rebill.approved");
    const bills = await d.engine.rows("bill");
    const replacement = bills.find((b) => b.replaces_bill_id === billId)!;
    expect(op.muts[0]).toMatchObject({ e: "credit_note", f: { bill_id: billId, replacement_total_paise: replacement.total_paise } });
  });

  it("the writer refuses an op that is not what its intent allows, before anything is recorded or numbered", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("pos", { schemas: restaurantRegistry(), grants: [...sale("A07")] });
    const writer = new EngineOpWriter(d.engine);
    const bad = (build: () => never[] | object[], intent = "bill.finalize") => writer.record({ intent, build: (c) => { c.number("tax_invoice"); return build() as never; } });
    await expect(writer.record({ intent: "bill.nope", build: () => [] })).rejects.toThrow(IntentError);
    await expect(bad(() => [{ e: "kot", id: "k", k: "insert", f: {} }])).rejects.toThrow(/entity_not_allowed/);
    await expect(bad(() => [{ e: "bill", id: "b", k: "set", f: {} }])).rejects.toThrow(/kind_not_allowed/);
    await expect(bad(() => [{ e: "bill", id: "b", k: "insert", f: { nonsense: 1 } }])).rejects.toThrow(/unknown_field/);
    await expect(writer.record({ intent: "bill.finalize", build: () => [] })).rejects.toThrow(/number_missing/);
    await expect(writer.record({ intent: "payment.record", build: (c) => { c.number("tax_invoice"); return []; } })).rejects.toThrow(/number_not_allowed/);
    await expect(writer.record({ intent: "bill.finalize", build: (c) => { c.number("credit_note"); return []; } })).rejects.toThrow(/number_not_allowed/);
    expect(await d.engine.rows("bill")).toHaveLength(0);
    const ok = await writer.record(finalizeBillSpec({ env: ENV, header: { order_type: "counter" }, lines: [line("a")] }));
    expect(ok.doc?.number).toBe("A07/2627/000001"); // none of the refusals burnt a number
  });

  it("a credit note read back from the store, a pre-bill, availability and a price edit all pass their intent checks", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("pos", { schemas: restaurantRegistry(), grants: [...sale("A07")], withHub: false });
    const writer = new EngineOpWriter(d.engine, { streams: { brand: "outlet:o1" } }); // one stream in this test world
    await writer.record(finalizeBillSpec({ env: ENV, header: { order_type: "counter" }, lines: [line("a")] }));
    const bill = (await d.engine.rows("bill"))[0]!;
    const cn = (await writer.record(creditNoteSpec({ env: ENV, billId: bill.id, request: {} }))) as OpEnvelope;
    expect(cn.docs).toBeUndefined(); // one number: `doc` only
    expect(cn.doc).toEqual({ type: "credit_note", number: "A07/2627/000001" });
    await writer.record(presentSpec({ env: ENV, header: { ...DINE_IN, id: "c9" }, lines: [line("a")], options: { presentCount: 1, mode: "printed", businessName: "Cafe" } }));
    expect(await d.engine.rows("check_present")).toHaveLength(1);
    await writer.record(availabilitySpec({ outletId: "o1", itemId: "item-a", available: false }));
    await writer.record(availabilitySpec({ outletId: "o1", itemId: "item-a", available: true })); // second write is a set on the same row
    expect((await d.engine.rows("item_outlet")).map((r) => r.available)).toEqual([true]);
    await writer.record(priceSetSpec({ itemId: "item-a", pricePaise: 9000 }));
    await writer.record(priceSetSpec({ itemId: "item-a", pricePaise: 9500 }));
    expect((await d.engine.rows("price_entry")).map((r) => r.price_paise)).toEqual([9500]);
  });
});
