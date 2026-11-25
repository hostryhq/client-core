import { describe, expect, it } from "vitest";
import { makeWorld } from "./testkit/harness";

const m = [{ e: "order", id: "o1", k: "insert" as const, f: { n: 1 } }];
const bodyOf = async (d: { engine: { opAt(r: { origin: string; stream: string; seq: number }): Promise<unknown> } }, ref: { origin: string; stream: string; seq: number }) =>
  (await d.engine.opAt(ref)) as Record<string, unknown>;

/** ADR-0005 A3.1: the proof inputs travel once, inside the sealed body, on the op that carries the proof. */
describe("proof on the wire (ADR-0005 A3.1)", () => {
  it("pack_v is a JSON integer on every device op and cloud ops carry none", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const op = await a.engine.recordMuts("order.create", m);
    expect(op.pack_v).toBe(1);
    expect(JSON.parse((await a.engine.outbox(op.stream, {}, "own", 10)).items[0]!.body!).pack_v).toBe(1);
    a.engine.setPackVersion(7);
    expect((await a.engine.recordMuts("order.create", m)).pack_v).toBe(7);
    expect(() => a.engine.setPackVersion(0)).toThrow();
    expect(() => a.engine.setPackVersion(1.5)).toThrow();
    const ref = await w.cloud.emit(op.stream, "cfg.publish", [{ e: "order", id: "c1", k: "insert", f: {} }]);
    await a.runner.syncNow();
    const cloudOp = await bodyOf(a, ref);
    expect(cloudOp).toBeDefined();
    expect("pack_v" in cloudOp).toBe(false);
  });

  it("proof and pin_v are sealed on session.open and approval.grant, nowhere else", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const open = await a.engine.recordMuts("session.open", m, { proof: "P1", pinV: 3 });
    expect(open).toMatchObject({ proof: "P1", pin_v: 3 });
    const grant = await a.engine.recordMuts("approval.grant", m, { proof: "P2", pinV: 4 });
    expect(grant).toMatchObject({ proof: "P2", pin_v: 4 });
    const other = await a.engine.recordMuts("bill.void", m, { proof: "P3", pinV: 5 });
    expect("proof" in other).toBe(false);
    expect("pin_v" in other).toBe(false);
    const none = await a.engine.recordMuts("session.open", m);
    expect("proof" in none || "pin_v" in none).toBe(false); // a strong session carries no proof
  });

  it("a proof without a valid pin_v is refused before anything is recorded", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    await expect(a.engine.recordMuts("session.open", m, { proof: "P1" })).rejects.toThrow(/pinV/);
    await expect(a.engine.recordMuts("approval.grant", m, { proof: "P1", pinV: 0 })).rejects.toThrow(/pinV/);
    expect((await a.engine.vector())[a.id] ?? 0).toBe(0);
  });

  it("the at of session.open is the opening time the proof binds; on other ops at is the recording time", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const opened = a.engine.stampTime();
    expect(opened).toBe(new Date(w.clock.ms).toISOString());
    w.clock.advance(1500); // the PIN screen took a moment between the proof and the record
    const open = await a.engine.recordMuts("session.open", m, { proof: "P1", pinV: 2, at: opened });
    expect(open.at).toBe(opened);
    const later = await a.engine.recordMuts("order.create", m, { at: opened });
    expect(later.at).toBe(new Date(w.clock.ms).toISOString());
    await expect(a.engine.recordMuts("session.open", m, { proof: "P1", pinV: 2, at: "2026-11-24 08:00" })).rejects.toThrow(/at/);
  });
});
