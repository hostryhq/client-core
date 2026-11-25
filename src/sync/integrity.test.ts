import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { SoftwareSigner, genesisHash, makeSeal, sha256Hex, verifySeal } from "./crypto";
import { KeyLostError } from "./engine";
import { packHlc } from "./hlc";
import type { OpEnvelope, WireItem } from "./types";
import { makeWorld, OUTLET, T0 } from "./testkit/harness";
import { authorBatch, deliver } from "./testkit/ship";

async function writer(n = 4) {
  const w = await makeWorld();
  const a = await w.addDevice("devA", { withHub: false });
  const rx = await w.addDevice("rx", { withHub: false });
  for (let i = 0; i < n; i++) await a.engine.recordMuts("order.create", [{ e: "order", id: `o${i}`, k: "insert", f: { n: i } }]);
  return { w, a, rx, batch: await authorBatch(a) };
}

const body = (it: WireItem): OpEnvelope => JSON.parse(it.body!) as OpEnvelope;
const reseal = async (it: WireItem, edit: (o: OpEnvelope) => void): Promise<WireItem> => {
  const o = body(it);
  edit(o);
  const text = canonicalize(o);
  return { ...it, body: text, h: await sha256Hex(text) };
};

describe("chain and seal (ADR-0002 S17)", () => {
  it("applies a sealed, chained batch", async () => {
    const { rx, batch } = await writer();
    const r = await rx.engine.applyRemote(OUTLET, batch.items, batch.seals);
    expect(r).toMatchObject({ applied: 4, rejected: [] });
    expect((await rx.engine.vector()).devA).toBe(4);
  });

  it("refuses an op whose body was altered in transit", async () => {
    const { rx, batch } = await writer();
    const items = batch.items.map((it) => ({ ...it }));
    items[2]!.body = items[2]!.body!.replace('"n":2', '"n":99');
    const r = await rx.engine.applyRemote(OUTLET, items, batch.seals);
    expect(r.applied).toBe(0); // ops 1-2 are chained but not covered by a seal that reaches them; nothing is trusted
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(await rx.engine.rows("order")).toHaveLength(0);
  });

  it("refuses a relay that alters an op and fixes up its hash (the seal no longer matches the chain)", async () => {
    const { rx, batch } = await writer();
    const items = [...batch.items];
    items[1] = await reseal(items[1]!, (o) => ((o.muts[0]!.f as Record<string, unknown>).n = 99));
    const r = await rx.engine.applyRemote(OUTLET, items, batch.seals);
    expect(r.applied).toBe(0);
    expect(r.rejected[0]?.reason).toMatch(/chain broken/); // op 3's ph still names the original op 2
    expect(await rx.engine.rows("order")).toHaveLength(0);
  });

  it("refuses a dropped op in the middle: nothing after the gap is applied", async () => {
    const { rx, batch } = await writer();
    const items = batch.items.filter((it) => it.seq !== 2);
    const r = await rx.engine.applyRemote(OUTLET, items, batch.seals);
    expect(r.gaps).toEqual(["devA:2"]);
    expect(r.applied).toBe(0); // op 1 alone is not covered by the seal at 4
    expect((await rx.engine.vector()).devA ?? 0).toBe(0);
  });

  it("holds out-of-order delivery until the gap is filled, then applies everything once", async () => {
    const { rx, batch } = await writer();
    const late = await rx.engine.applyRemote(OUTLET, batch.items.slice(2), batch.seals);
    expect(late.gaps).toHaveLength(1);
    expect(late.applied).toBe(0);
    const full = await rx.engine.applyRemote(OUTLET, batch.items, batch.seals);
    expect(full.applied).toBe(4);
  });

  it("refuses an injected op: a forged next op chains correctly but no seal covers it", async () => {
    const { rx, a, batch } = await writer(2);
    await rx.engine.applyRemote(OUTLET, batch.items, batch.seals);
    const prev = batch.items[1]!;
    const forged = { ...body(prev), seq: 3, ph: prev.h, hlc: packHlc(T0, 9), muts: [{ e: "order", id: "evil", k: "insert", f: { n: 666 } }] } as OpEnvelope;
    const text = canonicalize(forged);
    const item: WireItem = { origin: "devA", stream: OUTLET, seq: 3, h: await sha256Hex(text), body: text };
    const r = await rx.engine.applyRemote(OUTLET, [item], batch.seals); // reusing the old seal at 2
    expect(r.applied).toBe(0);
    expect(r.rejected[0]?.reason).toMatch(/no seal/);
    expect(await rx.store.get("order", "evil")).toBeUndefined();
    expect(a.engine.deviceId).toBe("devA");
  });

  it("refuses a seal signed by another key, and ops with no seal at all", async () => {
    const { w, rx, batch } = await writer();
    const impostor = await SoftwareSigner.generate("k-devA"); // same kid, different key
    const last = batch.items[3]!;
    const bad = await makeSeal(impostor, "devA", OUTLET, 4, last.h);
    expect((await rx.engine.applyRemote(OUTLET, batch.items, [bad])).applied).toBe(0);
    expect((await rx.engine.applyRemote(OUTLET, batch.items, [])).applied).toBe(0);
    expect(await verifySeal(w.ring, bad)).toBe(false);
  });

  it("accepts a valid re-offer: another origin's ops relayed by a third node under the origin's own seal", async () => {
    const { w, rx, batch } = await writer();
    await rx.engine.applyRemote(OUTLET, batch.items, batch.seals);
    const out = await rx.engine.outbox(OUTLET, {}, "all"); // rx now relays devA's ops
    expect(out.items).toHaveLength(4);
    const res = await w.cloud.push(out);
    expect(res.refused).toEqual([]);
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1, 2, 3, 4]);
  });

  it("chains the first op to the hash of the origin and stream ids, and every op to the one before", async () => {
    const { batch } = await writer(3);
    expect(body(batch.items[0]!).ph).toBe(await genesisHash("devA", OUTLET));
    expect(body(batch.items[1]!).ph).toBe(batch.items[0]!.h);
    expect(body(batch.items[2]!).ph).toBe(batch.items[1]!.h);
  });

  it("keeps personal data outside the hash: erasing pii leaves the chain intact", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const rx = await w.addDevice("rx", { withHub: false });
    await a.engine.record({ intent: "order.create", pii: { phone: "+910000000000" }, build: () => [{ e: "order", id: "o1", k: "insert", f: {} }] });
    await a.engine.recordMuts("order.create", [{ e: "order", id: "o2", k: "insert", f: {} }]);
    const b = await authorBatch(a);
    expect(b.items[0]!.pii).toEqual({ phone: "+910000000000" });
    expect(b.items[0]!.body).not.toContain("phone");
    const erased = b.items.map((it) => ({ ...it, pii: undefined }));
    expect((await rx.engine.applyRemote(OUTLET, erased, b.seals)).applied).toBe(2);
  });
});

describe("tenancy", () => {
  it("refuses an op of another tenant and never shows another tenant's rows", async () => {
    const { w, rx, batch } = await writer(2);
    const items = [...batch.items];
    items[0] = await reseal(items[0]!, (o) => (o.tenant_id = "t2"));
    // A hostile peer re-seals nothing it cannot sign; even a valid chain for another tenant is refused.
    const foreign = await w.addDevice("devForeign", { withHub: false });
    const ft = canonicalize({ ...body(batch.items[0]!), origin: "devForeign", ph: await genesisHash("devForeign", OUTLET), tenant_id: "t2" });
    const fi: WireItem = { origin: "devForeign", stream: OUTLET, seq: 1, h: await sha256Hex(ft), body: ft };
    const seal = await makeSeal(foreign.signer, "devForeign", OUTLET, 1, fi.h);
    const r = await rx.engine.applyRemote(OUTLET, [fi], [seal]);
    expect(r.applied).toBe(0);
    expect(r.rejected[0]?.reason).toBe("tenant mismatch");
    expect(await rx.engine.rows("order")).toHaveLength(0);
    expect((await rx.engine.vector()).devForeign ?? 0).toBe(0);
  });

  it("refuses a stream the device is not bound to", async () => {
    const { rx, batch } = await writer(1);
    const r = await rx.engine.applyRemote("outlet:other", batch.items, batch.seals);
    expect(r.rejected[0]?.reason).toMatch(/not bound/);
  });
});

describe("clock discipline (ADR-0002 S5)", () => {
  it("quarantines a last-writer-wins op stamped by a confirmed-manual clock or 10 minutes ahead; append ops always apply", async () => {
    const w = await makeWorld();
    const manual = await w.addDevice("devM", { withHub: false, clockMode: "manual" });
    const fast = await w.addDevice("devF", { withHub: false, skewMs: 11 * 60_000 });
    const rx = await w.addDevice("rx", { withHub: false });
    await manual.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m1", k: "insert", f: { price_paise: 100 } }]);
    await manual.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: {} }]);
    await fast.engine.recordMuts("menu.add", [{ e: "menu_item", id: "m2", k: "insert", f: { price_paise: 200 } }]);
    await deliver(rx.engine, [await authorBatch(manual), await authorBatch(fast)]);
    expect(await rx.engine.rows("menu_item")).toHaveLength(0); // held for a manager
    expect(await rx.engine.rows("order")).toHaveLength(1); // append is always accepted
    expect(await rx.engine.clockQuarantine()).toHaveLength(2);
    expect(rx.engine.status().state).toBe("conflict");
    for (const ref of await rx.engine.clockQuarantine()) await rx.engine.releaseClockQuarantine(ref);
    expect(await rx.engine.rows("menu_item")).toHaveLength(2);
    expect(rx.engine.status().state).not.toBe("conflict");
  });

  it("shows the clock-wrong banner above 2 minutes of skew and stamps with the corrected clock", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { skewMs: 7 * 60_000 });
    expect(d.engine.status().clockWrong).toBe(false);
    await d.runner.syncNow(); // hello returns upstream time
    expect(d.engine.status().clockWrong).toBe(true);
    const op = await d.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: {} }]);
    expect(Math.abs(Date.parse(op.at) - w.clock.ms)).toBeLessThan(1000); // stamped on upstream time, not the wrong clock
    const reopened = await w.reopen(d);
    expect(reopened.engine.status().clockWrong).toBe(true); // the offset is persisted
  });
});

describe("device key loss (ADR-0002 A1.3, provisional)", () => {
  it("freezes recording, keeps every op, and builds a recovery upload attested by the new key", async () => {
    const w = await makeWorld();
    const old = await w.addDevice("devOld", { withHub: false, grants: [{ code: "A07", docType: "tax_invoice", state: "active" }] });
    for (let i = 0; i < 5; i++) {
      await old.engine.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: `b${i}`, k: "insert", f: { number: c.number("tax_invoice") } }] });
      if (i === 2) await old.engine.sealOwn(OUTLET); // seals up to 3; ops 4 and 5 are the unsealed tail
    }
    expect(old.engine.unsealedTail()).toBe(2);
    old.signer.lose(); // TPM cleared; the database survives
    expect(old.engine.status().keyLost).toBe(true);
    await expect(old.engine.recordMuts("x", [{ e: "order", id: "o", k: "insert", f: {} }])).rejects.toBeInstanceOf(KeyLostError);

    // Re-activation as a new device over the kept database.
    const fresh = await w.addDevice("devNew", { withHub: false, store: old.store });
    const up = await fresh.engine.recoveryUpload("devOld", { [OUTLET]: { devOld: 0 } }, "rec-1");
    expect(up).toHaveLength(1);
    expect(up[0]!.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(up[0]!.seals.map((s) => s.seq)).toEqual([3]); // only the stored seal; nothing signs 4 and 5
    const a = up[0]!.attestation;
    expect(a).toMatchObject({ origin: "devOld", seq: 5, by: "devNew", rec: "rec-1" });
    expect(await w.ring.verify("devNew", a.kid, `hostry-attest-v1\n${a.origin}\n${a.stream}\n${a.seq}\n${a.h}\n${a.by}\n${a.rec}`, a.sig)).toBe(true);
    // The adopting device never numbers in the old series.
    await expect(fresh.engine.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: "x", k: "insert", f: { number: c.number("tax_invoice") } }] })).rejects.toMatchObject({ reason: "no_active_series" });
  });

  it("seals the head every 5 minutes while ops are unpushed, so a lost key leaves a short unsealed tail", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    await d.engine.recordMuts("x", [{ e: "order", id: "o1", k: "insert", f: {} }]);
    w.clock.advance(4 * 60_000);
    await d.engine.sealIfDue();
    expect(d.engine.unsealedTail()).toBe(1);
    w.clock.advance(61_000);
    await d.engine.sealIfDue();
    expect(d.engine.unsealedTail()).toBe(0);
  });
});
