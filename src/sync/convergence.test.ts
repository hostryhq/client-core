import { describe, expect, it } from "vitest";
import { makeWorld, OUTLET } from "./testkit/harness";

const policy = (op: { intent: string }) =>
  op.intent === "hold.manager" ? { hold: "held_manager" as const } : op.intent === "hold.support" ? { hold: "held_support" as const } : undefined;

/**
 * Soak T1 (Phase 2): 4 of 8 devices shared one state hash. The other 4 each held an op of their own that the cloud
 * quarantined (a bill-book entry, a KDS bump): the origin applies it locally, every peer holds only the placeholder
 * (ADR-0002 A1.2, RB3). That is by design, so `stateHash` differs until release; the convergence claim is judged on
 * `acceptedStateHash`, the state without the origin's own held ops.
 */
describe("convergence with quarantined own ops (soak T1)", () => {
  it("devices that differ only by their own held ops share one accepted-state hash; release makes the full hash equal too", async () => {
    const w = await makeWorld({ policy });
    const a = await w.addDevice("devA", { withHub: false });
    const b = await w.addDevice("devB", { withHub: false });
    const c = await w.addDevice("devC", { withHub: false });
    await a.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: { n: 1 } }]);
    const heldA = await a.engine.recordMuts("hold.support", [{ e: "order", id: "bookA", k: "insert", f: { n: 2 } }]);
    const heldB = await b.engine.recordMuts("hold.manager", [{ e: "order", id: "bumpB", k: "insert", f: { n: 3 } }]);
    await c.engine.recordMuts("order.create", [{ e: "order", id: "o2", k: "insert", f: { n: 4 } }]);
    await w.settle();
    await w.settle();

    const devs = [a, b, c];
    const full = await Promise.all(devs.map((d) => d.engine.stateHash()));
    expect(new Set(full).size).toBe(3); // each origin shows its own held op, peers only the placeholder
    const accepted = await Promise.all(devs.map((d) => d.engine.acceptedStateHash()));
    expect(new Set(accepted).size).toBe(1);
    // The origin still shows its own row to its staff.
    expect((await a.engine.rows("order")).map((r) => r.id).sort()).toEqual(["bookA", "o1", "o2"]);

    w.cloud.release({ origin: "devA", stream: OUTLET, seq: heldA.seq });
    w.cloud.release({ origin: "devB", stream: OUTLET, seq: heldB.seq });
    await w.settle();
    await w.settle();
    const after = await Promise.all(devs.map((d) => d.engine.stateHash()));
    expect(new Set(after).size).toBe(1);
    // Released ops now count: the accepted view equals the full one on every device.
    expect(await Promise.all(devs.map((d) => d.engine.acceptedStateHash()))).toEqual(after);
  });
});
