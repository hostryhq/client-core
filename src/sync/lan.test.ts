import { describe, expect, it } from "vitest";
import { b64url, SoftwareSigner, type Credential } from "./crypto";
import { LAN_SESSION_HEADER, LanTransport, browserLanChannel, lanProofMessage, makeLanProof, validLanToken, verifyLanCredential, verifyLanProof, type CredentialRefusal, type LanChannel } from "./lan";
import { FakeLanHub, signCredentialJws } from "./testkit/lan-hub";
import { SyncRunner } from "./runner";
import { makeWorld, OUTLET } from "./testkit/harness";
import vectors from "./testkit/vectors-v1.json";

const V = vectors.lan_handshake;

describe("api-specs vector lan_handshake (byte for byte)", () => {
  const fields = { nonceD: V.nonce_d, nonceH: V.nonce_h, deviceId: V.device.device_id, hubId: V.hub.device_id };

  it("builds the proof messages of both roles exactly as the vector spells them", () => {
    const msg = (role: "hub" | "device", spki: string) => lanProofMessage(role, { ...fields, spki });
    expect(msg("hub", V.spki)).toBe(V.proof_cases[0]!.message);
    expect(msg("device", V.spki)).toBe(V.proof_cases[1]!.message);
    expect(msg("hub", V.relay_spki)).toBe(V.proof_cases[2]!.message);
  });

  it("proof cases: the valid signatures verify, the relay, role-swap and wrong-key cases do not", async () => {
    for (const c of V.proof_cases) {
      const [tag, nonceD, nonceH, deviceId, hubId, spki] = c.message.split("\n") as [string, string, string, string, string, string];
      expect(tag).toBe(c.role === "hub" ? "hostry-lan-hub-v1" : "hostry-lan-device-v1");
      expect(await verifyLanProof(c.role as "hub" | "device", c.signer_pub, c.sig, { nonceD, nonceH, deviceId, hubId, spki }), c.case).toBe(c.valid);
    }
  });

  it("credential cases, judged against the vector's `now`", async () => {
    for (const c of V.credential_cases) {
      const r = await verifyLanCredential(c.credential, { identityKeys: { [V.identity_key.kid]: V.identity_key.pub }, now: V.now, outlet: c.expect_outlet, kind: c.expect_kind as "hub" | "pos" });
      expect(r.ok, c.case).toBe(c.valid);
      if (!r.ok) expect(r.reason, c.case).toBe(c.reason as CredentialRefusal);
    }
  });

  it("carries the store claim of the credential, and token shape cases", async () => {
    const hub = await verifyLanCredential(V.hub.credential, { identityKeys: { [V.identity_key.kid]: V.identity_key.pub }, now: V.now, outlet: V.hub.claims.outlet_id, kind: "hub" });
    expect(hub.ok && hub.claims.store).toBe("protected");
    for (const t of V.session.token_cases) expect(validLanToken(t.token), t.token).toBe(t.valid);
  });
});

describe("LAN transport (ADR-0002 A3.1)", () => {
  const TENANT = "t1";
  const OUT = "o1";

  async function fixture(o: { hubCred?: Partial<Credential>; hubSigner?: "same" | "stranger"; revoke?: boolean } = {}) {
    const w = await makeWorld();
    const identity = await SoftwareSigner.generate("id-1");
    const hubKey = await SoftwareSigner.generate("hub-k");
    const devKey = await SoftwareSigner.generate("dev-k");
    const clock = { ms: 1_800_000_000_000 };
    const base = { tenant_id: TENANT, outlet_id: OUT, brand_id: "b1", not_after: 1_800_000_000 + 86_400, store: "protected" as const };
    const devClaims: Credential = { ...base, device_id: "devA", kind: "pos", kid: "dev-k", pub: devKey.publicB64 };
    const hubClaims: Credential = { ...base, device_id: "hub-1", kind: "hub", kid: "hub-k", pub: hubKey.publicB64, ...o.hubCred };
    const signer = o.hubSigner === "stranger" ? await SoftwareSigner.generate("evil-id") : identity;
    const hubCredentialJws = await signCredentialJws(signer, hubClaims);
    const node = w.hub.connect("devA");
    const hub = new FakeLanHub({
      identity,
      hubKey,
      hubClaims,
      tenantId: TENANT,
      outletId: OUT,
      spki: "aa".repeat(32),
      nowSeconds: () => Math.floor(clock.ms / 1000),
      nowMs: () => clock.ms,
      hubCredentialJws,
      app: async (path, body) => (path.endsWith("/hello") ? node.hello(body as never) : path.endsWith("/push") ? node.push(body as never) : node.pull(body as never)),
    });
    const devJws = await signCredentialJws(identity, devClaims);
    const make = (channel: LanChannel = hub.channel()) =>
      new LanTransport({
        channel,
        credential: devJws,
        deviceId: "devA",
        signer: devKey,
        identityKeys: () => ({ [identity.kid]: identity.publicB64 }),
        tenantId: TENANT,
        outletId: OUT,
        ...(o.revoke ? { revoked: () => new Set(["hub-1"]) } : {}),
        nowSeconds: () => Math.floor(clock.ms / 1000),
        nowMs: () => clock.ms,
      });
    return { w, hub, clock, make, devKey, devJws };
  }

  it("shakes hands, then every request carries the session token; a full sync runs through it", async () => {
    const { w, hub, make } = await fixture();
    const d = await w.addDevice("devA", { withHub: false });
    const lan = make();
    const runner = new SyncRunner({ engine: d.engine, cloud: w.cloud.connect("devA"), hub: lan, now: w.clock.now });
    await d.engine.recordMuts("order.create", [{ e: "order", id: "o1", k: "insert", f: { n: 1 } }]);
    await runner.syncNow();
    expect(w.hub.seqs(OUTLET, "devA")).toEqual([1]);
    // nothing but helloLan before the hub was proven, and a token on every later request
    expect(hub.log[0]).toEqual({ path: "/sync/v1/lan/hello", token: false });
    expect(hub.log[1]).toEqual({ path: "/sync/v1/lan/session", token: false });
    expect(hub.log.slice(2).every((l) => l.token)).toBe(true);
    expect(hub.log.filter((l) => l.path.endsWith("/lan/hello")).length).toBe(1);
  });

  it("LT1: a relay that shows its own certificate is refused by the device, and nothing but hello was sent", async () => {
    const { hub, make } = await fixture();
    const lan = make(hub.channel(() => "bb".repeat(32))); // the device sees the relay's certificate
    await expect(lan.hello({ protocol: 1 })).rejects.toMatchObject({ code: "hub_refused" });
    expect(hub.log.map((l) => l.path)).toEqual(["/sync/v1/lan/hello"]);
    expect(hub.activeSessions()).toBe(0);
  });

  it("LT1: the hub refuses a device proof made over another certificate and issues no token", async () => {
    const { hub, devKey, devJws } = await fixture();
    const ch = hub.channel();
    const nonceD = b64url(new Uint8Array(32).fill(7));
    const r1 = await ch.post("/sync/v1/lan/hello", JSON.stringify({ credential: devJws, nonce_d: nonceD }), {});
    const nonceH = (JSON.parse(r1.text) as { nonce_h: string }).nonce_h;
    const f = { nonceD, nonceH, deviceId: "devA", hubId: "hub-1" };
    const wrong = await makeLanProof("device", devKey, { ...f, spki: "bb".repeat(32) });
    const r2 = await ch.post("/sync/v1/lan/session", JSON.stringify({ nonce_d: nonceD, nonce_h: nonceH, device_proof: wrong }), {});
    expect(r2.status).toBe(401);
    expect(JSON.parse(r2.text)).toMatchObject({ code: "lan_proof_invalid" });
    expect(hub.activeSessions()).toBe(0);
  });

  it("LT2: a hub credential made by a stranger, of another outlet, expired, or revoked is refused offline", async () => {
    const cases: Array<Parameters<typeof fixture>[0]> = [
      { hubSigner: "stranger" },
      { hubCred: { outlet_id: "o2" } },
      { hubCred: { not_after: 1_700_000_000 } },
      { revoke: true },
      { hubCred: { kind: "pos" } },
    ];
    for (const c of cases) {
      const { hub, make } = await fixture(c);
      await expect(make().hello({ protocol: 1 }), JSON.stringify(c)).rejects.toMatchObject({ code: "hub_refused", retriable: false });
      expect(hub.log.map((l) => l.path), JSON.stringify(c)).toEqual(["/sync/v1/lan/hello"]);
    }
  });

  it("token expiry: after 15 minutes the next call shakes hands again; a token the hub dropped (restart) is re-opened once and the call retried", async () => {
    const { w, hub, clock, make } = await fixture();
    const lan = make();
    await lan.hello({ protocol: 1 });
    expect(hub.log.filter((l) => l.path.endsWith("/lan/hello")).length).toBe(1);
    clock.ms += 14 * 60_000; // still inside the lifetime (the slack is 30 s)
    await lan.hello({ protocol: 1 });
    expect(hub.log.filter((l) => l.path.endsWith("/lan/hello")).length).toBe(1);
    clock.ms += 90_000; // 15.5 minutes in: past the token's life
    expect((await lan.hello({ protocol: 1 })).role).toBe("hub");
    expect(hub.log.filter((l) => l.path.endsWith("/lan/hello")).length).toBe(2);
    // the hub restarts: the client still thinks it holds a live token; it gets lan_session_expired, re-handshakes and retries
    hub.restart();
    expect((await lan.hello({ protocol: 1 })).role).toBe("hub");
    const paths = hub.log.map((l) => l.path);
    expect(paths.filter((p) => p.endsWith("/lan/hello")).length).toBe(3);
    expect(paths.at(-1)).toBe("/sync/v1/hello");
    expect(w).toBeDefined();
  });

  it("a hub that keeps answering lan_session_expired fails after one retry, not in a loop", async () => {
    const { hub, make } = await fixture();
    const lan = make();
    await lan.hello({ protocol: 1 });
    hub.ttlSeconds = 0; // every new token is dead on arrival
    hub.restart();
    await expect(lan.hello({ protocol: 1 })).rejects.toMatchObject({ status: 401 });
  });

  it("a browser runtime cannot read the certificate: it says so and sends nothing", async () => {
    const { make } = await fixture();
    const lan = make(browserLanChannel());
    expect(lan.peerVerification).toBe("unavailable");
    await expect(lan.hello({ protocol: 1 })).rejects.toMatchObject({ code: "peer_cert_unreadable" });
  });

  it("the session header name is the one in the contract", () => {
    expect(LAN_SESSION_HEADER).toBe(V.session.header);
    expect(b64url(new Uint8Array(32)).length).toBe(43);
  });
});
