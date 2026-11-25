import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SoftwareSigner, type Credential } from "./crypto";
import { LanTransport, spkiHash } from "./lan";
import { nodeLanChannel } from "./lan-node";
import { FakeLanHub, signCredentialJws } from "./testkit/lan-hub";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), "lan-node-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A throw-away self-signed P-256 certificate: names and dates mean nothing, as on a real hub. */
function selfSigned(name: string): { key: string; cert: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=hub.invalid"], { stdio: "ignore" });
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

const spkiOfPem = (pem: string): Promise<string> => spkiHash(new Uint8Array(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })));

describe.skipIf(!haveOpenssl())("Node LAN channel over real TLS 1.3", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function listen(c: { key: string; cert: string }, handler: (path: string, body: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>): Promise<string> {
    const s = createServer({ key: c.key, cert: c.cert, minVersion: "TLSv1.3" }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
        void handler(req.url ?? "", Buffer.concat(chunks).toString("utf8"), headers).then((r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(r.text);
        });
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    return `https://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  async function world(hubCert: { key: string; cert: string }) {
    const identity = await SoftwareSigner.generate("id-1");
    const hubKey = await SoftwareSigner.generate("hub-k");
    const devKey = await SoftwareSigner.generate("dev-k");
    const base = { tenant_id: "t1", outlet_id: "o1", brand_id: "b1", not_after: 4_000_000_000, store: "protected" as const };
    const devClaims: Credential = { ...base, device_id: "devA", kind: "pos", kid: "dev-k", pub: devKey.publicB64 };
    const hubClaims: Credential = { ...base, device_id: "hub-1", kind: "hub", kid: "hub-k", pub: hubKey.publicB64 };
    const hubSpki = await spkiOfPem(hubCert.cert);
    const hub = new FakeLanHub({
      identity,
      hubKey,
      hubClaims,
      tenantId: "t1",
      outletId: "o1",
      spki: hubSpki,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      nowMs: () => Date.now(),
      hubCredentialJws: await signCredentialJws(identity, hubClaims),
      app: async () => ({ protocol: 1, role: "hub", node_id: "hub-1", time: "2026-11-25T00:00:00Z", vector: {}, min_supported_version: "0", snapshot_required: false, streams: [] }),
    });
    const devJws = await signCredentialJws(identity, devClaims);
    const transport = (baseUrl: string) =>
      new LanTransport({ channel: nodeLanChannel({ baseUrl, timeoutMs: 5000 }), credential: devJws, deviceId: "devA", signer: devKey, identityKeys: () => ({ [identity.kid]: identity.publicB64 }), tenantId: "t1", outletId: "o1" });
    // The server side: the hub's own handler, as the Go hub would be (it knows its own certificate).
    const serve = (path: string, body: string, headers: Record<string, string>) => hub.channel().post(path, body, headers["hostry-lan-session"] ? { "Hostry-Lan-Session": headers["hostry-lan-session"] } : {});
    return { hub, transport, serve };
  }

  it("reads the real certificate, proves the hub, and carries the token afterwards", async () => {
    const c = selfSigned("hub");
    const w = await world(c);
    const url = await listen(c, w.serve);
    const lan = w.transport(url);
    expect((await lan.hello({ protocol: 1 })).role).toBe("hub");
    expect((await lan.hello({ protocol: 1 })).role).toBe("hub");
    expect(w.hub.log.map((l) => l.token)).toEqual([false, false, true, true]);
  });

  it("LT1: a relay with its own certificate in front of the hub is refused and only hello crosses", async () => {
    const hubCert = selfSigned("hub2");
    const w = await world(hubCert);
    const relayCert = selfSigned("relay");
    const url = await listen(relayCert, w.serve); // the relay forwards to the hub verbatim but shows its own certificate
    await expect(w.transport(url).hello({ protocol: 1 })).rejects.toMatchObject({ code: "hub_refused" });
    expect(w.hub.log.map((l) => l.path)).toEqual(["/sync/v1/lan/hello"]);
    expect(w.hub.activeSessions()).toBe(0);
  });

  it("a plain-HTTP or TLS 1.2-only listener cannot be reached: the channel speaks TLS 1.3 only", async () => {
    const c = selfSigned("old");
    const s = createServer({ key: c.key, cert: c.cert, maxVersion: "TLSv1.2" }, (_q, r) => r.end("{}"));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    const w = await world(c);
    await expect(w.transport(`https://127.0.0.1:${(s.address() as AddressInfo).port}`).hello({ protocol: 1 })).rejects.toMatchObject({ code: "network" });
  });
});
