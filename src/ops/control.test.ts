import { describe, expect, it } from "vitest";
import { restaurantRegistry } from "../sync";
import { makeWorld, OUTLET } from "../sync/testkit/harness";
import { approvalActionHash, approvalGrantSpec, boundValues, deviceSessionDue, sessionOpenSpec } from "./control";
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
    const { d, w } = await device();
    const { values, missing } = boundValues("bill.cancel", [{ e: "check_cancel", id: "cc-1", k: "insert", f: { check_id: "c-9", reason_code_id: "rc-1" } }]);
    expect(missing).toEqual([]);
    const target = "check_cancel:cc-1";
    const hash = await approvalActionHash({ intent: "bill.cancel", permission: "bill.cancel", requester: "m-asha", target, approvalId: "ap-1", reason: "wrong item", values });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const at = d.engine.stampTime();
    const op = await w.record(
      approvalGrantSpec({ approvalId: "ap-1", approverId: "m-meena", requesterId: "m-asha", permission: "bill.cancel", intent: "bill.cancel", target, reason: "wrong item", actionHash: hash, sid: "s-1", proof: "P", pinV: 3, at }),
    );
    expect(op.muts).toEqual([{ e: "approval", id: "ap-1", k: "insert", f: { permission: "bill.cancel", intent: "bill.cancel", requester: "m-asha", action_hash: hash, target, reason: "wrong item" } }]);
    expect(op).toMatchObject({ intent: "approval.grant", actor: "m-meena", sid: "s-1", approval: "ap-1", proof: "P", pin_v: 3, at });
  });

  it("approval.self_confirm is the same record with requester = approver, and the two intents are not interchangeable", async () => {
    const { d, w } = await device();
    const base = { approvalId: "ap-2", approverId: "m-asha", permission: "bill.cancel", intent: "bill.cancel", target: "check_cancel:cc-2", reason: "", actionHash: "sha256:x", sid: "s-1", proof: "P", pinV: 1 };
    const op = await w.record(approvalGrantSpec({ ...base, requesterId: "m-asha", self: true, at: d.engine.stampTime() }));
    expect(op.intent).toBe("approval.self_confirm");
    expect(op.muts[0]!.f).not.toHaveProperty("reason");
    expect(() => approvalGrantSpec({ ...base, requesterId: "m-asha", at: "x" })).toThrow(RangeError);
    expect(() => approvalGrantSpec({ ...base, requesterId: "m-other", self: true, at: "x" })).toThrow(RangeError);
  });

  it("a KDS device session is due at a new business day and at 26 hours", () => {
    const s = { openedAtMs: Date.UTC(2026, 10, 24, 4, 0), businessDate: "2026-11-24" };
    expect(deviceSessionDue(s, { ms: s.openedAtMs + 3_600_000, businessDate: "2026-11-24" })).toBe(false);
    expect(deviceSessionDue(s, { ms: s.openedAtMs + 3_600_000, businessDate: "2026-11-25" })).toBe(true);
    expect(deviceSessionDue(s, { ms: s.openedAtMs + 26 * 3_600_000 })).toBe(true);
    expect(deviceSessionDue(s, { ms: s.openedAtMs + 26 * 3_600_000 - 1 })).toBe(false);
  });

  it("the writer refuses a record the intent does not list", async () => {
    const { w } = await device();
    await expect(w.record({ intent: "session.open", build: () => [{ e: "approval", id: "x", k: "insert", f: {} }] })).rejects.toThrow(IntentError);
    await expect(w.record({ intent: "session.open", build: () => [{ e: "session", id: "x", k: "set", f: {} }] })).rejects.toThrow(/kind_not_allowed/);
  });
});
