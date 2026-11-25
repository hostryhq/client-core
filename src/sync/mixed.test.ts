import { describe, expect, it } from "vitest";
import { reviewFields } from "./schema";
import { restaurantRegistry, restaurantSchemas } from "./restaurant";
import { makeWorld, type Device, type World } from "./testkit/harness";
import { authorBatch, deliver, permutations } from "./testkit/ship";

/** Entities with one policy per field (api-specs entities/restaurant: `policy: mixed`). */
async function pair(): Promise<{ w: World; a: Device; b: Device }> {
  const w = await makeWorld();
  const a = await w.addDevice("devA", { withHub: false, schemas: restaurantRegistry() });
  const b = await w.addDevice("devB", { withHub: false, schemas: restaurantRegistry() });
  return { w, a, b };
}

/** A receiver that only sees the ops, delivered in the given order of whole batches. */
async function receive(w: World, order: Device[]): Promise<Device> {
  const rx = await w.addDevice(`rx-${w.devices.length}`, { withHub: false, schemas: restaurantRegistry() });
  await deliver(rx.engine, await Promise.all(order.map((d) => authorBatch(d))));
  return rx;
}

describe("mixed-policy entities (check, order_line)", () => {
  it("the schema is generated from the entity files: check and order_line are mixed, review fields come from lww_review", () => {
    const s = Object.fromEntries(restaurantSchemas().map((e) => [e.name, e]));
    expect(s.check?.policy).toBe("mixed");
    expect(s.check?.fields?.status).toEqual({ policy: "rank", order: ["open", "closed_internal", "billed"] });
    expect(reviewFields(s.check!)).toEqual(expect.arrayContaining(["discount_value", "customer_gstin", "service_charge_removed"]));
    expect(s.order_line?.fields?.qty_milli?.policy).toBe("delta");
    expect(s.bill?.policy).toBe("append");
    expect(s.bill?.guarded).toBe(true);
  });

  it("check: status only moves forward, other fields merge by their own rule, in any arrival order", async () => {
    const { w, a, b } = await pair();
    await a.engine.recordMuts("check.create", [{ e: "check", id: "c1", k: "insert", f: { order_type: "dine_in", business_date: "2026-11-24", status: "open", label: "T4" } }]);
    w.clock.advance(5);
    await b.engine.recordMuts("bill.finalize", [
      { e: "check", id: "c1", k: "rank", f: { status: "billed" } },
      { e: "check", id: "c1", k: "set", f: { bill_id: "bill-1" } },
    ]);
    w.clock.advance(5);
    await a.engine.recordMuts("bill.customer_details.edit", [
      { e: "check", id: "c1", k: "set", f: { label: "T5", status: "open", order_type: "takeaway" } }, // stale status, immutable type
    ]);
    const hashes = new Set<string>();
    for (const order of permutations([a, b])) {
      const rx = await receive(w, order);
      hashes.add(await rx.engine.stateHash());
      const c = (await rx.engine.rows("check"))[0]!;
      expect(c).toMatchObject({ status: "billed", bill_id: "bill-1", label: "T5", order_type: "dine_in" });
    }
    expect(hashes.size).toBe(1);
  });

  it("order_line: quantity is the sum of deltas, state only moves forward, placement is last writer", async () => {
    const { w, a, b } = await pair();
    await a.engine.recordMuts("order.line.add", [{ e: "order_line", id: "l1", k: "insert", f: { order_id: "o1", check_id: "c1", item_id: "i1", qty_milli: 1000, state: "draft", seat_no: 1 } }]);
    await a.engine.recordMuts("order.line.edit", [{ e: "order_line", id: "l1", k: "delta", f: { qty_milli: -250 } }]);
    w.clock.advance(5);
    await b.engine.recordMuts("order.line.edit", [{ e: "order_line", id: "l1", k: "delta", f: { qty_milli: 2000 } }]);
    await b.engine.recordMuts("kot.send", [{ e: "order_line", id: "l1", k: "rank", f: { state: "sent" } }]);
    w.clock.advance(5);
    await a.engine.recordMuts("order.items.move", [{ e: "order_line", id: "l1", k: "set", f: { check_id: "c2", state: "draft" } }]);
    const hashes = new Set<string>();
    for (const order of permutations([a, b])) {
      const rx = await receive(w, order);
      hashes.add(await rx.engine.stateHash());
      expect((await rx.engine.rows("order_line"))[0]).toMatchObject({ qty_milli: 2750, state: "sent", check_id: "c2", order_id: "o1" });
    }
    expect(hashes.size).toBe(1);
  });

  it("a concurrent edit of a review field keeps the winner on every node and asks a manager; a field not in the contract is ignored", async () => {
    const { w, a, b } = await pair();
    await a.engine.recordMuts("check.create", [{ e: "check", id: "c1", k: "insert", f: { order_type: "dine_in", business_date: "2026-11-24", status: "open", discount_kind: "percent", discount_value: 400 } }]);
    await w.settle();
    const prev = await a.engine.stampOf("check", "c1", "discount_value");
    expect(prev).toBeDefined();
    w.clock.advance(5);
    await a.engine.recordMuts("bill.discount.apply", [{ e: "check", id: "c1", k: "set", f: { discount_value: 500, surprise: 1 }, prev: { discount_value: prev! } }]);
    w.clock.advance(5);
    await b.engine.recordMuts("bill.discount.apply", [{ e: "check", id: "c1", k: "set", f: { discount_value: 800 }, prev: { discount_value: prev! } }]);
    await w.settle();
    for (const d of [a, b]) {
      expect((await d.engine.rows("check"))[0]?.discount_value).toBe(800);
      expect((await d.engine.conflicts()).map((c) => c.field)).toEqual(["discount_value"]);
      expect((await d.engine.rows("check"))[0]).not.toHaveProperty("surprise");
    }
    expect(await a.engine.stateHash()).toBe(await b.engine.stateHash());
  });
});
