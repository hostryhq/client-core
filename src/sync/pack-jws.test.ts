import { describe, expect, it } from "vitest";
import { b64url, fromB64url, SoftwareSigner } from "./crypto";
import { PACK_JWS_TYP, identityKeysFromPack, jwkToPoint, verifyPackJws, type IdentityJwk } from "./pack-jws";
import { verifyLanCredential } from "./lan";
import { signCredentialJws } from "./testkit/lan-hub";

const enc = new TextEncoder();

function jwkOf(s: SoftwareSigner): IdentityJwk {
  const p = fromB64url(s.publicB64);
  return { kty: "EC", crv: "P-256", x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), kid: s.kid, alg: "ES256", use: "sig" };
}

async function signPack(signer: SoftwareSigner, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: signer.kid, typ: PACK_JWS_TYP, ...header })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  return `${h}.${p}.${await signer.sign(`${h}.${p}`)}`;
}

describe("signed offline pack", () => {
  it("verifies a pack signed with a key the claims publish, and reports its issuer_env", async () => {
    const id = await SoftwareSigner.generate("k1");
    const jws = await signPack(id, { issuer_env: "dev", identity_public_keys: [jwkOf(id)] });
    const r = await verifyPackJws(jws);
    expect(r.ok && r.claims.issuer_env).toBe("dev");
  });

  it("refuses a pack signed by a key not among its identity_public_keys", async () => {
    const id = await SoftwareSigner.generate("k1");
    const other = await SoftwareSigner.generate("k2");
    expect(await verifyPackJws(await signPack(other, { issuer_env: "live", identity_public_keys: [jwkOf(id)] }))).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("refuses a pack whose claims were altered after signing", async () => {
    const id = await SoftwareSigner.generate("k1");
    const jws = await signPack(id, { issuer_env: "dev", identity_public_keys: [jwkOf(id)] });
    const [h, , s] = jws.split(".");
    const forged = b64url(enc.encode(JSON.stringify({ issuer_env: "live", identity_public_keys: [jwkOf(id)] })));
    expect(await verifyPackJws(`${h}.${forged}.${s}`)).toEqual({ ok: false, reason: "signature" });
  });

  it("a key the device already holds wins over the keys the pack claims", async () => {
    const held = await SoftwareSigner.generate("k1");
    const forger = await SoftwareSigner.generate("k1"); // same kid, other key, publishes itself
    const jws = await signPack(forger, { issuer_env: "live", identity_public_keys: [jwkOf(forger)] });
    expect(await verifyPackJws(jws, { trusted: { k1: held.publicB64 } })).toEqual({ ok: false, reason: "signature" });
    expect((await verifyPackJws(jws)).ok).toBe(true);
  });

  it("refuses a wrong typ, alg, and an issuer_env that is not one of the four", async () => {
    const id = await SoftwareSigner.generate("k1");
    const claims = { issuer_env: "dev", identity_public_keys: [jwkOf(id)] };
    expect(await verifyPackJws(await signPack(id, claims, { typ: "hostry-cred+jws" }))).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyPackJws(await signPack(id, claims, { alg: "none" }))).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyPackJws(await signPack(id, { ...claims, issuer_env: "staging" }))).toEqual({ ok: false, reason: "issuer_env" });
    expect(await verifyPackJws("a.b")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("identity keys of a pack verify the hub's LAN credential", () => {
  it("jwk to point is the key the credential check takes", async () => {
    const id = await SoftwareSigner.generate("k1");
    expect(jwkToPoint(jwkOf(id))).toBe(id.publicB64);
    expect(jwkToPoint({ kty: "RSA", crv: "P-256", x: "", y: "" })).toBeUndefined();
    const keys = identityKeysFromPack([jwkOf(id)]);
    const hubKey = await SoftwareSigner.generate("hub-1");
    const claims = { device_id: "hub", tenant_id: "t1", outlet_id: "o1", brand_id: "b1", kind: "hub" as const, kid: "hub-1", pub: hubKey.publicB64, not_after: 2_000_000_000 };
    const jws = await signCredentialJws(id, claims);
    expect((await verifyLanCredential(jws, { identityKeys: keys, now: 1_900_000_000, outlet: "o1", kind: "hub" })).ok).toBe(true);
    const stranger = await SoftwareSigner.generate("k1");
    expect(await verifyLanCredential(await signCredentialJws(stranger, claims), { identityKeys: keys, now: 1_900_000_000, outlet: "o1", kind: "hub" })).toEqual({ ok: false, reason: "signature" });
  });
});
