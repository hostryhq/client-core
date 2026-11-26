import { describe, expect, it } from "vitest";
import { SyncRunner } from "./runner";
import { HttpTransport, TransportError, bearerAuth, fromWireVector, toWireVector, type SyncTransport } from "./transport";
import { makeWorld, OUTLET } from "./testkit/harness";

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
