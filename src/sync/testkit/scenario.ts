import { detect } from "../detectors";
import type { Mutation } from "../types";
import { OUTLET, makeWorld, mulberry32, type Device, type World } from "./harness";

export type ScenarioOpts = {
  seed: number;
  devices: number;
  steps: number;
  /** Probability per step of toggling some link or node. */
  chaos?: number;
  /** Roll the cloud back once during the run. */
  rollback?: boolean;
  /** Every device is cut off from hub and cloud for the whole run, then everything reconnects at the end. */
  offlineAll?: boolean;
  /** Devices restart (new engine over the same store) now and then. */
  restarts?: boolean;
};

export type ScenarioResult = {
  world: World;
  ops: number;
  bills: string[];
  log: string[];
};

const CODES = ["A07", "B3K", "C9Z", "D4M", "E5N", "F6P", "G7Q", "H8R"];
const SKEWS = [0, -100_000, 60_000, 119_000, 0, 30_000, -45_000, 0];

/**
 * A seeded multi-client run: random trading and master-data writes on every device, partitions between
 * devices, hub and cloud, dropped and repeated deliveries (injected faults), device restarts, clock skew,
 * cloud-side edits and an optional cloud rollback. Everything is a function of the seed, so a failing
 * seed reproduces exactly (ADR-0002 S15 "deterministic simulation").
 */
export async function runScenario(o: ScenarioOpts): Promise<ScenarioResult> {
  const w = await makeWorld({ seed: o.seed });
  const rand = mulberry32(o.seed * 7919 + 13);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const chaos = o.chaos ?? 0.15;
  const log: string[] = [];
  let ops = 0;
  const bills: string[] = [];

  for (let i = 0; i < o.devices; i++) {
    await w.addDevice(`dev${i}`, {
      skewMs: SKEWS[i % SKEWS.length]!,
      grants: [
        { code: CODES[i]!, docType: "tax_invoice", state: "active" },
        { code: CODES[i]!, docType: "credit_note", state: "active" },
      ],
    });
  }

  if (o.offlineAll) {
    for (const d of w.devices) {
      d.hubLink.up = false;
      d.cloudLink.up = false;
    }
  }

  let snap: ReturnType<typeof w.cloud.snapshot> | undefined;
  let rolledBack = false;
  const n = (p: string) => `${p}${Math.floor(rand() * 1e9).toString(36)}`;

  const act = async (d: Device): Promise<void> => {
    const e = d.engine;
    const r = rand();
    let muts: Mutation[] | undefined;
    let intent = "x";
    let withNumber = false;
    if (r < 0.2) {
      muts = [{ e: "order", id: n("o"), k: "insert", f: { table: `T${Math.floor(rand() * 9)}`, covers: 1 + Math.floor(rand() * 5) } }];
    } else if (r < 0.32) {
      const orders = await e.rows("order");
      if (orders.length) muts = [{ e: "order_line", id: n("l"), k: "insert", f: { order_id: pick(orders).id, qty_milli: 1000 * (1 + Math.floor(rand() * 3)), price_paise: 500 * (1 + Math.floor(rand() * 20)) } }];
    } else if (r < 0.42) {
      const id = rand() < 0.5 ? n("k") : ((await e.rows("kds_item"))[0]?.id ?? n("k"));
      muts = [{ e: "kds_item", id, k: rand() < 0.4 ? "insert" : "set", f: { status: pick(["new", "preparing", "ready", "served"]) } }];
    } else if (r < 0.54) {
      muts = [{ e: "stock_level", id: `s${Math.floor(rand() * 4)}`, k: "delta", f: { qty_milli: (rand() < 0.3 ? 1 : -1) * 250 * (1 + Math.floor(rand() * 8)) } }];
    } else if (r < 0.68) {
      const items = await e.rows("menu_item");
      if (!items.length || rand() < 0.25) {
        muts = [{ e: "menu_item", id: n("m"), k: "insert", f: { name: n("item"), price_paise: 1000 * (1 + Math.floor(rand() * 30)) } }];
      } else {
        const m = pick(items);
        const prevStamp = rand() < 0.8 ? await e.stampOf("menu_item", m.id, "price_paise") : undefined;
        muts = [{ e: "menu_item", id: m.id, k: "set", f: { price_paise: 100 * (1 + Math.floor(rand() * 400)) }, ...(prevStamp ? { prev: { price_paise: prevStamp } } : {}) }];
      }
    } else if (r < 0.72) {
      const items = await e.rows("menu_item");
      if (items.length) muts = [{ e: "menu_item", id: pick(items).id, k: rand() < 0.6 ? "del" : "undel" }];
    } else if (r < 0.86) {
      const orders = await e.rows("order");
      if (orders.length) {
        intent = "bill.finalize";
        withNumber = true;
        const order = pick(orders);
        const id = n("b");
        muts = [{ e: "bill", id, k: "insert", f: { order_id: order.id, total_paise: 5000 * (1 + Math.floor(rand() * 10)) } }];
      }
    } else {
      const bs = await e.rows("bill");
      if (bs.length) {
        const b = pick(bs);
        muts = [{ e: "payment", id: n("p"), k: "insert", f: { bill_id: b.id, amount_paise: rand() < 0.1 ? -1000 : (b.total_paise as number) * (rand() < 0.15 ? 1 : 0.5) } }];
        if (!Number.isInteger((muts[0]!.f as { amount_paise: number }).amount_paise)) (muts[0]!.f as { amount_paise: number }).amount_paise = Math.floor((muts[0]!.f as { amount_paise: number }).amount_paise);
      }
    }
    if (!muts) return;
    const planned = muts;
    await e.record({
      intent,
      build: (ctx) => {
        if (withNumber) {
          const num = ctx.number("tax_invoice");
          bills.push(num);
          planned[0]!.f = { ...planned[0]!.f, number: num };
        }
        return planned;
      },
    });
    ops++;
  };

  for (let step = 0; step < o.steps; step++) {
    w.clock.advance(Math.floor(rand() * 4000));
    const roll = rand();
    if (roll < 0.55) {
      await act(pick(w.devices));
    } else if (roll < 0.8) {
      await pick(w.devices).runner.syncNow();
    } else if (roll < 0.9) {
      await w.relay();
    } else if (roll < 0.93) {
      await w.cloud.emit(OUTLET, "menu.edit", [{ e: "menu_item", id: n("m"), k: "insert", f: { name: n("web"), price_paise: 4200 } }]);
    }
    if (!o.offlineAll && rand() < chaos) {
      const kind = Math.floor(rand() * 7);
      const d = pick(w.devices);
      if (kind === 0) d.hubLink.up = !d.hubLink.up;
      else if (kind === 1) d.cloudLink.up = !d.cloudLink.up;
      else if (kind === 2) w.hubCloudLink.up = !w.hubCloudLink.up;
      else if (kind === 3) w.hub.up = !w.hub.up;
      else if (kind === 4) w.cloud.inject({ call: pick(["push", "pull", "hello"] as const), when: pick(["before", "after"] as const) });
      else if (kind === 5) w.hub.inject({ call: pick(["push", "pull"] as const), when: pick(["before", "after"] as const) });
      else if (o.restarts !== false) {
        const nd = await w.reopen(d);
        log.push(`restart ${nd.id} at step ${step}`);
      }
    }
    if (o.rollback && !rolledBack) {
      if (!snap && step > o.steps * 0.3) snap = w.cloud.snapshot();
      else if (snap && step > o.steps * 0.6) {
        w.cloud.restore(snap, `epoch-${o.seed}`);
        rolledBack = true;
        log.push(`cloud rollback at step ${step}`);
      }
    }
  }
  await w.settle();
  return { world: w, ops, bills, log };
}

export type Verdicts = {
  vectors: Array<Record<string, number>>;
  hashes: string[];
  conflicts: string[][];
  violations: string[][];
  numbers: string[];
};

export async function collect(w: World): Promise<Verdicts> {
  const out: Verdicts = { vectors: [], hashes: [], conflicts: [], violations: [], numbers: [] };
  for (const d of w.devices) {
    out.vectors.push(await d.engine.vector());
    out.hashes.push(await d.engine.stateHash());
    out.conflicts.push((await d.engine.conflicts()).map((c) => c.id).sort());
    out.violations.push((await detect(d.store)).map((v) => `${v.kind}:${v.key}`));
  }
  out.numbers = (await w.devices[0]!.engine.rows("bill")).map((b) => b.number as string);
  return out;
}
