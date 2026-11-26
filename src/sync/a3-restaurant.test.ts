import { describe, expect, it } from "vitest";
import { restaurantRegistry } from "./restaurant";
import { makeWorld, OUTLET } from "./testkit/harness";
import { authorBatch } from "./testkit/ship";

const check = (id: string, f: Record<string, unknown>, k: "insert" | "set" = "insert") => [{ e: "check", id, k, f }];

/** ADR-0014 A3.1/A3.2 on the real restaurant registry: `check.customer_*` are mixed-policy pii fields. */
describe("pii on a mixed entity: commitments follow the field's merge rule", () => {
  async function scene() {
    const w = await makeWorld();
    const mk = (id: string, kind: "pos" | "waiter" | "kds") => w.addDevice(id, { withHub: false, schemas: restaurantRegistry(), kind });
    const a = await mk("devA", "pos");
    const b = await mk("devB", "waiter");
    const k = await mk("devK", "kds");
    await a.engine.recordMuts("check.create", check("c1", { order_type: "dine_in", status: "open", customer_name: "Asha" }));
    await a.engine.recordMuts("bill.customer_details.edit", check("c1", { customer_name: "Meera", customer_phone: "+910000000000" }, "set"));
    await w.settle();
    return { w, a, b, k };
  }

  it("PA3: one hash on every node, with the winning commitment; a kds holds no value; erasure changes no hash", async () => {
    const { w, a, b, k } = await scene();
    const hashes = async () => [await a.engine.stateHash(), await b.engine.stateHash(), await k.engine.stateHash()];
    const before = await hashes();
    expect(new Set(before).size).toBe(1);
    expect((await b.engine.rows("check"))[0]).toMatchObject({ customer_name: "Meera", customer_phone: "+910000000000" });
    const onKds = (await k.engine.rows("check"))[0]!;
    expect(onKds.customer_name).toBeUndefined();
    expect(onKds.status).toBe("open");
    // The winner of customer_name is the later write, on the kds too: its commitment, not the first one.
    expect((await k.store.get("check", "c1"))!["~c:customer_name"]).toBe((await a.store.get("check", "c1"))!["~c:customer_name"]);
    await w.cloud.erasePii({ origin: "devA", stream: OUTLET, seq: 2 });
    await w.settle();
    expect(await hashes()).toEqual(before);
    expect((await b.engine.rows("check"))[0]!.customer_phone).toBeUndefined();
    expect((await a.engine.rows("check"))[0]!.customer_phone).toBeUndefined();
  });

  it("two nodes with different winners for customer_name differ in the hash", async () => {
    const w = await makeWorld();
    const mk = (id: string) => w.addDevice(id, { withHub: false, schemas: restaurantRegistry() });
    const a = await mk("devA");
    const b = await mk("devB");
    await a.engine.recordMuts("check.create", check("c1", { order_type: "dine_in", status: "open", customer_name: "Asha" }));
    const batch = await authorBatch(a);
    await b.engine.applyRemote(OUTLET, batch.items, batch.seals);
    await a.engine.recordMuts("bill.customer_details.edit", check("c1", { customer_name: "Meera" }, "set"));
    expect(await a.engine.stateHash()).not.toBe(await b.engine.stateHash());
  });

  it("PA4: a stripped value shows as pending and is filled by the next pull, in the row", async () => {
    const w = await makeWorld();
    const mk = (id: string) => w.addDevice(id, { withHub: false, schemas: restaurantRegistry() });
    const a = await mk("devA");
    const b = await mk("devB");
    await a.engine.recordMuts("check.create", check("c1", { order_type: "dine_in", status: "open", customer_name: "Asha", customer_phone: "+910000000000" }));
    const batch = await authorBatch(a);
    await b.engine.applyRemote(OUTLET, batch.items.map((it) => ({ ...it, pii: undefined })), batch.seals);
    expect((await b.engine.rows("check"))[0]!.customer_name).toBeUndefined();
    expect((await b.engine.piiIncomplete())[0]!.fields.map((f) => f.f).sort()).toEqual(["customer_name", "customer_phone"]);
    expect(await b.engine.stateHash()).toBe(await a.engine.stateHash());
    await w.syncDevice(a);
    await w.syncDevice(b);
    expect(await b.engine.piiIncomplete()).toEqual([]);
    expect((await b.engine.rows("check"))[0]).toMatchObject({ customer_name: "Asha", customer_phone: "+910000000000" });
  });
});
