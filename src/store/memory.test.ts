import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./memory";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, tenant_id: "t1", ...extra });

describe("InMemoryStore", () => {
  it("refuses to write another tenant's row and rolls back the whole transaction", async () => {
    const store = new InMemoryStore("t1");
    await expect(
      store.transact((tx) => {
        tx.put("bill", row("b1"));
        tx.put("bill", { id: "b2", tenant_id: "t2" });
      }),
    ).rejects.toThrow(/tenant mismatch/);
    expect(await store.list("bill")).toEqual([]);
  });

  it("does not return rows that belong to another tenant", async () => {
    const store = new InMemoryStore("t1");
    // Simulate a corrupted/shared backing table by writing a foreign row directly.
    (store as unknown as { tables: Map<string, Map<string, unknown>> }).tables.set(
      "bill",
      new Map([["x", { id: "x", tenant_id: "t2" }]]),
    );
    expect(await store.get("bill", "x")).toBeUndefined();
    expect(await store.list("bill")).toEqual([]);
  });

  it("serialises transactions so a read-modify-write never interleaves", async () => {
    const store = new InMemoryStore("t1");
    await store.transact((tx) => tx.put("counter", row("c", { n: 0 })));
    const bump = () =>
      store.transact(async (tx) => {
        const n = tx.get("counter", "c")?.n as number;
        await Promise.resolve(); // yield: an unserialised store would lose an update here
        tx.put("counter", row("c", { n: n + 1 }));
      });
    await Promise.all([bump(), bump(), bump()]);
    expect((await store.get("counter", "c"))?.n).toBe(3);
  });

  it("delete is a tombstone: hidden from list, still readable by id", async () => {
    const store = new InMemoryStore("t1");
    await store.transact((tx) => tx.put("item", row("i1")));
    await store.transact((tx) => tx.del("item", "i1"));
    expect(await store.list("item")).toEqual([]);
    expect((await store.get("item", "i1"))?.deleted).toBe(true);
  });
});
