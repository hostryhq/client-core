import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { KeyRing } from "./crypto";
import { drainSigningMessage, drainStatementHash, DRAIN_TAG, type DrainStatement } from "./drain";
import { SyncRunner } from "./runner";
import { toWireVector, type PushRequest, type PushResponse, type SyncTransport } from "./transport";
import vectors from "./testkit/vectors-v1.json";
import { makeWorld, OUTLET } from "./testkit/harness";

const order = (id: string) => [{ e: "order", id, k: "insert" as const, f: { n: id } }];

/** ADR-0005 A3.3: the device-signed list of everything a revoked device holds and its last numbers. */
describe("drain statement hostry-drain-v1 matches the shared vectors", () => {
  const cases = (vectors as unknown as { drain_statement: Array<{ case: string; pub: string; sig_valid: boolean; signed_message: string; statement: DrainStatement; statement_hash: string; statement_jcs: string }> }).drain_statement;

  it("signing message, JCS text, hash and signature verdict equal the vector for each case", async () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      const { sig: _sig, ...unsigned } = c.statement;
      void _sig;
      expect(drainSigningMessage(unsigned)).toBe(c.signed_message);
      expect(canonicalize(c.statement)).toBe(c.statement_jcs);
      expect(await drainStatementHash(c.statement)).toBe(c.statement_hash);
      const ring = new KeyRing();
      await ring.add(c.statement.by, c.statement.kid, c.pub);
      expect(await ring.verify(c.statement.by, c.statement.kid, c.signed_message, c.statement.sig)).toBe(c.sig_valid);
    }
    expect(DRAIN_TAG).toBe("hostry-drain-v1");
  });
});

/** A cloud that accepts drain uploads and only tracks what it stored, like the quarantine endpoint. */
function drainCloud(deviceId: string) {
  const stored: Record<string, number> = {};
  const calls: PushRequest[] = [];
  let reachable = true;
  const t: SyncTransport = {
    hello: async () => {
      throw new Error("a drain token may only call quarantine-upload");
    },
    push: async () => {
      throw new Error("a drain token may only call quarantine-upload");
    },
    pull: async () => {
      throw new Error("a drain token may only call quarantine-upload");
    },
    uploadQuarantine: async (req: PushRequest): Promise<PushResponse> => {
      if (!reachable) throw new Error("network unreachable");
      calls.push(req);
      for (const it of req.items) stored[`${it.stream}`] = Math.max(stored[it.stream] ?? 0, it.seq);
      const vec: Record<string, Record<string, number>> = {};
      for (const [s, seq] of Object.entries(stored)) vec[s] = { [deviceId]: seq };
      return { vector: toWireVector(vec), drained: req.drain_statement !== undefined };
    },
  };
  return { t, calls, stored, setReachable: (v: boolean) => (reachable = v) };
}

describe("drain upload and statement from a revoked device", () => {
  const grants = [
    { code: "A7K", docType: "tax_invoice" as const, state: "active" as const, seriesId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c" },
    { code: "A7M", docType: "credit_note" as const, state: "active" as const, seriesId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a95" },
  ];

  it("uploads every own op, then one last empty upload carries the signed statement of heads and last numbers", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, grants });
    for (let i = 0; i < 5; i++) await a.engine.recordMuts("order.create", order(`o${i}`));
    await a.engine.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: "b1", k: "insert", f: { number: c.number("tax_invoice"), total_paise: 100 } }] });
    await a.engine.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: "b2", k: "insert", f: { number: c.number("tax_invoice"), total_paise: 100 } }] });
    const cloud = drainCloud("devA");
    const r = new SyncRunner({ engine: a.engine, cloud: cloud.t, now: w.clock.now, batch: 3 });
    const res = await r.drain();

    expect(res.drained).toBe(true);
    expect(cloud.stored[OUTLET]).toBe(7);
    const last = cloud.calls[cloud.calls.length - 1]!;
    expect(last.items).toEqual([]);
    expect(cloud.calls.slice(0, -1).every((c) => c.drain_statement === undefined && c.items.length > 0)).toBe(true);
    const st = last.drain_statement!;
    expect(st).toMatchObject({ origin: "devA", by: "devA", kid: a.signer.kid });
    expect(st.rec).toBeUndefined();
    const head = await a.engine.hashAt({ origin: "devA", stream: OUTLET, seq: 7 });
    expect(st.streams).toEqual([{ stream: OUTLET, seq: 7, h: head }]);
    expect(st.series.map((s) => [s.series_id, s.code, s.last_number]).sort()).toEqual([
      ["0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c", "A7K", 2],
      ["0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a95", "A7M", 0],
    ]);
    expect(st.series.every((s) => /^\d{4}$/.test(s.fy))).toBe(true);
    expect(st.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const { sig, ...unsigned } = st;
    expect(await w.ring.verify("devA", a.signer.kid, drainSigningMessage(unsigned), sig)).toBe(true);

    // The device signed it and can say so; it is a statement of all its local ops while it is still true.
    const hash = await drainStatementHash(st);
    expect(await a.engine.ownsDrainStatement(hash)).toBe(true);
    expect(await a.engine.ownsDrainStatement("00".repeat(32))).toBe(false);
    // In drain mode it records nothing new, which also keeps the statement true.
    await expect(a.engine.recordMuts("order.create", order("late"))).rejects.toThrow(/drain/i);
  });

  it("does not sign while the upload has not covered every own head; the next drain resumes and then signs", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, grants });
    for (let i = 0; i < 4; i++) await a.engine.recordMuts("order.create", order(`o${i}`));
    const cloud = drainCloud("devA");
    const r = new SyncRunner({ engine: a.engine, cloud: cloud.t, now: w.clock.now, batch: 2 });
    let n = 0;
    const real = cloud.t.uploadQuarantine!;
    cloud.t.uploadQuarantine = async (q) => {
      if (++n === 2) throw new Error("connection cut");
      return real(q);
    };
    const first = await r.drain();
    expect(first.drained).toBe(false);
    expect(cloud.calls.some((c) => c.drain_statement)).toBe(false);
    const second = await r.drain();
    expect(second.drained).toBe(true);
    expect(cloud.stored[OUTLET]).toBe(4);
    expect(cloud.calls.filter((c) => c.drain_statement)).toHaveLength(1);
  });

  it("a restart in drain mode stays in drain mode", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, grants });
    await a.engine.recordMuts("order.create", order("o1"));
    await a.engine.beginDrain();
    const b = await w.reopen(a);
    await expect(b.engine.recordMuts("order.create", order("o2"))).rejects.toThrow(/drain/i);
  });
});
