import { canonicalize } from "./canonical";
import { b64url, fromB64url, importPublicKey, sha256Hex, verifyRaw, type CredentialEnvelope, type Signer } from "./crypto";
import type { Attestation, ChainConflict, Endorsement, HeldCode, OpRef, Seal, SlotHash, VersionVector, WireItem } from "./types";

/**
 * Wire types of Sync Protocol v1. They mirror svc-sync `syncproto` (the Go side owns the format; the
 * contract moves to api-specs/sync/). Vectors are flat on the wire, keyed `origin/stream`; the engine
 * holds them per stream, and `toWireVector` / `fromWireVector` convert.
 */
export type WireVector = Record<string, number>;

export type HeldSlot = { origin: string; stream: string; seq: number; code: HeldCode };
export type Refusal = { origin: string; stream: string; seq: number; reason: string };

export type HelloRequest = {
  protocol: 1;
  app_version?: string;
  schema_version?: number;
  vector?: WireVector;
  /** The cloud epoch this node last synced under. */
  epoch?: string;
  /** The cloud vector this node last saw. */
  cloud_vector?: WireVector;
  /** Slots taken by hash with no binding yet; listed at every direct cloud hello (A2.8 item 1.3). */
  unbound?: OpRef[];
  /** Chain conflicts recorded and not yet reported; sent at a direct cloud hello (A2.8 item 1.4). */
  chain_conflicts?: ChainConflict[];
};

export type HelloResponse = {
  protocol: number;
  role: string;
  node_id: string;
  /** Upstream time, RFC 3339. */
  time: string;
  epoch?: string;
  vector: WireVector;
  cloud_vector?: WireVector;
  min_supported_version: string;
  snapshot_required: boolean;
  streams: string[];
  /** The cloud's own hash for each slot listed in `unbound` that it holds. Equal clears the mark. */
  unbound_h?: SlotHash[];
};

export type PushRequest = { items: WireItem[]; seals?: Seal[]; attestations?: Attestation[] };

export type PushResponse = {
  epoch?: string;
  vector: WireVector;
  held?: HeldSlot[];
  refused?: Refusal[];
  drained?: boolean;
};

export type PullRequest = { vector: WireVector; streams?: string[]; placeholders?: OpRef[]; /** Stored cloud-origin seals under a dropped op-signing key, at most 200 (A2.8 item 2). */ stale_seals?: OpRef[]; limit?: number };

export type PullResponse = {
  epoch?: string;
  items: WireItem[];
  seals?: Seal[];
  /** Gateway endorsements for a released unsealed tail (A2.1), with the attestation that goes with them. */
  endorsements?: Endorsement[];
  attestations?: Attestation[];
  creds?: CredentialEnvelope[];
  /** Answer to `stale_seals`: the seals as the upstream holds them now. */
  seal_refresh?: Seal[];
  more: boolean;
  /** The complete current list of the caller's own held slots (A1.2). */
  own_held: HeldSlot[];
  relay_held?: HeldSlot[];
};

/** The single interface the web layer sees; a browser fetch implementation here, the native shell for the LAN hub. */
export interface SyncTransport {
  hello(req: HelloRequest): Promise<HelloResponse>;
  push(req: PushRequest): Promise<PushResponse>;
  pull(req: PullRequest): Promise<PullResponse>;
}

export function toWireVector(perStream: Record<string, VersionVector>): WireVector {
  const out: WireVector = {};
  for (const [stream, vv] of Object.entries(perStream)) {
    for (const [origin, seq] of Object.entries(vv)) out[`${origin}/${stream}`] = seq;
  }
  return out;
}

export function fromWireVector(w: WireVector | undefined): Record<string, VersionVector> {
  const out: Record<string, VersionVector> = {};
  for (const [k, seq] of Object.entries(w ?? {})) {
    const i = k.indexOf("/");
    if (i <= 0) continue;
    (out[k.slice(i + 1)] ??= {})[k.slice(0, i)] = seq;
  }
  return out;
}

export class TransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Retrying later may help: network error, 429, 5xx. */
    readonly retriable: boolean,
  ) {
    super(message);
  }
}

/** Request authentication and, for the LAN, verification of the answering hub. */
export type HttpAuth = {
  authorize(method: string, path: string, body: string): Promise<Record<string, string>> | Record<string, string>;
  /** Throws when the response is not from who it should be (the hub's proof header). */
  verify?(reqHeaders: Record<string, string>, resp: Response, bodyText: string): Promise<void>;
};

export type HttpTransportConfig = {
  /** For example `https://sync.example.test` or `https://192.168.1.20:8443` (a configured hub URL; discovery is the shell's job). */
  baseUrl: string;
  fetch?: typeof fetch;
  auth?: HttpAuth;
  timeoutMs?: number;
};

/** HTTP/JSON transport to the cloud gateway or the hub: same API for both (ADR-0002 S10). */
export class HttpTransport implements SyncTransport {
  private readonly f: typeof fetch;

  constructor(private readonly cfg: HttpTransportConfig) {
    this.f = cfg.fetch ?? ((...a) => fetch(...a));
  }

  hello(req: HelloRequest): Promise<HelloResponse> {
    return this.post("/sync/v1/hello", req);
  }

  push(req: PushRequest): Promise<PushResponse> {
    return this.post("/sync/v1/push", req);
  }

  pull(req: PullRequest): Promise<PullResponse> {
    return this.post("/sync/v1/pull", req);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const extra = (await this.cfg.auth?.authorize("POST", path, body)) ?? {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 10_000);
    try {
      const res = await this.f(this.cfg.baseUrl.replace(/\/+$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body,
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new TransportError(res.status, `${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status === 429 || res.status >= 500);
      await this.cfg.auth?.verify?.({ ...extra }, res, text);
      return JSON.parse(text) as T;
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError(0, `${path}: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Cloud: a device access token from identity (ADR-0005) as a bearer token. */
export function bearerAuth(getToken: () => Promise<string> | string): HttpAuth {
  return { authorize: async () => ({ authorization: `Bearer ${await getToken()}` }) };
}

export type LanAuthConfig = {
  cred: CredentialEnvelope;
  signer: Signer;
  /** Identity's public key (X9.62 point, base64url): used to check the hub's credential. */
  identityPub: string;
  outlet: string;
  nowSeconds?: () => number;
};

/**
 * LAN authentication (ADR-0002 S10; svc-sync `hub.LANClient`): the device presents its identity-signed
 * credential and signs method, path, timestamp and body hash with its device key; the hub answers with a
 * proof that is checked here: only a credential of kind `hub` for this outlet, signed by identity, whose
 * key signed this request and this answer, is accepted. A fake hub on the Wi-Fi gains nothing.
 */
export function lanAuth(c: LanAuthConfig): HttpAuth {
  const now = c.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    async authorize(method, path, body) {
      const ts = now();
      const sig = await c.signer.sign(`hostry-lan-v1\n${method}\n${path}\n${ts}\n${await sha256Hex(body)}`);
      return { "Hostry-Device-Assertion": b64url(enc.encode(JSON.stringify({ cred: c.cred, ts, sig }))) };
    },
    async verify(reqHeaders, resp, bodyText) {
      const fail = (why: string): never => {
        throw new TransportError(0, `hub proof invalid: ${why}`, false);
      };
      const raw = resp.headers.get("Hostry-Hub-Proof");
      if (!raw) return fail("missing");
      const assertion = JSON.parse(dec.decode(fromB64url(reqHeaders["Hostry-Device-Assertion"] ?? ""))) as { sig: string };
      const proof = JSON.parse(dec.decode(fromB64url(raw))) as { cred: CredentialEnvelope; sig: string };
      const idKey = await importPublicKey(c.identityPub);
      if (!(await verifyRaw(idKey, `hostry-cred-v1\n${canonicalize(proof.cred.cred)}`, proof.cred.sig))) return fail("credential not signed by identity");
      const hub = proof.cred.cred;
      if (hub.kind !== "hub" || hub.outlet_id !== c.outlet || hub.tenant_id !== c.cred.cred.tenant_id) return fail("not this outlet's hub");
      const key = await importPublicKey(hub.pub);
      if (!(await verifyRaw(key, `hostry-hub-v1\n${assertion.sig}\n${await sha256Hex(bodyText)}`, proof.sig))) return fail("signature");
    },
  };
}
