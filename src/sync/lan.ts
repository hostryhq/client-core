import { b64url, fromB64url, importPublicKey, verifyRaw, type Credential, type Signer } from "./crypto";
import type { DeviceKind } from "./pii-serve";
import {
  TransportError,
  type HelloRequest,
  type HelloResponse,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncTransport,
} from "./transport";

/**
 * LAN transport to the hub (ADR-0002 A3.1; `sync/protocol-v1.md` "LAN handshake"). TLS 1.3 carries the bytes; the certificate is
 * self-signed and carries no trust. The peer is proven afterwards: mutual signatures over both nonces, both ids and the hash of
 * the certificate's key (`spki`) the device actually saw, each side's key vouched for by an identity-signed credential. A relay on
 * the Wi-Fi must present its own certificate, so the two `spki` values differ and both sides refuse.
 */

export const LAN_SESSION_HEADER = "Hostry-Lan-Session";
export const LAN_SESSION_TTL_S = 900;
export const HELLO_LAN_PATH = "/sync/v1/lan/hello";
export const OPEN_LAN_SESSION_PATH = "/sync/v1/lan/session";
const HUB_TAG = "hostry-lan-hub-v1";
const DEVICE_TAG = "hostry-lan-device-v1";
const CRED_JWS_TYP = "hostry-cred+jws";

const dec = new TextDecoder();

export type LanProofFields = { nonceD: string; nonceH: string; deviceId: string; hubId: string; spki: string };

/** The bytes a LAN proof signs: tag, `nonce_d`, `nonce_h`, device id, hub id, `spki`, newline-joined (UTF-8). */
export function lanProofMessage(role: "hub" | "device", f: LanProofFields): string {
  return [role === "hub" ? HUB_TAG : DEVICE_TAG, f.nonceD, f.nonceH, f.deviceId, f.hubId, f.spki].join("\n");
}

/** `spki`: lower-case hex SHA-256 of a certificate's DER `SubjectPublicKeyInfo`. */
export async function spkiHash(der: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", der as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyLanProof(role: "hub" | "device", signerPub: string, sig: string, f: LanProofFields): Promise<boolean> {
  try {
    return await verifyRaw(await importPublicKey(signerPub), lanProofMessage(role, f), sig);
  } catch {
    return false;
  }
}

export async function makeLanProof(role: "hub" | "device", signer: Signer, f: LanProofFields): Promise<string> {
  return signer.sign(lanProofMessage(role, f));
}

/** 32 random bytes as 43 base64url characters with no stray bits, the shape of both nonces and the session token. */
export function validLanToken(t: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(t)) return false;
  try {
    return b64url(fromB64url(t)) === t;
  } catch {
    return false;
  }
}

export type CredentialRefusal = "malformed" | "signature" | "tenant" | "outlet" | "kind" | "expired" | "revoked";

export type CredentialCheck = { ok: true; claims: Credential } | { ok: false; reason: CredentialRefusal };

export type CredentialExpect = {
  /** Identity verification keys from the device's own pack, kid to X9.62 point (current and next). */
  identityKeys: Readonly<Record<string, string>>;
  /** Unix seconds. */
  now: number;
  tenant?: string;
  outlet: string;
  /** `hub`, or any device kind of the outlet. */
  kind: "hub" | "device" | DeviceKind;
  revoked?: ReadonlySet<string>;
};

/** Checks a LAN credential (compact JWS, `typ` hostry-cred+jws) offline against the keys of the device's own pack. */
export async function verifyLanCredential(jws: string, x: CredentialExpect): Promise<CredentialCheck> {
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: Credential;
  try {
    header = JSON.parse(dec.decode(fromB64url(parts[0]!))) as typeof header;
    claims = JSON.parse(dec.decode(fromB64url(parts[1]!))) as Credential;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "ES256" || header.typ !== CRED_JWS_TYP || typeof header.kid !== "string" || typeof claims !== "object" || claims === null) return { ok: false, reason: "malformed" };
  const pub = x.identityKeys[header.kid];
  if (!pub || !(await verifyRaw(await importPublicKey(pub), `${parts[0]}.${parts[1]}`, parts[2]!))) return { ok: false, reason: "signature" };
  if (x.tenant !== undefined && claims.tenant_id !== x.tenant) return { ok: false, reason: "tenant" };
  if (claims.outlet_id !== x.outlet) return { ok: false, reason: "outlet" };
  if (x.kind === "hub" ? claims.kind !== "hub" : x.kind !== "device" && claims.kind !== x.kind) return { ok: false, reason: "kind" };
  if (typeof claims.not_after !== "number" || claims.not_after < x.now) return { ok: false, reason: "expired" };
  if (x.revoked?.has(claims.device_id)) return { ok: false, reason: "revoked" };
  return { ok: true, claims };
}

export type LanChannelResponse = {
  status: number;
  text: string;
  /** `spki` of the certificate of the connection that carried this response; absent when the runtime cannot read it. */
  spki?: string;
};

/**
 * One TLS connection pool to the hub. `pinSpki`, when given, must be checked on the connection BEFORE any byte of the request is
 * written: a connection to a different certificate fails and sends nothing (the session token never reaches a relay).
 */
export interface LanChannel {
  /** False in a browser: `fetch` cannot read the peer certificate, so the handshake cannot be made. */
  readonly peerCertReadable: boolean;
  post(path: string, body: string, headers: Record<string, string>, pinSpki?: string): Promise<LanChannelResponse>;
}

export type LanErrorCode = "peer_cert_unreadable" | "hub_refused" | "spki_changed" | "bad_response" | "refused_by_hub" | "network";

export class LanError extends TransportError {
  constructor(
    readonly code: LanErrorCode,
    message: string,
    status = 0,
    retriable = false,
  ) {
    super(status, message, retriable);
  }
}

export type LanTransportConfig = {
  channel: LanChannel;
  /** This device's own LAN credential (compact JWS) from its pack. */
  credential: string;
  deviceId: string;
  signer: Signer;
  /** Identity keys from the device's own pack, read at each handshake so a pack refresh takes effect. */
  identityKeys: () => Readonly<Record<string, string>>;
  tenantId: string;
  outletId: string;
  /** Revoked device ids of the pack. */
  revoked?: () => ReadonlySet<string>;
  /** Unix seconds, for `not_after`. */
  nowSeconds?: () => number;
  /** Milliseconds, monotonic enough for the 15-minute token; injectable. */
  nowMs?: () => number;
  randomBytes?: (n: number) => Uint8Array;
};

type Session = { token: string; spki: string; hubId: string; expiresAtMs: number };
/** Re-handshake this long before the token lapses, so a request does not race the hub's clock. */
const SESSION_SLACK_MS = 30_000;

/**
 * `SyncTransport` for the LAN hub. The handshake runs lazily at the first call, the session token rides on every request, and a
 * `401 lan_session_expired` (or a token about to lapse) runs it again, once per call.
 */
export class LanTransport implements SyncTransport {
  private session: Session | undefined;
  private handshaking: Promise<Session> | undefined;

  constructor(private readonly cfg: LanTransportConfig) {}

  /** Whether this runtime can verify a hub at all. A browser build cannot: it is a dev/test target and holds no live pack. */
  get peerVerification(): "spki" | "unavailable" {
    return this.cfg.channel.peerCertReadable ? "spki" : "unavailable";
  }

  /** True once a hub has been proven and a token is held. */
  get connected(): boolean {
    return this.session !== undefined && this.session.expiresAtMs > this.nowMs();
  }

  hello(req: HelloRequest): Promise<HelloResponse> {
    return this.call("/sync/v1/hello", req);
  }
  push(req: PushRequest): Promise<PushResponse> {
    return this.call("/sync/v1/push", req);
  }
  pull(req: PullRequest): Promise<PullResponse> {
    return this.call("/sync/v1/pull", req);
  }

  /** Forgets the session (for example after a pack refresh lists the hub revoked): the next call shakes hands again. */
  drop(): void {
    this.session = undefined;
  }

  private nowMs(): number {
    return (this.cfg.nowMs ?? Date.now)();
  }
  private nowSeconds(): number {
    return (this.cfg.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  }
  private nonce(): string {
    const n = this.cfg.randomBytes ? this.cfg.randomBytes(32) : crypto.getRandomValues(new Uint8Array(32));
    return b64url(n);
  }

  private async call<T>(path: string, payload: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const s = await this.ensureSession();
      const res = await this.send(path, JSON.stringify(payload), { [LAN_SESSION_HEADER]: s.token }, s.spki);
      if (res.status === 401 && isSessionExpired(res.text) && attempt === 0) {
        this.session = undefined;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new TransportError(res.status, `${path}: HTTP ${res.status} ${res.text.slice(0, 200)}`, res.status === 429 || res.status >= 500);
      if (res.spki !== undefined && res.spki !== s.spki) {
        this.session = undefined;
        throw new LanError("spki_changed", `${path}: the hub's certificate changed under an open session`);
      }
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new LanError("bad_response", `${path}: not JSON`);
      }
    }
  }

  private async send(path: string, body: string, headers: Record<string, string>, pin?: string): Promise<LanChannelResponse> {
    try {
      return await this.cfg.channel.post(path, body, { "content-type": "application/json", ...headers }, pin);
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new LanError("network", `${path}: ${e instanceof Error ? e.message : String(e)}`, 0, true);
    }
  }

  private ensureSession(): Promise<Session> {
    const s = this.session;
    if (s && s.expiresAtMs - SESSION_SLACK_MS > this.nowMs()) return Promise.resolve(s);
    this.session = undefined;
    this.handshaking ??= this.handshake().then(
      (n) => ((this.session = n), (this.handshaking = undefined), n),
      (e: unknown) => {
        this.handshaking = undefined;
        throw e;
      },
    );
    return this.handshaking;
  }

  private async handshake(): Promise<Session> {
    const c = this.cfg;
    if (!c.channel.peerCertReadable) {
      throw new LanError("peer_cert_unreadable", "this runtime cannot read the hub's TLS certificate; the LAN link cannot be verified, so live packs are refused (browser builds are dev/test only)");
    }
    const refuse = (why: string): never => {
      throw new LanError("hub_refused", `hub refused: ${why}`);
    };
    const nonceD = this.nonce();
    // Step 1: nothing but helloLan is sent until the hub is proven.
    const r1 = await this.send(HELLO_LAN_PATH, JSON.stringify({ credential: c.credential, nonce_d: nonceD }), {});
    if (r1.status !== 200) throw new LanError("refused_by_hub", `${HELLO_LAN_PATH}: HTTP ${r1.status} ${r1.text.slice(0, 200)}`, r1.status, r1.status >= 500 || r1.status === 429);
    const spki = r1.spki;
    if (!spki) return refuse("no certificate seen");
    let body: { credential?: string; nonce_h?: string; hub_proof?: string };
    try {
      body = JSON.parse(r1.text) as typeof body;
    } catch {
      return refuse("answer is not JSON");
    }
    if (typeof body.credential !== "string" || typeof body.nonce_h !== "string" || typeof body.hub_proof !== "string" || !validLanToken(body.nonce_h)) return refuse("malformed answer");
    const check = await verifyLanCredential(body.credential, {
      identityKeys: c.identityKeys(),
      now: this.nowSeconds(),
      tenant: c.tenantId,
      outlet: c.outletId,
      kind: "hub",
      ...(c.revoked ? { revoked: c.revoked() } : {}),
    });
    if (!check.ok) return refuse(`credential ${check.reason}`);
    const hubId = check.claims.device_id;
    const f: LanProofFields = { nonceD, nonceH: body.nonce_h, deviceId: c.deviceId, hubId, spki };
    // The proof must be over the certificate this device saw: a relay's certificate gives a different `spki` and the proof fails.
    if (!(await verifyLanProof("hub", check.claims.pub, body.hub_proof, f))) return refuse("proof invalid for the certificate seen");
    // Step 2: our own proof, over the same `spki`, on a connection to that same certificate.
    const deviceProof = await makeLanProof("device", c.signer, f);
    const r2 = await this.send(OPEN_LAN_SESSION_PATH, JSON.stringify({ nonce_d: nonceD, nonce_h: body.nonce_h, device_proof: deviceProof }), {}, spki);
    if (r2.status !== 200) throw new LanError("refused_by_hub", `${OPEN_LAN_SESSION_PATH}: HTTP ${r2.status} ${r2.text.slice(0, 200)}`, r2.status, r2.status >= 500 || r2.status === 429);
    if (r2.spki !== undefined && r2.spki !== spki) return refuse("certificate changed during the handshake");
    let sess: { token?: string; expires_in?: number };
    try {
      sess = JSON.parse(r2.text) as typeof sess;
    } catch {
      return refuse("session answer is not JSON");
    }
    if (typeof sess.token !== "string" || !validLanToken(sess.token)) return refuse("malformed session token");
    const ttl = Math.min(typeof sess.expires_in === "number" && sess.expires_in > 0 ? sess.expires_in : LAN_SESSION_TTL_S, LAN_SESSION_TTL_S);
    return { token: sess.token, spki, hubId, expiresAtMs: this.nowMs() + ttl * 1000 };
  }
}

function isSessionExpired(text: string): boolean {
  try {
    return (JSON.parse(text) as { code?: string }).code === "lan_session_expired";
  } catch {
    return false;
  }
}

/**
 * Browser channel: `fetch` cannot read the peer certificate, so it declares `peerCertReadable: false` and the transport refuses
 * to handshake (error `peer_cert_unreadable`). It exists so a browser build says so plainly instead of silently sending over an
 * unverified link. Dev/test only (ADR-0002 A3.3).
 */
export function browserLanChannel(): LanChannel {
  return {
    peerCertReadable: false,
    post: () => Promise.reject(new LanError("peer_cert_unreadable", "a browser cannot read the hub's certificate")),
  };
}
