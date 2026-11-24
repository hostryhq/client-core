import { describe, expect, it } from "vitest";
import { OUTLET } from "./testkit/harness";
import { collect, runScenario, type ScenarioOpts } from "./testkit/scenario";

/**
 * Property: after any schedule of writes, partitions, dropped or repeated deliveries, restarts, clock
 * skew, cloud edits and a cloud rollback, once the network heals every node holds the same version
 * vector and the same canonical state, legal numbers are unique and gapless per series, and the cloud
 * holds every op (ADR-0002 S15). A failing seed is printed in the assertion message: it reproduces exactly.
 */
async function check(o: ScenarioOpts): Promise<void> {
  const { world: w, ops, bills } = await runScenario(o);
  const v = await collect(w);
  const tag = `seed ${o.seed}`;

  for (let i = 1; i < v.vectors.length; i++) expect(v.vectors[i], `${tag}: vectors dev${i}`).toEqual(v.vectors[0]);
  for (let i = 1; i < v.hashes.length; i++) expect(v.hashes[i], `${tag}: state hash dev${i}`).toBe(v.hashes[0]);
  for (let i = 1; i < v.conflicts.length; i++) expect(v.conflicts[i], `${tag}: conflicts dev${i}`).toEqual(v.conflicts[0]);
  for (let i = 1; i < v.violations.length; i++) expect(v.violations[i], `${tag}: detector output dev${i}`).toEqual(v.violations[0]);

  // The cloud holds every op of every origin, gapless.
  const cloudVec = w.cloud.vector()[OUTLET] ?? {};
  for (const [origin, seq] of Object.entries(v.vectors[0]!)) {
    expect(cloudVec[origin], `${tag}: cloud vector for ${origin}`).toBe(seq);
    expect(w.cloud.seqs(OUTLET, origin), `${tag}: gapless ${origin}`).toEqual(Array.from({ length: seq }, (_, i) => i + 1));
  }
  expect(w.cloud.refusals, `${tag}: refusals`).toEqual([]);

  // Legal numbers: unique, at most 16 characters, and gapless per (code, FY) series.
  expect(new Set(v.numbers).size, `${tag}: unique numbers`).toBe(v.numbers.length);
  expect(v.numbers.length, `${tag}: every finalised bill is on every node`).toBe(bills.length);
  const byCode = new Map<string, number[]>();
  for (const n of v.numbers) {
    expect(n.length).toBeLessThanOrEqual(16);
    const [code, fy, run] = n.split("/") as [string, string, string];
    byCode.set(`${code}/${fy}`, [...(byCode.get(`${code}/${fy}`) ?? []), Number(run)]);
  }
  for (const [series, runs] of byCode) {
    runs.sort((a, b) => a - b);
    expect(runs, `${tag}: gapless ${series}`).toEqual(Array.from({ length: runs.length }, (_, i) => i + 1));
  }

  // Everything is safe in the cloud and the indicator says so.
  for (const d of w.devices) {
    const s = d.engine.status();
    expect(s.pendingOps + s.atHubOps, `${tag}: ${d.id} undelivered`).toBe(0);
  }
  expect(ops).toBeGreaterThan(0);
}

describe("multi-client simulation (seeded)", () => {
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
  it.each(seeds)("converges: seed %i (4 devices, hub and cloud, partitions, restarts, skew)", async (seed) => {
    await check({ seed, devices: 4, steps: 140 });
  }, 60_000);

  it.each([101, 102, 103, 104, 105])("converges across a cloud rollback: seed %i", async (seed) => {
    await check({ seed, devices: 3, steps: 160, rollback: true });
  }, 60_000);
});

describe("long offline soak", () => {
  // Short on every run; the long one (about 7 simulated hours, 12,000 steps) runs nightly: SYNC_SOAK=1.
  const long = process.env.SYNC_SOAK === "1";

  it("six devices trade through a working day with partitions, restarts and a cloud rollback, then converge", async () => {
    await check({ seed: 4242, devices: 6, steps: long ? 12000 : 1500, rollback: true, chaos: 0.2 });
  }, 280_000);

  it("devices that never see a network for hours of trading converge when they reconnect", async () => {
    const o = { seed: 777, devices: 5, steps: long ? 6000 : 2500, offlineAll: true };
    await check(o);
  }, 280_000);
});
