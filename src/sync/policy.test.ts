import { describe, expect, it } from "vitest";
import { detect } from "./detectors";
import { DEMO_SCHEMAS, SchemaRegistry } from "./schema";
import { makeWorld, OUTLET, type Device, type World } from "./testkit/harness";
import { authorBatch, cloudBatch, deliver, permutations } from "./testkit/ship";

/** Two devices plus a receiver that only ever sees ops through applyRemote. */
async function trio(w?: World): Promise<{ w: World; a: Device; b: Device; rx: Device }> {
  const world = w ?? (await makeWorld());
  const a = await world.addDevice("devA", { withHub: false });
  const b = await world.addDevice("devB", { withHub: false });
  const rx = await world.addDevice("devRx", { withHub: false });
  return { w: world, a, b, rx };
}

async function hashAfter(w: World, order: Array<"A" | "B">, a: Device, b: Device): Promise<{ hash: string; rx: Device }> {
  const rx = await w.addDevice(`rx-${w.devices.length}`, { withHub: false });
  const batches = { A: await authorBatch(a), B: await authorBatch(b) };
  await deliver(rx.engine, order.map((k) => batches[k]));
  return { hash: await rx.engine.stateHash(), rx };
}

describe("conflict policy per entity", () => {
  it("append: rows are immutable; a duplicate insert of one id converges on the lower stamp in any order", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: { table: "T1" } }]);
    await b.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: { table: "T2" } }]);
    await a.engine.recordMuts("order.edit", [{ e: "order", id: "o1", k: "set", f: { table: "T9" } }]); // not allowed on append
    const ab = await hashAfter(w, ["A", "B"], a, b);
    const ba = await hashAfter(w, ["B", "A"], a, b);
    expect(ab.hash).toBe(ba.hash);
    expect((await ab.rx.engine.rows("order"))[0]?.table).toBe("T1"); // devA stamped first (same ms, origin tie -> devA)
  });

  it("delta: the value is the sum whatever the arrival order", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("stock.in", [{ e: "stock_level", id: "s1", k: "insert", f: { item: "rice", qty_milli: 10_000 } }]);
    await a.engine.recordMuts("stock.out", [{ e: "stock_level", id: "s1", k: "delta", f: { qty_milli: -3_000 } }]);
    await b.engine.recordMuts("stock.out", [{ e: "stock_level", id: "s1", k: "delta", f: { qty_milli: -2_500 } }]);
    const x = await hashAfter(w, ["A", "B"], a, b);
    const y = await hashAfter(w, ["B", "A"], a, b);
    expect(x.hash).toBe(y.hash);
    expect((await x.rx.engine.rows("stock_level"))[0]?.qty_milli).toBe(4_500);
  });

  it("rank: a stale device cannot move a status backwards", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("kds.new", [{ e: "kds_item", id: "k1", k: "insert", f: { status: "new" } }]);
    await a.engine.recordMuts("kds.ready", [{ e: "kds_item", id: "k1", k: "set", f: { status: "ready" } }]);
    await b.engine.recordMuts("kds.late", [{ e: "kds_item", id: "k1", k: "set", f: { status: "preparing" } }]);
    for (const order of [["A", "B"], ["B", "A"]] as const) {
      const r = await hashAfter(w, [...order], a, b);
      expect((await r.rx.engine.rows("kds_item"))[0]?.status).toBe("ready");
    }
  });

  it("rank: a `rank` mutation on an entity-level rank entity is applied forward-only, in any arrival order", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("seating.open", [{ e: "seating", id: "s1", k: "insert", f: { status: "open" } }]);
    await a.engine.recordMuts("seating.close", [{ e: "seating", id: "s1", k: "rank", f: { status: "closed" } }]);
    await b.engine.recordMuts("seating.bill", [{ e: "seating", id: "s1", k: "rank", f: { status: "billed" } }]);
    for (const order of [["A", "B"], ["B", "A"]] as const) {
      const r = await hashAfter(w, [...order], a, b);
      expect((await r.rx.engine.rows("seating"))[0]?.status).toBe("closed");
    }
  });

  it("lww: highest stamp wins per field, ties break on origin, and each field is stamped on its own", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { name: "Dosa", price_paise: 9000 } }]);
    w.clock.advance(5);
    await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 9500 } }]);
    await b.engine.recordMuts("menu.rename", [{ e: "menu_item", id: "m1", k: "set", f: { name: "Masala Dosa" } }]); // b's clock is earlier
    const x = await hashAfter(w, ["A", "B"], a, b);
    const y = await hashAfter(w, ["B", "A"], a, b);
    expect(x.hash).toBe(y.hash);
    const row = (await x.rx.engine.rows("menu_item"))[0]!;
    expect(row.price_paise).toBe(9500);
    expect(row.name).toBe("Masala Dosa"); // lower-stamped write on a different field still applies
  });

  it("lww + review: concurrent price edits both survive as a conflict, the winner applies, a sequential edit is not a conflict", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { name: "Tea", price_paise: 1000 } }]);
    const base = await authorBatch(a);
    await deliver(b.engine, [base]);
    const seen = await a.engine.stampOf("menu_item", "m1", "price_paise");
    expect(await b.engine.stampOf("menu_item", "m1", "price_paise")).toBe(seen);
    w.clock.advance(10);
    await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 1200 }, prev: { price_paise: seen! } }]);
    w.clock.advance(10);
    await b.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 1100 }, prev: { price_paise: seen! } }]); // same base: concurrent

    const results = [];
    for (const order of permutations<"A" | "B">(["A", "B"])) {
      const rx = await w.addDevice(`r${results.length}`, { withHub: false });
      await deliver(rx.engine, [base]);
      const batches = { A: await authorBatch(a), B: await authorBatch(b) };
      // a's batch contains the base insert again (own ops): feed only the new tail by delivering fresh engines in order.
      await deliver(rx.engine, order.map((k) => ({ A: batches.A, B: batches.B })[k]));
      results.push(rx);
    }
    for (const rx of results) {
      expect((await rx.engine.rows("menu_item"))[0]?.price_paise).toBe(1100); // later stamp wins
      const open = await rx.engine.conflicts();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ field: "price_paise", winner: 1100, loser: 1200 }); // the losing value is kept
      expect(rx.engine.status().state).toBe("conflict");
    }
    expect(results[0]!.engine.status().attentionOps).toBe(1);

    // A manager confirms: the conflict clears and the indicator goes back to normal.
    const rx = results[0]!;
    await rx.engine.confirmConflict(open0(await rx.engine.conflicts()));
    expect(await rx.engine.conflicts()).toHaveLength(0);

    // A sequential edit (the writer saw the earlier value) is not a conflict.
    const { w: w2, a: a2, b: b2 } = await trio();
    await a2.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { price_paise: 1000 } }]);
    await deliver(b2.engine, [await authorBatch(a2)]);
    const s1 = await b2.engine.stampOf("menu_item", "m1", "price_paise");
    w2.clock.advance(5);
    await b2.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 1300 }, prev: { price_paise: s1! } }]);
    const rx2 = await w2.addDevice("rx2", { withHub: false });
    await deliver(rx2.engine, [await authorBatch(a2), await authorBatch(b2)]);
    expect(await rx2.engine.conflicts()).toHaveLength(0);
    expect((await rx2.engine.rows("menu_item"))[0]?.price_paise).toBe(1300);
  });

  it("tombstones: del and undel are stamped writes; the later stamp wins in either order", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { name: "Tea" } }]);
    w.clock.advance(5);
    await a.engine.recordMuts("menu.del", [{ e: "menu_item", id: "m1", k: "del" }]);
    w.clock.advance(5);
    await b.engine.recordMuts("menu.undel", [{ e: "menu_item", id: "m1", k: "undel" }]);
    for (const order of permutations<"A" | "B">(["A", "B"])) {
      const r = await hashAfter(w, order, a, b);
      expect(await r.rx.engine.rows("menu_item")).toHaveLength(1); // b's undel is later than a's del
    }
    // And a delete that is later than everything hides the row.
    w.clock.advance(5);
    await a.engine.recordMuts("menu.del", [{ e: "menu_item", id: "m1", k: "del" }]);
    const r = await hashAfter(w, ["B", "A"], a, b);
    expect(await r.rx.engine.rows("menu_item")).toHaveLength(0);
  });

  it("guarded money: payments are never merged; overpayment and duplicate finalisation are detected on every node", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("bill.finalize", [{ e: "bill", id: "b1", k: "insert", f: { order_id: "o1", total_paise: 50_000 } }]);
    const base = await authorBatch(a);
    await deliver(b.engine, [base]);
    await a.engine.recordMuts("pay", [{ e: "payment", id: "p1", k: "insert", f: { bill_id: "b1", amount_paise: 50_000 } }]);
    await b.engine.recordMuts("pay", [{ e: "payment", id: "p2", k: "insert", f: { bill_id: "b1", amount_paise: 50_000 } }]);
    await b.engine.recordMuts("bill.finalize", [{ e: "bill", id: "b2", k: "insert", f: { order_id: "o1", total_paise: 50_000 } }]);
    const x = await hashAfter(w, ["A", "B"], a, b);
    expect((await x.rx.engine.rows("payment")).map((p) => p.id).sort()).toEqual(["p1", "p2"]); // both payments survive
    const found = await detect(x.rx.store);
    expect(found.map((v) => v.kind)).toEqual(["duplicate_finalisation", "overpayment"]);
    // A refund is a compensating op, not a merge: the detector then goes quiet for the overpayment.
    await b.engine.recordMuts("refund", [{ e: "payment", id: "p3", k: "insert", f: { bill_id: "b1", amount_paise: -50_000 } }]);
    await deliver(x.rx.engine, [await authorBatch(b)]);
    expect((await detect(x.rx.store)).map((v) => v.kind)).toEqual(["duplicate_finalisation"]);
  });

  it("a refund entity (positive amount) closes an overpayment the same as a negative payment (soak T7)", async () => {
    const { w, a, b } = await trio();
    await a.engine.recordMuts("bill.finalize", [{ e: "bill", id: "b1", k: "insert", f: { order_id: "o1", total_paise: 50_000 } }]);
    await deliver(b.engine, [await authorBatch(a)]);
    await a.engine.recordMuts("pay", [{ e: "payment", id: "p1", k: "insert", f: { bill_id: "b1", amount_paise: 50_000 } }]);
    await b.engine.recordMuts("pay", [{ e: "payment", id: "p2", k: "insert", f: { bill_id: "b1", amount_paise: 50_000 } }]);
    const x = await hashAfter(w, ["A", "B"], a, b);
    expect((await detect(x.rx.store)).map((v) => v.kind)).toEqual(["overpayment"]);
    // A partial refund leaves it open; a refund of the rest closes it. Refunds of another bill do not count.
    await b.engine.recordMuts("refund", [{ e: "refund", id: "r1", k: "insert", f: { bill_id: "b1", payment_id: "p2", amount_paise: 20_000 } }]);
    await b.engine.recordMuts("refund", [{ e: "refund", id: "r9", k: "insert", f: { bill_id: "other", payment_id: "px", amount_paise: 99_000 } }]);
    await deliver(x.rx.engine, [await authorBatch(b)]);
    expect((await detect(x.rx.store)).map((v) => v.kind)).toEqual(["overpayment"]);
    await b.engine.recordMuts("refund", [{ e: "refund", id: "r2", k: "insert", f: { bill_id: "b1", payment_id: "p2", amount_paise: 30_000 } }]);
    await deliver(x.rx.engine, [await authorBatch(b)]);
    expect(await detect(x.rx.store)).toEqual([]);
  });

  it("older clients ignore entities and fields they do not know but keep the op and advance the vector", async () => {
    const w = await makeWorld();
    const newer = new SchemaRegistry([...DEMO_SCHEMAS, { name: "loyalty_tier", policy: "lww" }]);
    const sender = await w.addDevice("devNew", { withHub: false, schemas: newer });
    const old = await w.addDevice("devOld", { withHub: false });
    await sender.engine.recordMuts("future", [
      { e: "loyalty_tier", id: "x", k: "insert", f: { name: "gold" } },
      { e: "order", id: "o1", k: "insert", f: { table: "T1", new_field_v2: "kept" } },
    ]);
    await deliver(old.engine, [await authorBatch(sender)]);
    expect((await old.engine.rows("order"))[0]).toMatchObject({ table: "T1", new_field_v2: "kept" });
    expect(await old.engine.vector()).toEqual({ devNew: 1 });
    expect(await old.store.get("loyalty_tier", "x")).toBeUndefined();
    expect(await old.engine.opAt({ origin: "devNew", stream: OUTLET, seq: 1 })).toBeDefined(); // retained, can be relayed
  });
});

function open0(c: Array<{ id: string }>): string {
  return c[0]!.id;
}

describe("void of a refused configuration write (review M-1)", () => {
  it("every node ends on the legitimate edit in every arrival order; the refused value is on no node", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false }); // makes the unauthorised edit, stamped later
    const b = await w.addDevice("devB", { withHub: false }); // makes the legitimate edit, stamped earlier
    await b.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { name: "Tea", price_paise: 1500 } }]);
    w.clock.advance(1000);
    const evil = await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 100 } }]);
    // Without the void the later (refused) write would win. The cloud refuses it.
    await w.cloud.push({ ...(await authorBatch(a)) });
    await w.cloud.push({ ...(await authorBatch(b)) });
    await w.cloud.voidOp({ origin: "devA", stream: OUTLET, seq: evil.seq });
    const batches = [await authorBatch(a), await authorBatch(b), await cloudBatch(w.cloud)];
    expect(batches[2]!.items).toHaveLength(1);

    for (const order of permutations([0, 1, 2])) {
      const rx = await w.addDevice(`rx${order.join("")}`, { withHub: false });
      await deliver(rx.engine, order.map((i) => batches[i]!));
      const row = (await rx.engine.rows("menu_item"))[0]!;
      expect(row.price_paise, `order ${order}`).toBe(1500);
      const final = await rx.store.get("menu_item", "m1");
      expect(JSON.stringify(final)).not.toContain('"v":100'); // the refused candidate is dropped, not kept
    }
  });

  it("a later legitimate edit is never overwritten by the void", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const b = await w.addDevice("devB", { withHub: false });
    await b.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { price_paise: 1500 } }]);
    w.clock.advance(10);
    const evil = await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 100 } }]);
    w.clock.advance(10);
    await b.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 1800 } }]); // legitimate, later
    await w.cloud.push(await authorBatch(a));
    await w.cloud.push(await authorBatch(b));
    await w.cloud.voidOp({ origin: "devA", stream: OUTLET, seq: evil.seq });
    const batches = [await authorBatch(a), await authorBatch(b), await cloudBatch(w.cloud)];
    for (const order of permutations([0, 1, 2])) {
      const rx = await w.addDevice(`rx${order.join("")}`, { withHub: false });
      await deliver(rx.engine, order.map((i) => batches[i]!));
      expect((await rx.engine.rows("menu_item"))[0]?.price_paise, `order ${order}`).toBe(1800);
    }
  });

  it("a device whose own edit was voided sees it as refused, never as a verdict about a PIN", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const op = await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "insert", f: { price_paise: 100 } }]);
    await w.cloud.push(await authorBatch(a));
    await w.cloud.voidOp({ origin: "devA", stream: OUTLET, seq: op.seq });
    await deliver(a.engine, [await cloudBatch(w.cloud)]);
    expect(a.engine.refusedOps()).toEqual([{ origin: "devA", stream: OUTLET, seq: op.seq }]);
    expect(a.engine.status().attentionOps).toBe(1);
    expect(await a.engine.rows("menu_item")).toHaveLength(0);
  });
});

describe("idempotent replay", () => {
  it("applying a whole log twice, and in shuffled cross-origin order, gives the same state hash", async () => {
    const { w, a, b } = await trio();
    for (let i = 0; i < 6; i++) {
      await a.engine.recordMuts("x", [{ e: "stock_level", id: "s1", k: "delta", f: { qty_milli: i * 100 } }, { e: "order", id: `oa${i}`, k: "insert", f: { n: i } }]);
      await b.engine.recordMuts("x", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 1000 + i } }, { e: "kds_item", id: "k1", k: "set", f: { status: ["new", "preparing", "ready"][i % 3] } }]);
      w.clock.advance(3);
    }
    const batches = [await authorBatch(a), await authorBatch(b)];
    const once = await w.addDevice("once", { withHub: false });
    await deliver(once.engine, batches);
    const twice = await w.addDevice("twice", { withHub: false });
    await deliver(twice.engine, [...batches, ...batches]);
    const rev = await w.addDevice("rev", { withHub: false });
    await deliver(rev.engine, [batches[1]!, batches[0]!, batches[1]!]);
    const h = await once.engine.stateHash();
    expect(await twice.engine.stateHash()).toBe(h);
    expect(await rev.engine.stateHash()).toBe(h);
    expect(await once.engine.vector()).toEqual(await twice.engine.vector());
  });
});
