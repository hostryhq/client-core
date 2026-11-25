import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../store";
import { canonicalize } from "./canonical";
import { KeyRing, SoftwareSigner, makeSeal, sha256Hex } from "./crypto";
import { SyncEngine } from "./engine";
import { SyncRunner } from "./runner";
import { demoRegistry } from "./schema";
import type { HelloRequest, HelloResponse, SyncTransport } from "./transport";
import type { Seal, WireItem } from "./types";
import { makeWorld, OUTLET, TENANT, type Device, type World } from "./testkit/harness";
import { authorBatch, cloudBatch } from "./testkit/ship";

/** Cases PH1 to PH3 and KR1 of ADR-0002 A2.8, mirroring svc-sync engine/a28_test.go. */

const slot = (it: WireItem): WireItem => ({ origin: it.origin, stream: it.stream, seq: it.seq, h: it.h });

/** The same slot with a different body, hashed as a lying relay would. */
async function lieOf(it: WireItem): Promise<WireItem> {
  const o = JSON.parse(it.body!) as Record<string, unknown>;
  o.actor = "mx";
  const body = canonicalize(o);
  return { ...it, body, h: await sha256Hex(body) };
}

async function setup(n: number): Promise<{ w: World; a: Device; rx: Device; its: WireItem[]; seal: (seq: number) => Promise<Seal> }> {
  const w = await makeWorld();
  const a = await w.addDevice("devA", { withHub: false });
  const rx = await w.addDevice("rx", { withHub: false });
  for (let i = 0; i < n; i++) await a.engine.recordMuts("order.create", [{ e: "order", id: `o${i + 1}`, k: "insert", f: { n: i + 1 } }]);
  const its = (await authorBatch(a)).items;
  return { w, a, rx, its, seal: async (seq) => (await a.engine.sealOwn(OUTLET, seq))! };
}

const reasons = (r: { rejected: Array<{ reason: string }> }): string[] => r.rejected.map((x) => x.reason);

describe("PH1: no placeholder above the proven head", () => {
  it("is refused from a relay and taken from the cloud; the sealed op below is taken either way", async () => {
    const { rx, w, its, seal } = await setup(3);
    const s1 = await seal(1);
    const viaRelay = await w.addDevice("rx2", { withHub: false });
    const r = await viaRelay.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!)], [s1], { fromCloud: false });
    expect(r.applied).toBe(1);
    expect(r.rejected).toHaveLength(1); // the trailing placeholder: no seal covers it
    expect(await viaRelay.engine.hashAt({ origin: "devA", stream: OUTLET, seq: 2 })).toBeUndefined();
    expect((await viaRelay.engine.vector()).devA).toBe(1);

    const r2 = await rx.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!)], [s1], { fromCloud: true });
    expect(r2.rejected).toEqual([]);
    expect((await rx.engine.placeholders()).map((p) => p.seq)).toEqual([2]);
    expect((await rx.engine.vector()).devA).toBe(2);
  });

  it("a relay never serves a trailing placeholder", async () => {
    const { rx, its, seal } = await setup(2);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!)], [await seal(1)], { fromCloud: true });
    const out = await rx.engine.outbox(OUTLET, {}, "all", 100);
    expect(out.items.filter((i) => i.origin === "devA").map((i) => i.seq)).toEqual([1]);
  });

  it("a placeholder body from a relay above the sealed head is refused as unsealed; the cloud's is taken", async () => {
    const { rx, its, seal } = await setup(3);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!)], [await seal(1)], { fromCloud: true });
    const r = await rx.engine.applyRemote(OUTLET, [its[1]!], [], { fromCloud: false });
    expect(reasons(r)).toEqual(["unsealed"]);
    expect((await rx.engine.placeholders()).map((p) => p.seq)).toEqual([2]);
    const r2 = await rx.engine.applyRemote(OUTLET, [its[1]!], [], { fromCloud: true });
    expect(r2.applied).toBe(1);
  });
});

describe("PH2: a contradicting body is a chain_conflict and never silent", () => {
  it("is refused, gates the origin from that kind of upstream, and is reported once at a direct cloud hello", async () => {
    const { rx, its, seal } = await setup(4);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!), its[2]!], [await seal(3)], { fromCloud: true });
    const lie = await lieOf(its[1]!);
    const r = await rx.engine.applyRemote(OUTLET, [lie], [], { fromCloud: false });
    expect(reasons(r)).toEqual(["chain_conflict"]);
    expect(r.applied).toBe(0);
    expect((await rx.engine.placeholders()).map((p) => p.seq)).toEqual([2]); // the node keeps what it holds
    expect(rx.engine.status()).toMatchObject({ state: "conflict", attentionOps: 1 });

    // Nothing more of that origin from that kind of upstream, even the honest next op.
    const r2 = await rx.engine.applyRemote(OUTLET, [its[3]!], [await seal(4)], { fromCloud: false });
    expect(reasons(r2)).toEqual(["chain_conflict"]);
    // The cloud itself is not gated by a relay conflict.
    const r3 = await rx.engine.applyRemote(OUTLET, [its[3]!], [await seal(4)], { fromCloud: true });
    expect(r3.applied).toBe(1);

    const hellos: HelloRequest[] = [];
    const runner = new SyncRunner({ engine: rx.engine, cloud: spyCloud(hellos), now: rx.engine.correctedNow.bind(rx.engine) });
    await runner.syncNow();
    expect(hellos[0]?.chain_conflicts).toEqual([{ origin: "devA", stream: OUTLET, seq: 2, held: its[1]!.h, seen: lie.h }]);
    await runner.syncNow();
    expect(hellos[1]?.chain_conflicts).toBeUndefined(); // reported once
  });

  it("a body for a held slot that contradicts a seal naming it is a conflict", async () => {
    const { rx, its, seal } = await setup(4);
    // The hub's hash for slot 2 is the lie's; the seal (from the cloud) names the real one.
    const lie = await lieOf(its[1]!);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(lie), slot(its[2]!), its[3]!], [await seal(4)], { fromCloud: true });
    const r = await rx.engine.applyRemote(OUTLET, [lie], [await seal(2)], { fromCloud: false });
    expect(reasons(r)).toEqual(["chain_conflict"]);
    expect((await rx.engine.chainConflicts())[0]).toMatchObject({ seq: 2, held: lie.h, seen: its[1]!.h });
  });
});

describe("PH3: the lower slot of a run of placeholders cannot be bound", () => {
  const run = async (honest: boolean): Promise<void> => {
    const { rx, its, seal } = await setup(4);
    const lower = honest ? its[1]! : await lieOf(its[1]!);
    // Slots 2 and 3 arrive from the cloud as placeholders in a run; slot 2 carries the relay's hash.
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(lower), slot(its[2]!), its[3]!], [await seal(4)], { fromCloud: true });
    // The body for slot 2 arrives from a relay: nothing seals it, and the slot above has no body.
    const r = await rx.engine.applyRemote(OUTLET, [lower], [], { fromCloud: false });
    expect(r).toMatchObject({ applied: 1, rejected: [] });
    expect(await rx.engine.unboundSlots()).toEqual([{ origin: "devA", stream: OUTLET, seq: 2 }]);
    // Never relayed onward: not slot 2, nor anything after it in the chain.
    const out = await rx.engine.outbox(OUTLET, {}, "all", 100);
    expect(out.items.filter((i) => i.origin === "devA" && i.seq >= 2)).toEqual([]);
    expect(await rx.engine.directCloudDue()).toBe(true);
    expect((await rx.engine.helloExtras()).unbound).toEqual([{ origin: "devA", stream: OUTLET, seq: 2 }]);
    // The cloud answers with its own hash.
    await rx.engine.resolveUnbound([{ origin: "devA", stream: OUTLET, seq: 2, h: its[1]!.h }]);
    if (honest) {
      expect(await rx.engine.unboundSlots()).toEqual([]);
      expect(await rx.engine.chainConflicts()).toEqual([]);
    } else {
      expect(await rx.engine.chainConflicts(true)).toEqual([{ origin: "devA", stream: OUTLET, seq: 2, held: lower.h, seen: its[1]!.h }]);
    }
  };
  it("honest: the cloud's equal hash clears the mark", () => run(true));
  it("lying: the cloud's different hash is a chain_conflict at the direct hello", () => run(false));

  it("a later op above that links clears the mark without the cloud; one that does not is a conflict", async () => {
    const { w, rx, its, seal } = await setup(3);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!)], [await seal(1)], { fromCloud: true });
    await rx.engine.applyRemote(OUTLET, [its[1]!], [], { fromCloud: true });
    expect(await rx.engine.unboundSlots()).toHaveLength(1);
    await rx.engine.applyRemote(OUTLET, [its[2]!], [await seal(3)], { fromCloud: true });
    expect(await rx.engine.unboundSlots()).toEqual([]);

    const rx2 = await w.addDevice("rx2", { withHub: false });
    await rx2.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!)], [await seal(1)], { fromCloud: true });
    await rx2.engine.applyRemote(OUTLET, [its[1]!], [], { fromCloud: true });
    const wrongAbove = await lieOf(its[2]!); // its ph is untouched, so craft one that names another predecessor
    const o = JSON.parse(wrongAbove.body!) as { ph: string };
    o.ph = "0".repeat(64);
    const body = canonicalize(o);
    const bad: WireItem = { ...wrongAbove, body, h: await sha256Hex(body) };
    const r = await rx2.engine.applyRemote(OUTLET, [bad], [], { fromCloud: true });
    expect(reasons(r)).toEqual(["chain_conflict"]);
    expect(await rx2.engine.chainConflicts()).toHaveLength(1);
  });

  it("the op above in the same batch binds the slot", async () => {
    const { rx, its, seal } = await setup(3);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(its[1]!), slot(its[2]!)], [await seal(1)], { fromCloud: true });
    // Slot 3 is still a placeholder; slot 2's body comes with slot 3's body in one batch. Slot 3 is the head
    // and nothing above it binds it, so only slot 2 is bound.
    await rx.engine.applyRemote(OUTLET, [its[1]!, its[2]!], [], { fromCloud: true });
    expect((await rx.engine.unboundSlots()).map((u) => u.seq)).toEqual([3]);
  });
});

describe("direct cloud check (A2.8 item 1.3)", () => {
  it("is due 24 hours after the last direct hello, and a direct hello resets it", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA");
    expect(await d.engine.directCloudDue()).toBe(false);
    w.clock.advance(24 * 3_600_000 - 1000);
    expect(await d.engine.directCloudDue()).toBe(false);
    w.clock.advance(1000);
    expect(await d.engine.directCloudDue()).toBe(true);
    await d.engine.noteCloudHello("e1", {});
    expect(await d.engine.directCloudDue()).toBe(false);
  });

  it("a runner behind a hub reaches the cloud, listing its unbound slots, and applies the answer", async () => {
    const { w, a, rx, its, seal } = await setup(3);
    void a;
    const lie = await lieOf(its[1]!);
    await rx.engine.applyRemote(OUTLET, [its[0]!, slot(lie), slot(its[2]!)], [await seal(1)], { fromCloud: true });
    await rx.engine.applyRemote(OUTLET, [lie], [], { fromCloud: true });
    const hellos: HelloRequest[] = [];
    const orig = w.cloud.hello.bind(w.cloud);
    w.cloud.hello = async (r?: HelloRequest) => {
      if (r) hellos.push(r);
      const res = await orig(r);
      return { ...res, unbound_h: (r?.unbound ?? []).map((u) => ({ ...u, h: its[u.seq - 1]!.h })) };
    };
    rx.hubLink.up = true;
    await rx.runner.syncNow(); // hub first, then the direct cloud check because a slot is unbound
    expect(hellos[0]?.unbound).toEqual([{ origin: "devA", stream: OUTLET, seq: 2 }]);
    expect((await rx.engine.chainConflicts(true)).map((c) => c.seq)).toEqual([2]); // the cloud's hash differs: not silent
    await rx.runner.syncNow();
    expect(hellos[1]?.chain_conflicts).toEqual([{ origin: "devA", stream: OUTLET, seq: 2, held: lie.h, seen: its[1]!.h }]);
  });
});

describe("KR1: stale cloud seals are refreshed after an op-key rotation", () => {
  const engineWith = async (ring: KeyRing, id: string): Promise<SyncEngine> => {
    const e = await SyncEngine.open({
      store: new InMemoryStore(TENANT),
      schemas: demoRegistry(),
      deviceId: id,
      outletStream: OUTLET,
      streams: [OUTLET],
      signer: await SoftwareSigner.generate(`k-${id}`),
      verifier: ring,
      packVersion: "p1",
    });
    return e;
  };

  it("a hub refreshes its stored seals and a device with only the new key converges from the hub alone", async () => {
    const w = await makeWorld();
    for (let i = 1; i <= 3; i++) await w.cloud.emit(OUTLET, "order.create", [{ e: "order", id: `c${i}`, k: "insert", f: { n: i } }]);
    const batch = await cloudBatch(w.cloud);
    expect(batch.items).toHaveLength(3);
    const origin = batch.items[0]!.origin;

    const hubRing = new KeyRing();
    await hubRing.addCloudKey("cloud-key", w.cloudSigner.publicB64);
    const hub = await engineWith(hubRing, "hub-1");
    expect((await hub.applyRemote(OUTLET, batch.items, batch.seals, { fromCloud: true })).applied).toBe(3);

    // Emergency rotation: the pack drops the old key and adds the new one; the cloud re-signs its seals.
    const next = await SoftwareSigner.generate("k-new");
    await hubRing.addCloudKey("k-new", next.publicB64);
    hubRing.revokeCloudKey("cloud-key");
    const stale = await hub.staleSeals();
    expect(stale.map((s) => s.seq)).toEqual([3]); // the stored seal: one per applied batch

    // A device activated after the rotation holds only the new key: it cannot take the old seals, and says so.
    const devRing = new KeyRing();
    await devRing.addCloudKey("k-new", next.publicB64);
    const dev = await engineWith(devRing, "dev-b");
    const first = await hub.outbox(OUTLET, {}, "all", 100);
    expect((await dev.applyRemote(OUTLET, first.items, first.seals)).applied).toBe(0);
    expect(await dev.directCloudDue()).toBe(true); // a refused cloud seal must not stall silently

    // The refresh: only a seal that verifies under the kid it names and names the held hash replaces the stored one.
    const fresh = await Promise.all(batch.seals.map((s) => makeSeal(next, s.origin, s.stream, s.seq, s.h)));
    const wrongKid = { ...fresh.find((x) => x.seq === 3)!, kid: "cloud-key" };
    const wrongHash = await makeSeal(next, origin, OUTLET, 3, "f".repeat(64));
    expect(await hub.refreshSeals([wrongKid, wrongHash])).toBe(0);
    expect(await hub.refreshSeals(fresh)).toBe(1);
    expect(await hub.staleSeals()).toEqual([]);

    const again = await hub.outbox(OUTLET, {}, "all", 100);
    expect((await dev.applyRemote(OUTLET, again.items, again.seals)).applied).toBe(3);
    expect(await dev.stateHash()).toBe(await hub.stateHash());
  });

  it("the pull asks for stale seals and applies seal_refresh", async () => {
    const w = await makeWorld();
    await w.cloud.emit(OUTLET, "order.create", [{ e: "order", id: "c1", k: "insert", f: { n: 1 } }]);
    const batch = await cloudBatch(w.cloud);
    const ring = new KeyRing();
    await ring.addCloudKey("cloud-key", w.cloudSigner.publicB64);
    const e = await engineWith(ring, "hub-1");
    await e.applyRemote(OUTLET, batch.items, batch.seals, { fromCloud: true });
    const next = await SoftwareSigner.generate("k-new");
    await ring.addCloudKey("k-new", next.publicB64);
    ring.revokeCloudKey("cloud-key");
    const s = batch.seals[0]!;
    const pulls: Array<{ stale_seals?: unknown }> = [];
    const t: SyncTransport = {
      ...spyCloud([]),
      pull: async (r) => {
        pulls.push(r);
        return { items: [], more: false, own_held: [], seal_refresh: pulls.length === 1 ? [await makeSeal(next, s.origin, s.stream, s.seq, s.h)] : [] };
      },
    };
    const runner = new SyncRunner({ engine: e, cloud: t, now: e.correctedNow.bind(e) });
    await runner.syncNow();
    expect(pulls[0]?.stale_seals).toEqual([{ origin: s.origin, stream: s.stream, seq: s.seq }]);
    expect(await e.staleSeals()).toEqual([]);
    await runner.syncNow();
    expect(pulls[1]?.stale_seals).toBeUndefined();
  });
});

describe("A2.1: a cloud seal verifies under the kid it names only", () => {
  it("a wrong kid and a revoked kid are refused whatever other keys are held", async () => {
    const ring = new KeyRing();
    const k1 = await SoftwareSigner.generate("k1");
    const k2 = await SoftwareSigner.generate("k2");
    await ring.addCloudKey("k1", k1.publicB64);
    await ring.addCloudKey("k2", k2.publicB64);
    const m = (s: Seal): Promise<boolean> => ring.verify(s.origin, s.kid, `hostry-seal-v1\n${s.origin}\n${s.stream}\n${s.seq}\n${s.h}`, s.sig);
    const s1 = await makeSeal(k1, "cloud-A", OUTLET, 1, "h");
    const s2 = await makeSeal(k2, "cloud-A", OUTLET, 1, "h");
    expect(await m(s1)).toBe(true);
    expect(await m(s2)).toBe(true);
    expect(await m({ ...s1, kid: "k2" })).toBe(false); // right signature, wrong kid
    ring.revokeCloudKey("k1");
    expect(await m(s1)).toBe(false);
  });
});

/** A cloud transport that records hellos and answers with nothing to do. */
function spyCloud(hellos: HelloRequest[]): SyncTransport {
  return {
    hello: async (r) => {
      hellos.push(r);
      return { protocol: 1, role: "cloud", node_id: "cloud", time: new Date().toISOString(), epoch: "e1", vector: {}, min_supported_version: "0", snapshot_required: false, streams: [OUTLET] } satisfies HelloResponse;
    },
    push: async () => ({ vector: {} }),
    pull: async () => ({ items: [], more: false, own_held: [] }),
  };
}
