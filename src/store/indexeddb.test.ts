import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { KeyRing, SoftwareSigner } from "../sync/crypto";
import { SyncEngine } from "../sync/engine";
import { demoRegistry } from "../sync/schema";
import { InMemoryStore } from "./memory";
import { IndexedDbPersistence } from "./indexeddb";

const open = async (factory: IDBFactory, tenant = "t1") => InMemoryStore.open(tenant, await IndexedDbPersistence.open("hostry", factory));

describe("browser store over IndexedDB", () => {
  it("keeps committed transactions across a reopen and loses an uncommitted one whole", async () => {
    const factory = new IDBFactory();
    const s1 = await open(factory);
    await s1.transact((tx) => {
      tx.put("order", { id: "o1", tenant_id: "t1", table: "T1" });
      tx.put("order", { id: "o2", tenant_id: "t1", table: "T2" });
    });
    await expect(
      s1.transact((tx) => {
        tx.put("order", { id: "o3", tenant_id: "t1" });
        tx.del("order", "o1");
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash");
    const s2 = await open(factory); // process restart
    expect((await s2.list("order")).map((r) => r.id).sort()).toEqual(["o1", "o2"]);
  });

  it("never loads another tenant's rows", async () => {
    const factory = new IDBFactory();
    const mine = await open(factory, "t1");
    await mine.transact((tx) => tx.put("order", { id: "o1", tenant_id: "t1" }));
    const other = await open(factory, "t2");
    expect(await other.list("order")).toEqual([]);
    expect(await other.get("order", "o1")).toBeUndefined();
  });

  it("carries the whole sync engine state across a restart: op log, vector, hash chain, series counters", async () => {
    const factory = new IDBFactory();
    const signer = await SoftwareSigner.generate("k1");
    const ring = new KeyRing();
    await ring.add("devA", "k1", signer.publicB64);
    const cfg = async () => ({
      store: await open(factory),
      schemas: demoRegistry(),
      deviceId: "devA",
      outletStream: "outlet:o1",
      signer,
      verifier: ring,
      packVersion: 1,
    });
    const e1 = await SyncEngine.open(await cfg());
    e1.session = { actor: "m1", sid: "s1" };
    await e1.setSeriesGrants([{ code: "A07", docType: "tax_invoice", state: "active" }]);
    const bill = (id: string) => e1.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id, k: "insert", f: { number: c.number("tax_invoice") } }] });
    await bill("b1");
    await bill("b2");
    const hash = await e1.stateHash();

    const e2 = await SyncEngine.open(await cfg());
    e2.session = { actor: "m1", sid: "s1" };
    expect(await e2.stateHash()).toBe(hash);
    expect(await e2.vector()).toEqual({ devA: 2 });
    const op = await e2.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: "b3", k: "insert", f: { number: c.number("tax_invoice") } }] });
    expect(op.doc?.number).toBe("A07/2627/000003");
    expect(op.seq).toBe(3);
    const first = await e2.opAt({ origin: "devA", stream: "outlet:o1", seq: 1 });
    expect(op.ph).toBe(await e2.hashAt({ origin: "devA", stream: "outlet:o1", seq: 2 })); // chain continues across the restart
    expect(first?.seq).toBe(1);
  });
});
