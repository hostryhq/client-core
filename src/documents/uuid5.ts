/**
 * Deterministic UUIDv5 (RFC 9562) for entities whose id is a function of business keys so two offline devices
 * write the same row: business_day, manual-book bills, billing_settings, price_entry. Pure TypeScript SHA-1
 * (synchronous, runs in every shell and in tests); not used for anything security-relevant.
 */

/** Namespace for Hostry's deterministic ids (api-specs entities/README.md; "to be fixed in go-common/sync"). */
export const HOSTRY_ID_NAMESPACE = "9a3c7f1e-5b2d-5c84-a1e6-4d0f8b27c3a9";

function sha1(data: Uint8Array): Uint8Array {
  const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + (f as number) + e + (k as number) + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}

function parseUuid(u: string): Uint8Array {
  const hex = u.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`bad uuid ${u}`);
  return Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16));
}

/** Lowercase hex SHA-1 of a UTF-8 string; used for content fingerprints (not security). */
export function sha1Hex(text: string): string {
  return [...sha1(new TextEncoder().encode(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** UUIDv5 of `name` (UTF-8) in `namespace` (default: the Hostry namespace). */
export function uuidv5(name: string, namespace: string = HOSTRY_ID_NAMESPACE): string {
  const ns = parseUuid(namespace);
  const nm = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nm.length);
  buf.set(ns);
  buf.set(nm, ns.length);
  const d = sha1(buf).slice(0, 16);
  d[6] = (d[6]! & 0x0f) | 0x50;
  d[8] = (d[8]! & 0x3f) | 0x80;
  const x = [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
