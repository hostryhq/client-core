import { describe, expect, it } from "vitest";
import { SyncRunner } from "./runner";
import type { SyncStatus } from "./types";
import { makeWorld, OUTLET } from "./testkit/harness";
import { authorBatch, deliver } from "./testkit/ship";

const order = (id: string) => [{ e: "order", id, k: "insert" as const, f: { n: id } }];

describe("interrupted sync resumes without manual steps", () => {
  it("a push whose response is lost is repeated safely: exactly-once, no gap, no duplicate", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    for (let i = 0; i < 5; i++) await d.engine.recordMuts("order.create", order(`o${i}`));
    w.cloud.inject({ call: "push", when: "after" }); // the cloud stored the batch, the device never heard
    await d.runner.syncNow();
    expect(d.engine.status().online).toBe(false);
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1, 2, 3, 4, 5]);
    expect(d.engine.delivery(5)).toBe("local"); // the device does not know yet
    await d.runner.syncNow();
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1, 2, 3, 4, 5]);
    expect(w.cloud.refusals).toEqual([]);
    expect(d.engine.delivery(5)).toBe("in_cloud");
  });

  it("a connection cut before the push stores nothing and the next round delivers everything", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    await d.engine.recordMuts("order.create", order("o1"));
    w.cloud.inject({ call: "push", when: "before" });
    await d.runner.syncNow();
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([]);
    await d.runner.syncNow();
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1]);
  });

  it("a pull cut halfway resumes from the vector; chunk boundaries never split an op", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const rx = await w.addDevice("devRx", { withHub: false });
    for (let i = 0; i < 9; i++) await a.engine.recordMuts("order.create", order(`o${i}`));
    await a.runner.syncNow();
    const small = new SyncRunner({ engine: rx.engine, cloud: w.cloud.connect("devRx"), now: w.clock.now, batch: 2 });
    w.cloud.inject({ call: "pull", when: "after" }); // first pull answered, then connection drops
    await small.syncNow();
    w.cloud.inject({ call: "pull", when: "before" });
    await small.syncNow();
    const mid = (await rx.engine.vector()).devA ?? 0;
    expect(mid).toBeLessThan(9);
    await small.syncNow();
    await small.syncNow();
    expect((await rx.engine.vector()).devA).toBe(9);
    expect(await rx.engine.rows("order")).toHaveLength(9);
  });

  it("a process kill between the local commit and the acknowledgement loses nothing and duplicates nothing", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    await d.engine.recordMuts("order.create", order("o1"));
    await d.engine.recordMuts("order.create", order("o2"));
    w.cloud.inject({ call: "push", when: "after" });
    await d.runner.syncNow(); // cloud has 1-2; the device dies before it records that
    const reborn = await w.reopen(d);
    await reborn.engine.recordMuts("order.create", order("o3"));
    await reborn.runner.syncNow();
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1, 2, 3]);
    expect(reborn.engine.delivery(3)).toBe("in_cloud");
    expect((await reborn.engine.rows("order")).map((r) => r.id)).toEqual(["o1", "o2", "o3"]);
  });
});

describe("hub, cloud and the sync indicator (ADR-0002 S12)", () => {
  it("shows local, then at the hub, then safe in the cloud; the indicator follows", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA");
    const seen: string[] = [];
    d.engine.onStatus((s) => seen.push(s.state));
    expect(d.engine.status().state).toBe("offline"); // never synced yet
    await d.engine.recordMuts("order.create", order("o1"));
    expect(d.engine.delivery(1)).toBe("local");
    expect(d.engine.status()).toMatchObject({ pendingOps: 1, state: "offline" });

    w.hub.up = true;
    await d.runner.syncNow();
    expect(d.engine.delivery(1)).toBe("at_hub");
    expect(d.engine.status()).toMatchObject({ online: true, upstream: "hub", pendingOps: 0, atHubOps: 1, state: "pending" });

    await w.relay(); // hub reaches the cloud
    await d.runner.syncNow(); // hello from the hub carries the cloud's vector
    expect(d.engine.delivery(1)).toBe("in_cloud");
    expect(d.engine.status()).toMatchObject({ pendingOps: 0, atHubOps: 0, state: "synced" });
    expect(seen).toContain("pending");
    expect(seen.at(-1)).toBe("synced");
  });

  it("writes keep working with no network at all, then everything arrives on reconnect", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA");
    d.hubLink.up = false;
    d.cloudLink.up = false;
    for (let i = 0; i < 20; i++) await d.engine.recordMuts("order.create", order(`o${i}`));
    for (let i = 0; i < 4; i++) await d.runner.syncNow();
    expect(d.engine.status()).toMatchObject({ online: false, state: "offline", pendingOps: 20 });
    expect(await d.engine.rows("order")).toHaveLength(20); // local reads unaffected
    await w.settle();
    expect(d.engine.status()).toMatchObject({ state: "synced", pendingOps: 0 });
    expect(w.cloud.seqs(OUTLET, "devA")).toHaveLength(20);
  });

  it("fails over from a dead hub to the cloud after 3 tries, and goes back when the hub returns", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA");
    await d.engine.recordMuts("order.create", order("o1"));
    d.hubLink.up = false; // hub unreachable, internet up
    await d.runner.syncNow();
    await d.runner.syncNow();
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([]); // still trying the hub: 2 failures
    await d.runner.syncNow();
    await d.runner.syncNow();
    expect(d.engine.status().upstream).toBe("cloud");
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1]);
    expect(d.engine.delivery(1)).toBe("in_cloud");
    d.hubLink.up = true;
    w.clock.advance(16_000); // the hub is probed again after 15 s
    await d.runner.syncNow();
    expect(d.engine.status().upstream).toBe("hub");
  });

  it("coalesces concurrent sync requests into one round", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    await d.engine.recordMuts("order.create", order("o1"));
    await Promise.all([d.runner.syncNow(), d.runner.syncNow(), d.runner.syncNow()]);
    expect(w.cloud.pushes).toEqual([1]);
  });
});

describe("cloud restore and the epoch (ADR-0002 S16)", () => {
  it("re-offers retained ops after a rollback; no op identity is reused; every node converges", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const b = await w.addDevice("devB", { withHub: false });
    await a.engine.recordMuts("x", order("a1"));
    await w.settle();
    const snap = w.cloud.snapshot(); // backup point T
    // After T: more device ops, a cloud-emitted menu edit that reached device B, a delivery confirmation.
    await a.engine.recordMuts("x", order("a2"));
    await b.engine.recordMuts("x", order("b1"));
    await w.cloud.emit(OUTLET, "menu.edit", [{ e: "menu_item", id: "m1", k: "insert", f: { name: "Chai", price_paise: 1200 } }]);
    await w.settle();
    expect(a.engine.delivery(2)).toBe("in_cloud");
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1, 2]);

    w.cloud.restore(snap, "epoch-2"); // the founder rolls the cloud back
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1]);
    await w.settle();

    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1, 2]); // lost ops are back
    expect(w.cloud.seqs(OUTLET, "devB")).toEqual([1]);
    // The cloud op from the lost window travelled back under its retired origin; no identity was reused.
    expect(w.cloud.seqs(OUTLET, "cloud-genesis")).toEqual([1]);
    expect(w.cloud.seqs(OUTLET, "cloud-epoch-2")).toEqual([]);
    expect(a.engine.delivery(2)).toBe("in_cloud");
    const [ha, hb] = [await a.engine.stateHash(), await b.engine.stateHash()];
    expect(ha).toBe(hb);
    expect(await a.engine.rows("menu_item")).toHaveLength(1);
    // New cloud ops after the restore start a fresh origin at seq 1.
    await w.cloud.emit(OUTLET, "menu.edit", [{ e: "menu_item", id: "m2", k: "insert", f: { name: "Tea" } }]);
    await w.settle();
    expect(w.cloud.seqs(OUTLET, "cloud-epoch-2")).toEqual([1]);
    expect(await a.engine.rows("menu_item")).toHaveLength(2);
  });

  it("notices a restore through the changed epoch and shows the lost confirmation until the re-offer lands", async () => {
    const w = await makeWorld();
    const a = await w.addDevice("devA", { withHub: false });
    const snap = w.cloud.snapshot();
    await a.engine.recordMuts("x", order("a1"));
    await a.runner.syncNow();
    expect(a.engine.delivery(1)).toBe("in_cloud");
    w.cloud.restore(snap, "epoch-2");
    const hello = await w.cloud.connect("devA").hello({ protocol: 1 });
    const r = await a.engine.noteCloudHello(hello.epoch!, { [OUTLET]: {} });
    expect(r.restored).toBe(true);
    expect(a.engine.needsReoffer).toBe(true);
    expect(a.engine.delivery(1)).toBe("local"); // the cloud forgot it; the device is no longer "safe in the cloud"
    await a.runner.syncNow();
    expect(a.engine.delivery(1)).toBe("in_cloud");
    expect(a.engine.needsReoffer).toBe(false);
  });
});

describe("what a device is told about its own ops (ADR-0002 A1.2, provisional)", () => {
  const policy = (op: { intent: string }) =>
    op.intent === "hold.manager" ? { hold: "held_manager" as const } : op.intent === "hold.support" ? { hold: "held_support" as const } : op.intent === "hold.pending" ? { hold: "pending" as const } : undefined;

  it("learns only pending, held_manager or held_support; a release clears the mark and a peer converges through the placeholder", async () => {
    const w = await makeWorld({ policy });
    const a = await w.addDevice("devA", { withHub: false });
    const b = await w.addDevice("devB", { withHub: false });
    await a.engine.recordMuts("order.create", order("ok1"));
    const held1 = await a.engine.recordMuts("hold.manager", [{ e: "order", id: "h1", k: "insert", f: { n: 1 } }]);
    await a.engine.recordMuts("hold.support", [{ e: "order", id: "h2", k: "insert", f: { n: 2 } }]);
    await a.engine.recordMuts("hold.pending", [{ e: "order", id: "h3", k: "insert", f: { n: 3 } }]);
    await a.runner.syncNow();
    expect(a.engine.heldOps().map((h) => h.code).sort()).toEqual(["held_manager", "held_support", "pending"]);
    const s = a.engine.status();
    expect(s).toMatchObject({ attentionOps: 2, checkingOps: 1, state: "conflict" });
    expect(Object.keys(s).join()).not.toMatch(/flag|proof|verdict/i); // nothing beyond the three codes reaches the screen

    // A peer receives placeholders: the slots exist (vector advances) but no rows.
    await b.runner.syncNow();
    expect((await b.engine.vector()).devA).toBe(4);
    expect((await b.engine.rows("order")).map((r) => r.id)).toEqual(["ok1"]);
    expect(await b.engine.placeholders()).toHaveLength(3);

    // The manager releases one: it leaves the origin's list and the peer, naming its placeholder, gets the op.
    w.cloud.release({ origin: "devA", stream: OUTLET, seq: held1.seq });
    await a.runner.syncNow();
    expect(a.engine.heldOps().map((h) => h.seq)).not.toContain(held1.seq);
    expect(a.engine.status().attentionOps).toBe(1);
    await b.runner.syncNow();
    expect((await b.engine.rows("order")).map((r) => r.id).sort()).toEqual(["h1", "ok1"]);
    expect(await b.engine.placeholders()).toHaveLength(2);
  });

  it("through a hub the device still sees its codes, relayed from the cloud's last word", async () => {
    const w = await makeWorld({ policy });
    const a = await w.addDevice("devA");
    await a.engine.recordMuts("hold.manager", [{ e: "order", id: "h1", k: "insert", f: {} }]);
    await a.runner.syncNow(); // to the hub
    await w.relay(); // the hub pushes it to the cloud, which holds it
    await w.relay(); // and the hub learns the verdict
    await a.runner.syncNow();
    expect(a.engine.heldOps()).toEqual([{ stream: OUTLET, seq: 1, code: "held_manager" }]);
  });

  it("a configuration op voided by the cloud arrives as a sync.void and reads as refused; the row is withdrawn everywhere", async () => {
    const w = await makeWorld({ policy: (op) => (op.intent === "cfg.bad" ? { void: true } : undefined) });
    const a = await w.addDevice("devA", { withHub: false });
    const b = await w.addDevice("devB", { withHub: false });
    await a.engine.recordMuts("cfg.bad", [{ e: "menu_item", id: "m1", k: "insert", f: { price_paise: 1 } }]);
    await w.settle();
    expect(a.engine.refusedOps()).toEqual([{ origin: "devA", stream: OUTLET, seq: 1 }]);
    expect(a.engine.status()).toMatchObject({ attentionOps: 1, state: "conflict" });
    expect(await a.engine.rows("menu_item")).toHaveLength(0);
    expect(await b.engine.rows("menu_item")).toHaveLength(0);
    expect(await a.engine.stateHash()).toBe(await b.engine.stateHash());
  });

  it("keeps hold state across a restart", async () => {
    const w = await makeWorld({ policy });
    const a = await w.addDevice("devA", { withHub: false });
    await a.engine.recordMuts("hold.support", [{ e: "order", id: "h1", k: "insert", f: {} }]);
    await a.runner.syncNow();
    const again = await w.reopen(a);
    expect(again.engine.heldOps()).toHaveLength(1);
    expect(again.engine.status().state).not.toBe("synced");
  });
});

describe("status observable", () => {
  it("notifies listeners on every change and can be unsubscribed", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    const states: SyncStatus[] = [];
    const off = d.engine.onStatus((s) => states.push(s));
    await d.engine.recordMuts("x", order("o1"));
    await d.runner.syncNow();
    off();
    const n = states.length;
    await d.engine.recordMuts("x", order("o2"));
    expect(states.length).toBe(n);
    expect(states[0]).toMatchObject({ pendingOps: 1 });
    expect(states.at(-1)).toMatchObject({ pendingOps: 0, state: "synced", online: true });
    expect(await authorBatch(d)).toBeDefined();
    expect(deliver).toBeDefined();
  });
});
