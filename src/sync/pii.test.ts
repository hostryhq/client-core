import { describe, expect, it } from "vitest";
import { restaurantRegistry } from "./restaurant";
import { stripSalts } from "./pii-commit";
import { OpTooLargeError, MAX_OP_BODY_BYTES, MAX_PII_BYTES, isPiiObject } from "./pii";
import type { OpEnvelope } from "./types";
import { makeWorld, OUTLET } from "./testkit/harness";
import { authorBatch } from "./testkit/ship";

const check = (id: string, f: Record<string, unknown>, k: "insert" | "set" = "insert") => [{ e: "check", id, k, f }];

describe("personal data stays out of the hashed body (ADR-0002 S4, review M-10)", () => {
  it("moves declared pii fields into pii as entity -> row id -> field -> value; the row still reads them", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, schemas: restaurantRegistry() });
    const rx = await w.addDevice("rx", { withHub: false, schemas: restaurantRegistry() });
    await a.engine.recordMuts("check.create", check("c1", { order_type: "dine_in", status: "open", customer_name: "A. Customer" }));
    await a.engine.recordMuts("bill.customer_details.edit", check("c1", { customer_name: "B. Customer", customer_phone: "+910000000000" }, "set"));

    const b = await authorBatch(a);
    expect(b.items).toHaveLength(2);
    for (const it of b.items) expect(it.body).not.toMatch(/Customer|\+91/);
    expect(isPiiObject(b.items[0]!.pii)).toBe(true);
    expect(stripSalts(b.items[0]!.pii)).toEqual({ check: { c1: { customer_name: "A. Customer" } } });
    expect(stripSalts(b.items[1]!.pii)).toEqual({ check: { c1: { customer_name: "B. Customer", customer_phone: "+910000000000" } } });
    expect(((JSON.parse(b.items[0]!.body!) as OpEnvelope).muts[0]!.f ?? {}).customer_name).toBeUndefined();

    // Local row and a receiving device show the name, as before; the hash does not depend on pii.
    expect((await a.engine.rows("check"))[0]).toMatchObject({ customer_name: "B. Customer", customer_phone: "+910000000000" });
    await rx.engine.applyRemote(OUTLET, b.items, b.seals);
    expect((await rx.engine.rows("check"))[0]).toMatchObject({ customer_name: "B. Customer" });
    expect(await rx.engine.stateHash()).toBe(await a.engine.stateHash());

    // Erased pii: the chain and the rest of the row are unchanged, the name is simply absent.
    const rx2 = await w.addDevice("rx2", { withHub: false, schemas: restaurantRegistry() });
    const erased = b.items.map((it) => ({ ...it, pii: undefined }));
    expect((await rx2.engine.applyRemote(OUTLET, erased, b.seals)).applied).toBe(2);
    expect((await rx2.engine.rows("check"))[0]!.customer_name).toBeUndefined();
  });

  it("ignores an explicit pii of the old flat shape", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, schemas: restaurantRegistry() });
    await a.engine.record({ intent: "check.create", pii: { customer_name: "X" }, build: () => check("c1", { order_type: "dine_in", status: "open" }) });
    expect((await authorBatch(a)).items[0]!.pii).toBeUndefined();
  });
});

describe("op_too_large (go-common sync limits)", () => {
  const big = (n: number): Array<{ e: string; id: string; k: "insert"; f: Record<string, unknown> }> => [{ e: "order", id: "o1", k: "insert", f: { note: "x".repeat(n) } }];

  it("refuses a body over 256 KiB before recording: no op, no sequence number consumed, nothing applied", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const err = await a.engine.recordMuts("order.create", big(MAX_OP_BODY_BYTES)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpTooLargeError);
    expect(err).toMatchObject({ code: "op_too_large", part: "body", limit: MAX_OP_BODY_BYTES });
    expect(await a.engine.vector()).toEqual({});
    expect(await a.engine.rows("order")).toEqual([]);
    await a.engine.recordMuts("order.create", big(10)); // the device still records; seq 1
    expect((await a.engine.vector()).devA).toBe(1);
  });

  it("counts UTF-8 bytes, not characters", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    // 90 000 three-byte characters are about 270 KB: under 262 144 characters, over 262 144 bytes.
    await expect(a.engine.recordMuts("order.create", big(0).map((m) => ({ ...m, f: { note: "க".repeat(90_000) } })))).rejects.toMatchObject({ code: "op_too_large" });
  });

  it("refuses pii over 16 KiB", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, schemas: restaurantRegistry() });
    const err = await a.engine.recordMuts("check.create", check("c1", { status: "open", customer_name: "n".repeat(MAX_PII_BYTES) })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "op_too_large", part: "pii", limit: MAX_PII_BYTES });
    expect(await a.engine.vector()).toEqual({});
  });
});
