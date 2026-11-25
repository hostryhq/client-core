import { describe, expect, it } from "vitest";
import { makeWorld } from "./testkit/harness";

/** F15: the gateway types a session from the `session` record of `session.open` and reads an approval from the `approval` record of `approval.grant`; the engine must accept both. */
describe("control records session and approval (api-specs sync/intents control.yaml)", () => {
  it("records a session.open with its session record and an approval.grant with its approval record", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const open = await a.engine.recordMuts("session.open", [{ e: "session", id: "s-1", k: "insert", f: { type: "pin" } }], { proof: "P1", pinV: 2 });
    expect(open.muts[0]).toMatchObject({ e: "session", id: "s-1", f: { type: "pin" } });
    const grant = await a.engine.recordMuts(
      "approval.grant",
      [{ e: "approval", id: "ap-1", k: "insert", f: { approver: "m2", permission: "bill.void", requester: "m1", action_hash: "ab", target: "", reason: "" } }],
      { proof: "P2", pinV: 3, approval: "ap-1" },
    );
    expect(grant.muts[0]).toMatchObject({ e: "approval", id: "ap-1" });
    expect(await a.engine.rows("session")).toHaveLength(1);
    expect(await a.engine.rows("approval")).toHaveLength(1);
  });
});
