import type { SyncEngine } from "../engine";
import type { Seal, WireItem } from "../types";
import type { FakeNode } from "./fake-node";
import { OUTLET, type Device } from "./harness";

export type Batch = { items: WireItem[]; seals: Seal[] };

/** Everything a device wrote, as one sealed batch ready to hand to another engine. */
export async function authorBatch(d: Device): Promise<Batch> {
  return d.engine.outbox(OUTLET, {}, "own", 100000);
}

/** The cloud-origin ops (web edits, voids) held by a cloud node, as one sealed batch. */
export async function cloudBatch(cloud: FakeNode): Promise<Batch> {
  const r = await cloud.pull({ vector: {}, streams: [OUTLET], limit: 1_000_000 }, "probe");
  const items = r.items.filter((it) => it.origin.startsWith("cloud-"));
  return { items, seals: (r.seals ?? []).filter((s) => s.origin.startsWith("cloud-")) };
}

export function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Delivers batches to an engine in the given order; per-origin chains stay intact, cross-origin order varies. */
export async function deliver(target: SyncEngine, batches: Batch[]): Promise<void> {
  for (const b of batches) await target.applyRemote(OUTLET, b.items, b.seals);
}
