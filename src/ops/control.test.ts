import { describe, expect, it } from "vitest";
import { restaurantRegistry } from "../sync";
import { makeWorld, OUTLET } from "../sync/testkit/harness";
import { approvalActionHash, approvalGrantSpec, sessionOpenSpec } from "./control";
import { IntentError } from "./intents";
import { EngineOpWriter } from "./writer";

/** F15: `session.open` and `approval.grant` carry the `session` and `approval` records the gateway reads (api-specs sync/intents control.yaml, records). */
const device = async () => {
  const world = await makeWorld();
  const d = await world.addDevice("devA", { schemas: restaurantRegistry(), withHub: false });
  const writer = new EngineOpWriter(d.engine);
  /** Records the spec and returns the sealed op as the engine holds it. */
  const w = {
    record: async (spec: Parameters<EngineOpWriter["record"]>[0]) => (await d.engine.opAt({ origin: d.id, stream: OUTLET, seq: (await writer.record(spec)).seq }))!,
  };
  return { d, w };
};

describe("session.open and approval.grant builders", () => {
  it("a pin session.open carries a session record of type pin, with the proof and pin_v", async () => {
    const { d, w } = await device();
    const op = await w.record(sessionOpenSpec({ sid: "s-1", actor: "m-asha", type: "pin", proof: "P", pinV: 2, at: d.engine.stampTime() }));
    expect(op.intent).toBe("session.open");
    expect(op.muts).toEqual([{ e: "session", id: "s-1", k: "insert", f: { type: "pin" } }]);
    expect(op).toMatchObject({ proof: "P", pin_v: 2, sid: "s-1", actor: "m-asha" });
  });

  it("a device session.open (KDS) names no member and carries no proof", async () => {
    const { d, w } = await device();
    const op = await w.record(sessionOpenSpec({ sid: "s-k", actor: `device:${d.id}`, type: "device" }));
    expect(op.muts[0]).toMatchObject({ e: "session", id: "s-k", f: { type: "device" } });
    expect("proof" in op).toBe(false);
    expect(op.actor).toBe(`device:${d.id}`);
  });

  it("a proof needs a pin_v and a pin session needs a proof", () => {
    expect(() => sessionOpenSpec({ sid: "s", actor: "m", type: "pin", pinV: 1 })).toThrow(RangeError);
    expect(() => sessionOpenSpec({ sid: "s", actor: "m", type: "device", proof: "P", pinV: 1 })).toThrow(RangeError);
  });

  it("approval.grant carries the approval record the gateway binds into the action proof, under the approver", async () => {
    const { w } = await device();
    const actionHash = await approvalActionHash({ approvalId: "ap-1", permission: "bill.void", requesterId: "m-asha", target: "bill-9" });
    expect(actionHash).toMatch(/^[0-9a-f]{64}$/);
    const op = await w.record(
      approvalGrantSpec({ approvalId: "ap-1", approverId: "m-meena", requesterId: "m-asha", permission: "bill.void", target: "bill-9", reason: "wrong item", actionHash, sid: "s-1", proof: "P", pinV: 3 }),
    );
    expect(op.muts).toEqual([
      { e: "approval", id: "ap-1", k: "insert", f: { approver: "m-meena", permission: "bill.void", requester: "m-asha", action_hash: actionHash, target: "bill-9", reason: "wrong item" } },
    ]);
    expect(op).toMatchObject({ actor: "m-meena", sid: "s-1", approval: "ap-1", proof: "P", pin_v: 3 });
  });

  it("the writer refuses a record the intent does not list", async () => {
    const { w } = await device();
    await expect(w.record({ intent: "session.open", build: () => [{ e: "approval", id: "x", k: "insert", f: {} }] })).rejects.toThrow(IntentError);
    await expect(w.record({ intent: "session.open", build: () => [{ e: "session", id: "x", k: "set", f: {} }] })).rejects.toThrow(/kind_not_allowed/);
  });
});
