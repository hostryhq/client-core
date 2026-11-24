import { canonicalize } from "./canonical";
import type { Seal } from "./types";

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** SHA-256, lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** The `ph` of the first op of an origin in a stream (svc-sync `syncproto.GenesisHash`). */
export function genesisHash(origin: string, stream: string): Promise<string> {
  return sha256Hex(`hostry-genesis-v1\n${origin}\n${stream}`);
}

/** Text a seal signature covers (svc-sync `syncproto.SealMessage`). */
export function sealMessage(origin: string, stream: string, seq: number, h: string): string {
  return `hostry-seal-v1\n${origin}\n${stream}\n${seq}\n${h}`;
}

/** Text an attestation signature covers (svc-sync `syncproto.AttestationMessage`). */
export function attestationMessage(a: { origin: string; stream: string; seq: number; h: string; by: string; rec: string }): string {
  return `hostry-attest-v1\n${a.origin}\n${a.stream}\n${a.seq}\n${a.h}\n${a.by}\n${a.rec}`;
}

/** Signs with the device key. The keystore-backed version lives in the shell; this is the contract. */
export interface Signer {
  readonly kid: string;
  /** False when the key is unusable (cleared TPM): the engine then enters the key-lost state (A1.3). */
  available(): boolean;
  /** ES256 over the UTF-8 bytes of `message`: base64url of the 64-byte r||s form. */
  sign(message: string): Promise<string>;
}

/** Resolves an origin's public key (from its identity-signed credential) and checks a signature. */
export interface SealVerifier {
  verify(origin: string, kid: string, message: string, sig: string): Promise<boolean>;
}

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** Software ES256 key for tests and the browser fallback. Production uses the platform keystore (ADR-0005). */
export class SoftwareSigner implements Signer {
  private usable = true;
  private constructor(
    readonly kid: string,
    private readonly key: CryptoKeyPair,
    /** Uncompressed X9.62 point, base64url: the credential's `pub`. */
    readonly publicB64: string,
  ) {}

  static async generate(kid: string): Promise<SoftwareSigner> {
    const key = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
    return new SoftwareSigner(kid, key, b64url(raw));
  }

  /** Imports an existing software key (PKCS#8 private key, public X9.62 point), for fixtures and tests. */
  static async import(kid: string, pkcs8B64: string, publicB64: string): Promise<SoftwareSigner> {
    const privateKey = await crypto.subtle.importKey("pkcs8", fromB64url(pkcs8B64) as BufferSource, P256, true, ["sign"]);
    const publicKey = await importPublicKey(publicB64);
    return new SoftwareSigner(kid, { privateKey, publicKey }, publicB64);
  }

  available(): boolean {
    return this.usable;
  }

  /** Simulates the key becoming unusable while the database survives. */
  lose(): void {
    this.usable = false;
  }

  async sign(message: string): Promise<string> {
    if (!this.usable) throw new Error("device key unavailable");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key.privateKey, enc.encode(message));
    return b64url(new Uint8Array(sig));
  }
}

export type Credential = {
  device_id: string;
  tenant_id: string;
  outlet_id: string;
  brand_id?: string;
  kind: string;
  kid: string;
  pub: string;
  recovers?: string;
  not_after: number;
};
export type CredentialEnvelope = { cred: Credential; sig: string };

export async function importPublicKey(pubB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(pubB64) as BufferSource, P256, true, ["verify"]);
}

export async function verifyRaw(key: CryptoKey, message: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(sig) as BufferSource, enc.encode(message));
  } catch {
    return false;
  }
}

/** Public keys by (origin, kid). Fed from identity-signed credentials served with ops. */
export class KeyRing implements SealVerifier {
  private keys = new Map<string, CryptoKey>();
  private cloudKeys = new Map<string, CryptoKey>();

  constructor(private readonly identityPub?: string) {}

  async add(origin: string, kid: string, pubB64: string): Promise<void> {
    this.keys.set(`${origin}|${kid}`, await importPublicKey(pubB64));
  }

  /** The gateway's op-signing key, which seals every `cloud-<epoch>` origin. */
  async addCloudKey(kid: string, pubB64: string): Promise<void> {
    this.cloudKeys.set(kid, await importPublicKey(pubB64));
  }

  /**
   * Accepts credentials served with pulled ops, after checking the identity signature. Returns the number
   * accepted; a credential with a bad signature is ignored, never trusted.
   */
  async ingest(envelopes: CredentialEnvelope[]): Promise<number> {
    if (!this.identityPub) return 0;
    const idKey = await importPublicKey(this.identityPub);
    let n = 0;
    for (const e of envelopes) {
      if (!(await verifyRaw(idKey, `hostry-cred-v1\n${canonicalize(e.cred)}`, e.sig))) continue;
      await this.add(e.cred.device_id, e.cred.kid, e.cred.pub);
      n++;
    }
    return n;
  }

  async verify(origin: string, kid: string, message: string, sig: string): Promise<boolean> {
    const key = origin.startsWith("cloud-") ? this.cloudKeys.get(kid) : this.keys.get(`${origin}|${kid}`);
    return key ? verifyRaw(key, message, sig) : false;
  }
}

export async function makeSeal(signer: Signer, origin: string, stream: string, seq: number, h: string): Promise<Seal> {
  return { origin, stream, seq, h, kid: signer.kid, sig: await signer.sign(sealMessage(origin, stream, seq, h)) };
}

export function verifySeal(verifier: SealVerifier, s: Seal): Promise<boolean> {
  return verifier.verify(s.origin, s.kid, sealMessage(s.origin, s.stream, s.seq, s.h), s.sig);
}
