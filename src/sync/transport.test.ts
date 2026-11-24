import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { SoftwareSigner, b64url, sha256Hex, type CredentialEnvelope } from "./crypto";
import { SyncRunner } from "./runner";
import { HttpTransport, TransportError, bearerAuth, fromWireVector, lanAuth, toWireVector, type SyncTransport } from "./transport";
import { makeWorld, OUTLET } from "./testkit/harness";

const enc = new TextEncoder();
const dec = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

describe("wire vectors", () => {
  it("flatten to origin/stream and back, streams containing colons and slashes of their own", () => {
    const per = { "outlet:o1": { devA: 4, "cloud-e1": 2 }, "brand:b1": { devA: 1 } };
    const flat = toWireVector(per);
    expect(flat).toEqual({ "devA/outlet:o1": 4, "cloud-e1/outlet:o1": 2, "devA/brand:b1": 1 });
    expect(fromWireVector(flat)).toEqual(per);
  });
});

/** A fetch that serves the protocol from a FakeNode, as the gateway or the hub would over HTTP. */
function serve(node: SyncTransport, opts: { onRequest?: (path: string, headers: Headers, body: string) => Promise<Record<string, string> | undefined> } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    const extra = (await opts.onRequest?.(path, headers, body)) ?? {};
    if (extra["x-status"]) return new Response("boom", { status: Number(extra["x-status"]) });
    const req = JSON.parse(body);
    const out = path.endsWith("/hello") ? await node.hello(req) : path.endsWith("/push") ? await node.push(req) : await node.pull(req);
    const text = JSON.stringify(out);
    delete extra["x-status"];
    return new Response(text, { status: 200, headers: extra });
  }) as typeof fetch;
}

describe("HttpTransport", () => {
  it("runs a full sync over HTTP/JSON with a bearer token and maps server errors to retriable transport errors", async () => {
    const w = await makeWorld();
    const d = await w.addDevice("devA", { withHub: false });
    let tokenSeen = "";
    const http = new HttpTransport({
      baseUrl: "https://sync.example.test/",
      auth: bearerAuth(() => "tok-1"),
      fetch: serve(w.cloud.connect("devA"), { onRequest: async (_p, h) => ((tokenSeen = h.get("authorization") ?? ""), undefined) }),
    });
    const runner = new SyncRunner({ engine: d.engine, cloud: http, now: w.clock.now });
    await d.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: { n: 1 } }]);
    await runner.syncNow();
    expect(tokenSeen).toBe("Bearer tok-1");
    expect(w.cloud.seqs(OUTLET, "devA")).toEqual([1]);
    expect(d.engine.delivery(1)).toBe("in_cloud");

    const flaky = new HttpTransport({ baseUrl: "https://x.test", fetch: serve(w.cloud.connect("devA"), { onRequest: async () => ({ "x-status": "503" }) }) });
    await expect(flaky.hello({ protocol: 1 })).rejects.toMatchObject({ status: 503, retriable: true });
    const refused = new HttpTransport({ baseUrl: "https://x.test", fetch: serve(w.cloud.connect("devA"), { onRequest: async () => ({ "x-status": "401" }) }) });
    await expect(refused.hello({ protocol: 1 })).rejects.toSatisfy((e: TransportError) => e.status === 401 && !e.retriable);
    const down = new HttpTransport({ baseUrl: "https://x.test", fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch });
    await expect(down.hello({ protocol: 1 })).rejects.toMatchObject({ status: 0, retriable: true });
  });
});

describe("LAN authentication (ADR-0002 S10)", () => {
  async function fixture() {
    const identity = await SoftwareSigner.generate("id");
    const hubKey = await SoftwareSigner.generate("hub-k");
    const devKey = await SoftwareSigner.generate("dev-k");
    const sign = async (cred: CredentialEnvelope["cred"]): Promise<CredentialEnvelope> => ({ cred, sig: await identity.sign(`hostry-cred-v1\n${canonicalize(cred)}`) });
    const base = { tenant_id: "t1", outlet_id: "o1", not_after: 2_000_000_000 };
    const devCred = await sign({ ...base, device_id: "devA", kind: "pos", kid: "dev-k", pub: devKey.publicB64 });
    const hubCred = await sign({ ...base, device_id: "hub-1", kind: "hub", kid: "hub-k", pub: hubKey.publicB64 });
    return { identity, hubKey, devKey, devCred, hubCred };
  }

  /** A hub that checks the device's assertion and answers with its proof. */
  async function hubFetch(f: Awaited<ReturnType<typeof fixture>>, o: { tamper?: boolean; noProof?: boolean; wrongKind?: boolean } = {}) {
    const w = await makeWorld();
    const hubCred = o.wrongKind ? await (async () => {
      const c = { ...f.hubCred.cred, kind: "pos" };
      return { cred: c, sig: await f.identity.sign(`hostry-cred-v1\n${canonicalize(c)}`) };
    })() : f.hubCred;
    return serve(w.hub.connect("devA"), {
      onRequest: async (path, headers) => {
        const a = JSON.parse(dec(headers.get("Hostry-Device-Assertion")!)) as { cred: CredentialEnvelope; ts: number; sig: string };
        expect(a.cred.cred.device_id).toBe("devA");
        if (o.noProof) return {} as Record<string, string>;
        const respSig = await f.hubKey.sign(`hostry-hub-v1\n${a.sig}\n${await sha256Hex(JSON.stringify(path.endsWith("/hello") ? await w.hub.hello({ protocol: 1 }) : {}))}`);
        const proof = { cred: hubCred, sig: o.tamper ? b64url(enc.encode("x".repeat(64))) : respSig };
        return { "Hostry-Hub-Proof": b64url(enc.encode(JSON.stringify(proof))) };
      },
    });
  }

  it("signs requests with the device key and accepts the hub only with a valid proof", async () => {
    const f = await fixture();
    const auth = lanAuth({ cred: f.devCred, signer: f.devKey, identityPub: f.identity.publicB64, outlet: "o1", nowSeconds: () => 1_800_000_000 });
    const good = new HttpTransport({ baseUrl: "https://192.168.1.20:8443", auth, fetch: await hubFetch(f) });
    expect((await good.hello({ protocol: 1 })).role).toBe("hub");
  });

  it("refuses a hub that sends no proof, a forged proof, or a credential that is not kind hub", async () => {
    const f = await fixture();
    const auth = lanAuth({ cred: f.devCred, signer: f.devKey, identityPub: f.identity.publicB64, outlet: "o1" });
    for (const o of [{ noProof: true }, { tamper: true }, { wrongKind: true }]) {
      const t = new HttpTransport({ baseUrl: "https://192.168.1.20:8443", auth, fetch: await hubFetch(f, o) });
      await expect(t.hello({ protocol: 1 }), JSON.stringify(o)).rejects.toMatchObject({ retriable: false });
    }
  });
});
