import { describe, expect, it } from "vitest";
import { SeriesError, financialYear, formatNumber } from "./series";
import type { OpEnvelope } from "./types";
import { makeWorld, OUTLET } from "./testkit/harness";
import { authorBatch, deliver } from "./testkit/ship";

const sale = { code: "A07", docType: "tax_invoice", state: "active" } as const;
const note = { code: "A07", docType: "credit_note", state: "active" } as const;

const finalize = (e: Awaited<ReturnType<typeof makeWorld>>["devices"][number]["engine"], id: string) =>
  e.record({
    intent: "bill.finalize",
    build: (ctx) => [{ e: "bill", id, k: "insert", f: { number: ctx.number("tax_invoice"), total_paise: 1000 } }],
  });

describe("legal document numbers (ADR-0002 S7)", () => {
  it("are consecutive per series, at most 16 characters, and named in the op's doc field", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { grants: [sale] });
    const ops: OpEnvelope[] = [];
    for (let i = 0; i < 5; i++) ops.push(await finalize(d.engine, `b${i}`));
    expect(ops.map((o) => o.doc?.number)).toEqual(["A07/2627/000001", "A07/2627/000002", "A07/2627/000003", "A07/2627/000004", "A07/2627/000005"]);
    expect(ops[0]!.doc).toEqual({ type: "tax_invoice", number: "A07/2627/000001" });
    expect(ops.every((o) => o.doc!.number.length <= 16)).toBe(true);
    expect((await d.engine.rows("bill")).map((b) => b.number)).toEqual(ops.map((o) => o.doc!.number));
  });

  it("never collide across devices: each billing device holds its own code, and the credit-note series is separate", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { grants: [sale, note] });
    const b = await w.addDevice("devB", { grants: [{ code: "B3K", docType: "tax_invoice", state: "active" }] });
    const nums: string[] = [];
    for (let i = 0; i < 20; i++) {
      nums.push((await finalize(i % 2 ? a.engine : b.engine, `x${i}`)).doc!.number);
    }
    const cn = await a.engine.record({ intent: "credit_note.issue", build: (ctx) => [{ e: "credit_note", id: "c1", k: "insert", f: { number: ctx.number("credit_note"), against: "A07/2627/000001" } }] });
    expect(cn.doc!.number).toBe("A07/2627/000001"); // its own running count, same code, other document type
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums.filter((n) => n.startsWith("A07")).length).toBe(10);
  });

  it("a crash around finalisation neither burns nor duplicates a number", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { grants: [sale] });
    await finalize(d.engine, "b1");
    // The transaction allocates a number, then fails before commit.
    await expect(
      d.engine.record({
        intent: "bill.finalize",
        build: (ctx) => {
          ctx.number("tax_invoice");
          throw new Error("power cut");
        },
      }),
    ).rejects.toThrow("power cut");
    const next = await finalize(d.engine, "b2");
    expect(next.doc!.number).toBe("A07/2627/000002");
    // Process restart: a new engine over the same store continues the series.
    const again = await w.reopen(d);
    expect((await finalize(again.engine, "b3")).doc!.number).toBe("A07/2627/000003");
  });

  it("concurrent finalisations racing a background apply stay unique and gapless", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { grants: [sale] });
    const other = await w.addDevice("devOther", { grants: [] });
    await other.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: {} }]);
    const incoming = await authorBatch(other);
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 25; i++) {
      jobs.push(finalize(a.engine, `b${i}`));
      if (i % 5 === 0) jobs.push(a.engine.applyRemote(OUTLET, incoming.items, incoming.seals));
    }
    await Promise.all(jobs);
    const nums = (await a.engine.rows("bill")).map((b) => b.number as string).sort();
    expect(nums).toHaveLength(25);
    expect(nums[0]).toBe("A07/2627/000001");
    expect(nums[24]).toBe("A07/2627/000025");
    expect((await a.engine.vector()).devA).toBe(25); // seq gapless too
  });

  it("restart the count at 1 on 1 April IST, with the code carried over, without the cloud", async () => {
    expect(financialYear(Date.UTC(2027, 2, 31, 18, 29, 59))).toBe("2627"); // 23:59:59 IST on 31 March
    expect(financialYear(Date.UTC(2027, 2, 31, 18, 30, 0))).toBe("2728"); // 00:00:00 IST on 1 April
    expect(financialYear(Date.UTC(2026, 3, 1, 0, 0, 0))).toBe("2627");
    const w = await makeWorld();
    const d = await w.addDevice("devA", { grants: [sale] });
    w.clock.ms = Date.UTC(2027, 2, 31, 18, 29, 0);
    expect((await finalize(d.engine, "b1")).doc!.number).toBe("A07/2627/000001");
    w.clock.ms = Date.UTC(2027, 2, 31, 18, 31, 0); // device offline across the boundary
    expect((await finalize(d.engine, "b2")).doc!.number).toBe("A07/2728/000001");
    expect((await finalize(d.engine, "b3")).doc!.number).toBe("A07/2728/000002");
  });

  it("are not issued from a dormant or closed series, or when none was granted", async () => {
    const w = await makeWorld();
    const waiter = await w.addDevice("devW", { grants: [{ ...sale, state: "dormant" }] });
    await expect(finalize(waiter.engine, "b1")).rejects.toBeInstanceOf(SeriesError);
    const none = await w.addDevice("devN");
    await expect(finalize(none.engine, "b1")).rejects.toMatchObject({ reason: "no_active_series" });
    await waiter.engine.setSeriesGrants([{ ...sale, state: "active" }]); // owner activates it
    expect((await finalize(waiter.engine, "b2")).doc!.number).toBe("A07/2627/000001");
    await waiter.engine.setSeriesGrants([{ ...sale, state: "closed" }]);
    await expect(finalize(waiter.engine, "b3")).rejects.toMatchObject({ reason: "no_active_series" });
  });

  it("a restored or re-bound device is a new device with new codes and cannot re-issue the old ones", async () => {
    const w = await makeWorld();
    const old = await w.addDevice("devA", { grants: [sale] });
    await finalize(old.engine, "b1");
    // Restored from backup: new id, new code from the registry; the old grant is not in its pack.
    const restored = await w.addDevice("devA2", { grants: [{ code: "C9Z", docType: "tax_invoice", state: "active" }] });
    expect((await finalize(restored.engine, "b2")).doc!.number).toBe("C9Z/2627/000001");
  });

  it("validates the code alphabet and the running range", () => {
    expect(formatNumber("A07", "2627", 123)).toBe("A07/2627/000123");
    expect(() => formatNumber("a07", "2627", 1)).toThrow(SeriesError); // capitals and digits only
    expect(() => formatNumber("A0", "2627", 1)).toThrow(SeriesError); // exactly three characters
    expect(() => formatNumber("A07", "2627", 1_000_000)).toThrow(/range/);
  });

  it("travel with the op to every node and stay readable after sync", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { grants: [sale] });
    const rx = await w.addDevice("rx");
    await finalize(a.engine, "b1");
    await deliver(rx.engine, [await authorBatch(a)]);
    expect((await rx.engine.rows("bill"))[0]?.number).toBe("A07/2627/000001");
  });
});
