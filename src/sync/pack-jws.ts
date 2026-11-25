import { b64url, fromB64url, importPublicKey, verifyRaw } from "./crypto";

/**
 * The signed offline pack (api-specs identity `OfflinePack.jws`, `HubPackClaims`): a compact ES256 JWS, header
 * `{"alg":"ES256","kid":<kid>,"typ":"hostry-pack+jws"}`, payload the claims. It is signed with an identity key that the claims
 * publish in `identity_public_keys` (current and next), the same keys that verify every LAN credential. A pack whose `kid` is
 * not among them is refused, and when the device already holds identity keys (`trusted`) the key that verifies is the held one.
 */
export const PACK_JWS_TYP = "hostry-pack+jws";

export type IssuerEnv = "dev" | "test" | "ci" | "live";
const ISSUER_ENVS: readonly string[] = ["dev", "test", "ci", "live"];

export type IdentityJwk = { kty: string; crv: string; x: string; y: string; kid: string; alg?: string; use?: string };

export type PackClaims = {
  issuer_env: IssuerEnv;
  identity_public_keys: IdentityJwk[];
  offline_valid_until?: string;
  [k: string]: unknown;
};

export type PackRefusal = "malformed" | "unknown_kid" | "signature" | "issuer_env";
export type PackCheck = { ok: true; claims: PackClaims; kid: string } | { ok: false; reason: PackRefusal };

const dec = new TextDecoder();

/** A published P-256 JWK as the X9.62 uncompressed point (base64url) the engine's key checks take. `undefined` when it is not a P-256 EC key. */
export function jwkToPoint(k: Pick<IdentityJwk, "kty" | "crv" | "x" | "y">): string | undefined {
  if (k?.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string") return undefined;
  try {
    const x = fromB64url(k.x);
    const y = fromB64url(k.y);
    if (x.length !== 32 || y.length !== 32) return undefined;
    const out = new Uint8Array(65);
    out[0] = 4;
    out.set(x, 1);
    out.set(y, 33);
    return b64url(out);
  } catch {
    return undefined;
  }
}

/** The pack's `identity_public_keys` as kid to point, the record `LanTransport` reads its `identityKeys` from. Malformed entries are left out. */
export function identityKeysFromPack(keys: readonly IdentityJwk[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys ?? []) {
    const p = typeof k?.kid === "string" ? jwkToPoint(k) : undefined;
    if (p) out[k.kid] = p;
  }
  return out;
}

/**
 * Verifies a pack's JWS. `trusted` is the identity keys the device already holds (kid to point), if any; the first activation has
 * none and the claims' own keys vouch (the shell is the trust anchor of that first pack). The signature is checked over the exact
 * bytes received. `issuer_env` must be one of the four environments; which of them a build accepts is the build's decision.
 */
export async function verifyPackJws(jws: string, opts: { trusted?: Readonly<Record<string, string>> } = {}): Promise<PackCheck> {
  const parts = typeof jws === "string" ? jws.split(".") : [];
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: PackClaims;
  try {
    header = JSON.parse(dec.decode(fromB64url(parts[0]!))) as typeof header;
    claims = JSON.parse(dec.decode(fromB64url(parts[1]!))) as PackClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "ES256" || header.typ !== PACK_JWS_TYP || typeof header.kid !== "string" || typeof claims !== "object" || claims === null || !Array.isArray(claims.identity_public_keys)) {
    return { ok: false, reason: "malformed" };
  }
  const own = identityKeysFromPack(claims.identity_public_keys)[header.kid];
  if (!own) return { ok: false, reason: "unknown_kid" };
  const held = opts.trusted && Object.keys(opts.trusted).length > 0;
  const pub = held ? opts.trusted![header.kid] : own;
  if (!pub) return { ok: false, reason: "unknown_kid" };
  if (!(await verifyRaw(await importPublicKey(pub), `${parts[0]}.${parts[1]}`, parts[2]!))) return { ok: false, reason: "signature" };
  if (typeof claims.issuer_env !== "string" || !ISSUER_ENVS.includes(claims.issuer_env)) return { ok: false, reason: "issuer_env" };
  return { ok: true, claims, kid: header.kid };
}
