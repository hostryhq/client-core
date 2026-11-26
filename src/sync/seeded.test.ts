import { describe, expect, it } from "vitest";
import { makeWorld } from "./testkit/harness";

describe("rows put straight into the store (seeding)", () => {
  it("a seeded lww row survives its first set, keeps untouched fields, and a later set still wins by stamp", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    await a.store.transact((tx) => tx.put("menu_item", { id: "m1", tenant_id: a.store.tenantId, name: "Dosa", price_paise: 9000 }));
    await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 9500 } }]);
    const rows = await a.engine.rows("menu_item");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "m1", name: "Dosa", price_paise: 9500 });
    w.clock.advance(5);
    await a.engine.recordMuts("menu.price", [{ e: "menu_item", id: "m1", k: "set", f: { price_paise: 9800 } }]);
    expect((await a.engine.rows("menu_item"))[0]?.price_paise).toBe(9800);
  });

  it("a seeded row can still be deleted by a del op", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    await a.store.transact((tx) => tx.put("menu_item", { id: "m1", tenant_id: a.store.tenantId, name: "Dosa", price_paise: 9000 }));
    await a.engine.recordMuts("menu.del", [{ e: "menu_item", id: "m1", k: "del" }]);
    expect(await a.engine.rows("menu_item")).toHaveLength(0);
  });
});
