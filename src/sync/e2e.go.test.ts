import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../store";
import { KeyRing, SoftwareSigner, type CredentialEnvelope } from "./crypto";
import { SyncEngine } from "./engine";
import { SyncRunner } from "./runner";
import { demoRegistry } from "./schema";
import type { SeriesGrant } from "./series";
import { HttpTransport, bearerAuth, lanAuth } from "./transport";

/**
 * End-to-end against the real Go gateway and hub from svc-sync (ADR-0002 S15 soak, reduced). It needs a
 * running stack and a fixture file describing it, so it is skipped unless SYNC_E2E_FIXTURE points at one.
 *
 * Fixture (JSON), written by whatever starts the svc-sync stack:
 *   { "cloud_url": "http://127.0.0.1:8081", "hub_url": "http://127.0.0.1:8082",
 *     "tenant_id": "t1", "outlet_id": "o1", "identity_pub": "<X9.62 base64url>",
 *     "cloud_keys": { "<kid>": "<X9.62 base64url>" },
 *     "devices": [ { "device_id": "dev-a", "kid": "k", "pub": "<X9.62>", "pkcs8": "<base64url PKCS#8>",
 *                    "cred": <CredentialEnvelope>, "token": "<device access token>",
 *                    "series": [ { "code": "A07", "docType": "tax_invoice", "state": "active" } ] }, ...two or more ],
 *     "hub": { "cred": <CredentialEnvelope of kind hub> } }
 */
type Fixture = {
  cloud_url: string;
  hub_url?: string;
  tenant_id: string;
  outlet_id: string;
  identity_pub: string;
  cloud_keys: Record<string, string>;
  devices: Array<{ device_id: string; kid: string; pub: string; pkcs8: string; cred: CredentialEnvelope; token: string; series?: SeriesGrant[] }>;
};

const path = process.env.SYNC_E2E_FIXTURE;
const ready = !!path && existsSync(path);
const fx: Fixture | undefined = ready ? (JSON.parse(readFileSync(path!, "utf8")) as Fixture) : undefined;

describe.skipIf(!ready)(
  ready ? "end to end against the Go gateway and hub" : "end to end against the Go gateway and hub: SKIPPED, set SYNC_E2E_FIXTURE to a fixture of a running svc-sync stack (not available yet)",
  () => {
    it("two TypeScript devices trade through the Go hub and cloud and converge", async () => {
      const f = fx!;
      const stream = `outlet:${f.outlet_id}`;
      const ring = new KeyRing(f.identity_pub);
      for (const [kid, pub] of Object.entries(f.cloud_keys)) await ring.addCloudKey(kid, pub);
      const nodes = [];
      for (const d of f.devices.slice(0, 2)) {
        await ring.add(d.device_id, d.kid, d.pub);
        const signer = await SoftwareSigner.import(d.kid, d.pkcs8, d.pub);
        const engine = await SyncEngine.open({ store: new InMemoryStore(f.tenant_id), schemas: demoRegistry(), deviceId: d.device_id, outletStream: stream, signer, verifier: ring, packVersion: "p1" });
        engine.session = { actor: "m1", sid: `s-${d.device_id}` };
        await engine.setSeriesGrants(d.series ?? []);
        const runner = new SyncRunner({
          engine,
          keyRing: ring,
          cloud: new HttpTransport({ baseUrl: f.cloud_url, auth: bearerAuth(() => d.token) }),
          ...(f.hub_url ? { hub: new HttpTransport({ baseUrl: f.hub_url, auth: lanAuth({ cred: d.cred, signer, identityPub: f.identity_pub, outlet: f.outlet_id }) }) } : {}),
        });
        nodes.push({ d, engine, runner });
      }
      for (const [i, n] of nodes.entries()) {
        await n.engine.recordMuts("order.create", [{ e: "order", id: `e2e-o${i}`, k: "insert", f: { table: `T${i}` } }]);
        await n.engine.recordMuts("stock.out", [{ e: "stock_level", id: "e2e-s1", k: "delta", f: { qty_milli: -1000 * (i + 1) } }]);
        if (n.d.series?.length) {
          await n.engine.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: `e2e-b${i}`, k: "insert", f: { order_id: `e2e-o${i}`, total_paise: 25_000, number: c.number("tax_invoice") } }] });
        }
      }
      const deadline = Date.now() + 30_000;
      for (;;) {
        for (const n of nodes) await n.runner.syncNow();
        const vs = await Promise.all(nodes.map((n) => n.engine.vector()));
        const safe = nodes.every((n) => n.engine.status().state === "synced");
        if (safe && JSON.stringify(vs[0]) === JSON.stringify(vs[1])) break;
        if (Date.now() > deadline) throw new Error(`no convergence: ${JSON.stringify(vs)} ${JSON.stringify(nodes.map((n) => n.engine.status()))}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const hashes = await Promise.all(nodes.map((n) => n.engine.stateHash()));
      expect(hashes[0]).toBe(hashes[1]);
      const numbers = (await nodes[0]!.engine.rows("bill")).map((b) => b.number as string);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect((await nodes[0]!.engine.rows("stock_level"))[0]?.qty_milli).toBe(-3000);
      for (const n of nodes) expect(n.engine.status().attentionOps).toBe(0);
    }, 60_000);
  },
);
