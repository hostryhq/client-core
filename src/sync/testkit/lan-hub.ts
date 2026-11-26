import { b64url, SoftwareSigner, type Credential } from "./../crypto";
import { LAN_SESSION_HEADER, lanProofMessage, makeLanProof, validLanToken, verifyLanCredential, verifyLanProof, type LanChannel, type LanChannelResponse } from "../lan";
import { canonicalize } from "../canonical";

const enc = new TextEncoder();

/** An identity-signed credential as a compact JWS (`typ` hostry-cred+jws). */
export async function signCredentialJws(identity: SoftwareSigner, claims: Credential): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: identity.kid, typ: "hostry-cred+jws" })));
  const p = b64url(enc.encode(canonicalize(claims)));
  return `${h}.${p}.${await identity.sign(`${h}.${p}`)}`;
}

export type FakeLanHubConfig = {
  identity: SoftwareSigner;
  hubKey: SoftwareSigner;
  hubClaims: Credential;
  tenantId: string;
  outletId: string;
  /** What the hub's own certificate hashes to. */
  spki: string;
  nowSeconds: () => number;
  nowMs: () => number;
  /** Serves the sync routes once a session token is valid: `(path, body) => json`. */
  app: (path: string, body: unknown) => Promise<unknown>;
  hubCredentialJws: string;
};

/**
 * A hub as the LAN handshake sees it: self-made TLS identity (just an `spki` string here), `helloLan`, `openLanSession`, 15-minute
 * tokens in memory, `401 lan_session_expired` on any other call without a live token. `channel(spkiSeen)` is the device's view: the
 * `spkiSeen` is what the device reads from the connection (a relay shows its own).
 */
export class FakeLanHub {
  private pending = new Map<string, { nonceD: string; atMs: number; deviceId: string }>();
  private sessions = new Map<string, { deviceId: string; expiresAtMs: number }>();
  /** Every request path the hub received, in order, with whether it carried a token. */
  readonly log: Array<{ path: string; token: boolean }> = [];
  ttlSeconds = 900;

  constructor(private readonly c: FakeLanHubConfig) {}

  restart(): void {
    this.sessions.clear();
    this.pending.clear();
  }

  activeSessions(): number {
    return this.sessions.size;
  }

  channel(spkiSeen: () => string = () => this.c.spki, readable = true): LanChannel {
    return {
      peerCertReadable: readable,
      post: async (path, body, headers, pin) => {
        const spki = spkiSeen();
        // A pinned connection to a different certificate is refused before anything is written.
        if (pin !== undefined && pin !== spki) throw new Error("hub certificate differs from the verified one");
        const r = await this.handle(path, body, headers[LAN_SESSION_HEADER]);
        return { ...r, spki };
      },
    };
  }

  private problem(status: number, code: string): LanChannelResponse {
    return { status, text: JSON.stringify({ type: `urn:hostry:problem:${code}`, status, code }) };
  }

  private async handle(path: string, body: string, token: string | undefined): Promise<LanChannelResponse> {
    const c = this.c;
    this.log.push({ path, token: token !== undefined });
    const json = JSON.parse(body) as Record<string, string>;
    if (path === "/sync/v1/lan/hello") {
      const dev = await verifyLanCredential(json.credential ?? "", { identityKeys: { [c.identity.kid]: c.identity.publicB64 }, now: c.nowSeconds(), tenant: c.tenantId, outlet: c.outletId, kind: "device" });
      if (!dev.ok || !validLanToken(json.nonce_d ?? "")) return this.problem(401, "lan_credential_refused");
      const nonceH = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.pending.set(nonceH, { nonceD: json.nonce_d!, atMs: c.nowMs(), deviceId: dev.claims.device_id });
      const hubProof = await makeLanProof("hub", c.hubKey, { nonceD: json.nonce_d!, nonceH, deviceId: dev.claims.device_id, hubId: c.hubClaims.device_id, spki: c.spki });
      this.devicePub.set(dev.claims.device_id, dev.claims.pub);
      return { status: 200, text: JSON.stringify({ credential: c.hubCredentialJws, nonce_h: nonceH, hub_proof: hubProof }) };
    }
    if (path === "/sync/v1/lan/session") {
      const p = this.pending.get(json.nonce_h ?? "");
      this.pending.delete(json.nonce_h ?? ""); // single use
      if (!p || p.nonceD !== json.nonce_d || c.nowMs() - p.atMs > 30_000) return this.problem(401, "lan_proof_invalid");
      const pub = this.devicePub.get(p.deviceId)!;
      // The hub checks the proof over ITS OWN certificate's spki: a relay's session carries the device's view of the relay's.
      const ok = await verifyLanProof("device", pub, json.device_proof ?? "", { nonceD: p.nonceD, nonceH: json.nonce_h!, deviceId: p.deviceId, hubId: c.hubClaims.device_id, spki: c.spki });
      if (!ok) return this.problem(401, "lan_proof_invalid");
      const tok = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.sessions.set(tok, { deviceId: p.deviceId, expiresAtMs: c.nowMs() + this.ttlSeconds * 1000 });
      return { status: 200, text: JSON.stringify({ token: tok, expires_in: this.ttlSeconds }) };
    }
    const s = token ? this.sessions.get(token) : undefined;
    if (!s || s.expiresAtMs <= c.nowMs()) return this.problem(401, "lan_session_expired");
    return { status: 200, text: JSON.stringify(await c.app(path, JSON.parse(body))) };
  }

  private devicePub = new Map<string, string>();
}

export { lanProofMessage };
