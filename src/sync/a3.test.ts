import { describe, expect, it } from "vitest";
import { b64url, fromB64url } from "./crypto";
import { COMMIT_PREFIX, digestRowText, entityDigest } from "./digest";
import { actionHash, actionValues, approvalProofMessage, goQuote, sessionProofMessage } from "./proof";
import { servesPii, type DeviceKind } from "./pii-serve";
import { DEMO_SCHEMAS, SchemaRegistry } from "./schema";
import { InMemoryStore } from "../store";
import { SyncEngine } from "./engine";
import { makeWorld, OUTLET, type Device } from "./testkit/harness";
import vectors from "./testkit/vectors-v1.json";
import { authorBatch } from "./testkit/ship";
import type { OpRef } from "./types";

const PHONE = "+919800011122";
const NAME = "Asha Raman";
const piiSchemas = (): SchemaRegistry => new SchemaRegistry([...DEMO_SCHEMAS.filter((s) => s.name !== "order"), { name: "order", policy: "append", pii: ["customer_phone", "customer_name"] }]);

async function hmac(keyB64: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromB64url(keyB64) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

describe("api-specs vectors: proofs and the action hash", () => {
  it("action_hash: every case, and the OV2 mismatch is a different hash", async () => {
    for (const c of vectors.action_hash) {
      const h = await actionHash({ intent: c.intent, permission: c.permission, requester: c.requester, target: c.target, approvalId: c.approval_id, reason: c.reason, values: c.values });
      expect(h, c.case).toBe(c.action_hash);
      if ("matches_approved" in c) expect(h === c.approved_action_hash).toBe(c.matches_approved);
    }
  });

  it("approval_proof: the message bytes and the HMAC, with Go-quoted free text", async () => {
    const key = vectors.approval_proof.proof_key;
    for (const c of vectors.approval_proof.cases) {
      const message =
        c.kind === "session"
          ? sessionProofMessage({ sessionId: c.session_id!, deviceId: c.device_id, memberId: c.member_id, packV: c.pack_v, pinV: c.pin_v, openedAt: c.opened_at! })
          : approvalProofMessage({
              actionHash: c.action_hash!,
              deviceId: c.device_id,
              memberId: c.member_id,
              packV: c.pack_v,
              pinV: c.pin_v,
              approvalId: c.approval_id!,
              permission: c.permission!,
              target: c.target!,
              requesterId: c.requester_id!,
              approvedAt: c.approved_at!,
              reason: c.reason!,
            });
      expect(message, c.case).toBe(c.message);
      expect(await hmac(key, message), c.case).toBe(c.proof);
    }
  });

  it("goQuote follows Go strconv.Quote", () => {
    expect(goQuote('a|b"c\\d\n\u0007')).toBe('"a|b\\"c\\\\d\\n\\a"');
    expect(goQuote("café 中文")).toBe('"café 中文"');
    expect(goQuote("\u0000\u007f ​")).toBe('"\\x00\\x7f\\u00a0\\u200b"');
  });

  it("action values come from the first mutation that sets each bound name; a name the op does not set is reported", () => {
    const muts = [
      { e: "bill", id: "b1", k: "insert" as const, f: { total_paise: 100 } },
      { e: "bill", id: "b1", k: "set" as const, f: { total_paise: 200 } },
    ];
    expect(actionValues(["total_paise"], muts)).toEqual({ values: { total_paise: 100 }, missing: [] });
    expect(actionValues(["total_paise", "bill_id"], muts).missing).toEqual(["bill_id"]);
  });
});

describe("api-specs vectors: digest rows and pii placement", () => {
  it("digest_row: the text carries commitments and never a value; the entity hash matches", async () => {
    for (const c of vectors.digest_row) {
      const row: Record<string, unknown> = { id: c.id, ...c.fields, ...(c.pii_values as Record<string, unknown>) };
      for (const [f, commit] of Object.entries(c.commitments)) row[COMMIT_PREFIX + f] = commit;
      const text = digestRowText({ ...row, tenant_id: "t1" } as never, c.pii_fields);
      expect(text, c.case).toBe(c.row_text);
      expect((await entityDigest([{ id: c.id, text }])).hash, c.case).toBe(c.entity_hash);
    }
  });

  it("pii_placement: every kind but kds is served", () => {
    for (const c of vectors.pii_placement.cases) expect(servesPii(c.kind as DeviceKind), c.kind).toBe(c.pii_served);
  });
});

async function world() {
  const w = await makeWorld();
  const a = await w.addDevice("devA", { withHub: false, schemas: piiSchemas(), kind: "pos" });
  const b = await w.addDevice("devB", { withHub: false, schemas: piiSchemas(), kind: "waiter" });
  const k = await w.addDevice("devK", { withHub: false, schemas: piiSchemas(), kind: "kds" });
  await a.engine.record({
    intent: "order.create",
    pii: { order: { o1: { customer_phone: PHONE, customer_name: NAME } } },
    build: () => [{ e: "order", id: "o1", k: "insert", f: { table: "T1" } }],
  });
  await w.settle();
  return { w, a, b, k };
}

describe("ADR-0014 A3.1/A3.2 on the engine", () => {
  it("PA3: the state hash is equal on the origin, a waiter and a kds, and unchanged by erasure", async () => {
    const { w, a, b, k } = await world();
    const before = [await a.engine.stateHash(), await b.engine.stateHash(), await k.engine.stateHash()];
    expect(new Set(before).size).toBe(1);
    expect(new Set([await a.engine.acceptedStateHash(), await b.engine.acceptedStateHash(), await k.engine.acceptedStateHash()]).size).toBe(1);
    await w.cloud.erasePii({ origin: "devA", stream: OUTLET, seq: 1 });
    await w.settle();
    const after = [await a.engine.stateHash(), await b.engine.stateHash(), await k.engine.stateHash()];
    expect(after).toEqual(before);
  });

  it("PA1: a kds holds the commitment and no value; a waiter holds the value", async () => {
    const { b, k } = await world();
    const at = async (d: Device) => (await d.engine.outbox(OUTLET, {}, "all", 100)).items.find((i) => i.origin === "devA")!;
    expect(JSON.stringify((await at(b)).pii)).toContain(PHONE);
    expect((await at(k)).pii).toBeUndefined();
    expect((await k.store.get("order", "o1"))!["~c:customer_phone"]).toBeDefined();
    expect(await k.engine.piiIncomplete()).toEqual([]);
  });

  it("a kds drops pii even when it is pushed at it", async () => {
    const { a, k } = await world();
    const batch = await authorBatch(a);
    await k.engine.applyRemote(OUTLET, batch.items, batch.seals);
    expect(JSON.stringify(await k.store.list("_s_op"))).not.toContain(PHONE);
  });

  it("PA4: a stripped field is pii_incomplete and fetched at the next contact; a tampered one is refused", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, schemas: piiSchemas() });
    const b = await w.addDevice("devB", { withHub: false, schemas: piiSchemas() });
    await a.engine.record({ intent: "order.create", pii: { order: { o1: { customer_phone: PHONE } } }, build: () => [{ e: "order", id: "o1", k: "insert", f: {} }] });
    const batch = await authorBatch(a);
    const stripped = batch.items.map((it) => ({ ...it, pii: undefined }));
    await b.engine.applyRemote(OUTLET, stripped, batch.seals);
    const ref: OpRef = { origin: "devA", stream: OUTLET, seq: 1 };
    expect(await b.engine.piiIncomplete()).toEqual([{ ...ref, fields: [{ e: "order", id: "o1", f: "customer_phone" }] }]);
    // a tampered value fills nothing
    const bad = structuredClone(batch.items[0]!);
    (bad.pii as Record<string, Record<string, Record<string, unknown>>>).order!.o1!.customer_phone = "+911111111111";
    await b.engine.applyRemote(OUTLET, [bad], batch.seals);
    expect((await b.engine.piiIncomplete()).length).toBe(1);
    // the real upstream is asked again by the runner
    await w.syncDevice(a);
    await w.syncDevice(b);
    expect(await b.engine.piiIncomplete()).toEqual([]);
    expect(JSON.stringify((await b.engine.outbox(OUTLET, {}, "all", 100)).items)).toContain(PHONE);
  });

  it("PA5: an erased field is not pii_incomplete", async () => {
    const { w, b } = await world();
    await w.cloud.erasePii({ origin: "devA", stream: OUTLET, seq: 1 });
    await w.settle();
    expect(await b.engine.piiIncomplete()).toEqual([]);
  });
});

describe("ADR-0002 A3.5 placement: another origin's pii only where the credential says protected", () => {
  const at = async (d: Device) => JSON.stringify(await d.store.list("_s_op"));

  it("PP1: an unprotected pos pulling from hub and gateway gets commitments only; protected gets the values; own pii is kept", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: true, schemas: piiSchemas() });
    const prot = await w.addDevice("devP", { withHub: true, schemas: piiSchemas() });
    const unprot = await w.addDevice("devU", { withHub: true, schemas: piiSchemas(), storeClaim: "unprotected" });
    await a.engine.record({ intent: "order.create", pii: { order: { o1: { customer_phone: PHONE } } }, build: () => [{ e: "order", id: "o1", k: "insert", f: {} }] });
    // the unprotected device has its own order with pii too
    await unprot.engine.record({ intent: "order.create", pii: { order: { o2: { customer_phone: "+919811100000" } } }, build: () => [{ e: "order", id: "o2", k: "insert", f: {} }] });
    await w.settle();
    expect(await at(prot)).toContain(PHONE);
    expect(await at(unprot)).not.toContain(PHONE);
    expect(await at(unprot)).toContain("+919811100000"); // own pii unaffected
    const ref: OpRef = { origin: "devA", stream: OUTLET, seq: 1 };
    expect(await unprot.engine.piiIncomplete()).toEqual([{ ...ref, fields: [{ e: "order", id: "o1", f: "customer_phone" }] }]);
    expect(await unprot.engine.piiIncomplete({ fetchable: true })).toEqual([]); // not asked for again: placement refuses it
    // commitments are held, so the convergence hash still agrees
    expect(await unprot.engine.stateHash()).toBe(await prot.engine.stateHash());
  });

  it("an unprotected device drops pii pushed at it directly, and refuses to fill it from a re-served op", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, schemas: piiSchemas() });
    const u = await w.addDevice("devU", { withHub: false, schemas: piiSchemas(), storeClaim: "unprotected" });
    await a.engine.record({ intent: "order.create", pii: { order: { o1: { customer_phone: PHONE } } }, build: () => [{ e: "order", id: "o1", k: "insert", f: {} }] });
    const batch = await authorBatch(a);
    await u.engine.applyRemote(OUTLET, batch.items, batch.seals);
    await u.engine.applyRemote(OUTLET, batch.items, batch.seals); // re-served with pii: must not fill
    expect(await at(u)).not.toContain(PHONE);
  });

  it("the named dev/test switch lifts the rule", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false, schemas: piiSchemas() });
    const u = await w.addDevice("devU", { withHub: false, schemas: piiSchemas(), storeClaim: "unprotected" });
    await a.engine.record({ intent: "order.create", pii: { order: { o1: { customer_phone: PHONE } } }, build: () => [{ e: "order", id: "o1", k: "insert", f: {} }] });
    const batch = await authorBatch(a);
    const off = await SyncEngine.open({ store: new InMemoryStore("t1"), schemas: piiSchemas(), deviceId: "devX", outletStream: OUTLET, signer: u.signer, verifier: w.ring, packVersion: 1, storeClaim: "unprotected", placementOff: true });
    await off.applyRemote(OUTLET, batch.items, batch.seals);
    expect(JSON.stringify(await off.outbox(OUTLET, {}, "all", 100))).toContain(PHONE);
  });
});
