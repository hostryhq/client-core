import { uuidv7 } from "../../ids";
import { InMemoryStore, type LocalStore } from "../../store";
import { KeyRing, SoftwareSigner } from "../crypto";
import { SyncEngine } from "../engine";
import { SyncRunner } from "../runner";
import { demoRegistry, type SchemaRegistry } from "../schema";
import type { SeriesGrant } from "../series";
import type { OpEnvelope } from "../types";
import { FakeNode, type Verdict } from "./fake-node";

/** Seeded PRNG (mulberry32): the whole simulation is a function of its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TestClock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const TENANT = "t1";
export const OUTLET = "outlet:o1";
/** 2026-11-24T08:00:00Z. */
export const T0 = Date.UTC(2026, 10, 24, 8, 0, 0);

export type Device = {
  id: string;
  engine: SyncEngine;
  store: LocalStore;
  signer: SoftwareSigner;
  runner: SyncRunner;
  hubLink: { up: boolean };
  cloudLink: { up: boolean };
  withHub: boolean;
};

export type World = {
  clock: TestClock;
  rand: () => number;
  ring: KeyRing;
  cloud: FakeNode;
  hub: FakeNode;
  hubCloudLink: { up: boolean };
  devices: Device[];
  cloudSigner: SoftwareSigner;
  addDevice(id: string, opts?: { clockMode?: "sync" | "manual"; schemas?: SchemaRegistry; grants?: SeriesGrant[]; store?: LocalStore; signer?: SoftwareSigner; skewMs?: number; withHub?: boolean }): Promise<Device>;
  reopen(d: Device): Promise<Device>;
  syncDevice(d: Device): Promise<void>;
  relay(): Promise<void>;
  settle(): Promise<void>;
};

export async function makeWorld(
  opts: { seed?: number; policy?: (op: OpEnvelope) => Verdict | undefined; extraStreams?: string[] } = {},
): Promise<World> {
  const clock = new TestClock(T0);
  const rand = mulberry32(opts.seed ?? 1);
  const ring = new KeyRing();
  const cloudSigner = await SoftwareSigner.generate("cloud-key");
  await ring.addCloudKey("cloud-key", cloudSigner.publicB64);
  const streams = [OUTLET, ...(opts.extraStreams ?? [])];
  const cloud = new FakeNode({
    role: "cloud",
    nodeId: "cloud",
    tenantId: TENANT,
    streams,
    verifier: ring,
    now: clock.now,
    cloudSigner,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  const hub = new FakeNode({ role: "hub", nodeId: "hub-1", tenantId: TENANT, streams, verifier: ring, now: clock.now });
  const hubCloudLink = { up: true };
  const devices: Device[] = [];

  const newId = (): string => uuidv7(clock.now, () => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));

  const build = async (id: string, store: LocalStore, signer: SoftwareSigner, skewMs: number, withHub: boolean, hubLink: { up: boolean }, cloudLink: { up: boolean }, schemas: SchemaRegistry = demoRegistry(), clockMode: "sync" | "manual" = "sync"): Promise<Device> => {
    const engine = await SyncEngine.open({
      store,
      schemas,
      deviceId: id,
      outletStream: OUTLET,
      streams,
      signer,
      verifier: ring,
      packVersion: "p1",
      clockMode,
      now: () => clock.now() + skewMs,
      newId,
    });
    engine.session = { actor: "m1", sid: `s-${id}` };
    const runner = new SyncRunner({
      engine,
      ...(withHub ? { hub: hub.connect(id, hubLink) } : {}),
      cloud: cloud.connect(id, cloudLink),
      now: clock.now,
      random: rand,
    });
    return { id, engine, store, signer, runner, hubLink, cloudLink, withHub };
  };

  const world: World = {
    clock,
    rand,
    ring,
    cloud,
    hub,
    hubCloudLink,
    devices,
    cloudSigner,
    async addDevice(id, o = {}) {
      const signer = o.signer ?? (await SoftwareSigner.generate(`k-${id}`));
      await ring.add(id, signer.kid, signer.publicB64);
      const store = o.store ?? new InMemoryStore(TENANT);
      const d = await build(id, store, signer, o.skewMs ?? 0, o.withHub ?? true, { up: true }, { up: true }, o.schemas, o.clockMode);
      await d.engine.setSeriesGrants(o.grants ?? []); // activation always delivers a pack
      devices.push(d);
      return d;
    },
    async reopen(d) {
      // Process restart: a new engine over the same durable store, same key and links.
      const nd = await build(d.id, d.store, d.signer, 0, d.withHub, d.hubLink, d.cloudLink);
      devices[devices.indexOf(d)] = nd;
      return nd;
    },
    async syncDevice(d) {
      await d.runner.syncNow();
    },
    async relay() {
      await hub.relayWith(cloud, hubCloudLink).catch(() => undefined);
    },
    async settle() {
      hubCloudLink.up = true;
      hub.up = true;
      cloud.up = true;
      for (const d of devices) {
        d.hubLink.up = true;
        d.cloudLink.up = true;
      }
      let last = "";
      for (let i = 0; i < 40; i++) {
        clock.advance(20_000);
        for (const d of devices) await d.runner.syncNow();
        await world.relay();
        for (const d of devices) await d.runner.syncNow();
        const vs = await Promise.all(devices.map((d) => d.engine.vector()));
        const sig = JSON.stringify([vs, cloud.vector(), hub.vector()]);
        if (sig === last) return;
        last = sig;
      }
      throw new Error("settle: did not quiesce in 40 rounds");
    },
  };
  return world;
}
