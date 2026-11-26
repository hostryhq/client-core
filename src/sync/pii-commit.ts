import { canonicalize } from "./canonical";
import { b64url, fromB64url, sha256Hex } from "./crypto";

/**
 * Salted per-field commitments of an op's personal data (svc-sync `syncproto/piic.go`; PROVISIONAL, security
 * ruling of the Phase 1 re-review). The sealed body carries only
 *
 *   pii_c[entity][row id][field] = hex SHA-256( salt || JCS(value) )
 *
 * with a fresh 16-byte random salt per field kept with the value, never in the body. The wire `pii` keeps the
 * entity -> row id -> field -> value shape and adds each salt as the sibling member `~s:<field>` (base64url, no
 * padding). Values are strings, booleans or integers. A node that ingests pii verifies every field against the
 * body and keeps only what matches. A cloud-signed erasure removes values and salts; commitments stay.
 */
export type PiiValues = Record<string, Record<string, Record<string, unknown>>>;
export type PiiCommit = Record<string, Record<string, Record<string, string>>>;
/** Values and their salts, as stored and as sent beside an op. */
export type PiiWire = PiiValues;

export const PII_SALT_PREFIX = "~s:";
export const PII_SALT_BYTES = 16;

const enc = new TextEncoder();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPiiValue = (v: unknown): boolean => typeof v === "string" || typeof v === "boolean" || Number.isSafeInteger(v);

export type RandomBytes = (n: number) => Uint8Array;
export const systemRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

async function commitOf(salt: Uint8Array, value: unknown): Promise<string> {
  const c = enc.encode(canonicalize(value));
  const buf = new Uint8Array(salt.length + c.length);
  buf.set(salt, 0);
  buf.set(c, salt.length);
  return sha256Hex(buf);
}

/** Turns the values of an op into the wire pii (values with salts) and the commitments for the sealed body. */
export async function commitPii(values: PiiValues | undefined, random: RandomBytes = systemRandom): Promise<{ wire: PiiWire; commits: PiiCommit } | undefined> {
  if (!values) return undefined;
  const wire: PiiWire = {};
  const commits: PiiCommit = {};
  for (const e of Object.keys(values).sort()) {
    for (const [id, fields] of Object.entries(values[e]!)) {
      for (const [name, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (name.startsWith(PII_SALT_PREFIX)) throw new Error(`pii: field name ${name} is reserved`);
        if (!isPiiValue(v)) throw new Error(`pii: ${e}.${name} must be a string, boolean or integer`);
        const salt = random(PII_SALT_BYTES);
        if (salt.length !== PII_SALT_BYTES) throw new Error("pii: salt must be 16 bytes");
        ((wire[e] ??= {})[id] ??= {})[name] = v;
        wire[e]![id]![PII_SALT_PREFIX + name] = b64url(salt);
        ((commits[e] ??= {})[id] ??= {})[name] = await commitOf(salt, v);
      }
    }
  }
  return Object.keys(wire).length ? { wire, commits } : undefined;
}

export type OpenedPii = {
  /** The wire pii reduced to the fields that match their commitment, values and salts; undefined when none. What a node stores. */
  verified: PiiWire | undefined;
  /** Verified values without salts. */
  values: PiiValues | undefined;
  /** Fields that arrived without a matching commitment, with a wrong salt or a bad value: discarded. */
  dropped: number;
};

/** Verifies wire pii against the commitments of the sealed body; an unverifiable field is dropped, never kept. */
export async function openPii(wire: unknown, commits: PiiCommit | undefined): Promise<OpenedPii> {
  const out: OpenedPii = { verified: undefined, values: undefined, dropped: 0 };
  if (wire === undefined || wire === null) return out;
  if (!isObj(wire)) return { ...out, dropped: 1 };
  const verified: PiiWire = {};
  const values: PiiValues = {};
  for (const [e, rows] of Object.entries(wire)) {
    if (!isObj(rows)) {
      out.dropped++;
      continue;
    }
    for (const [id, fields] of Object.entries(rows)) {
      if (!isObj(fields)) {
        out.dropped++;
        continue;
      }
      for (const [name, v] of Object.entries(fields)) {
        if (name.startsWith(PII_SALT_PREFIX)) continue;
        const want = commits?.[e]?.[id]?.[name];
        const saltS = fields[PII_SALT_PREFIX + name];
        let salt: Uint8Array | undefined;
        try {
          salt = typeof saltS === "string" ? fromB64url(saltS) : undefined;
        } catch {
          salt = undefined;
        }
        if (!isPiiValue(v) || typeof want !== "string" || !salt || salt.length !== PII_SALT_BYTES || (await commitOf(salt, v)) !== want) {
          out.dropped++;
          continue;
        }
        ((verified[e] ??= {})[id] ??= {})[name] = v;
        verified[e]![id]![PII_SALT_PREFIX + name] = saltS as string;
        ((values[e] ??= {})[id] ??= {})[name] = v;
      }
    }
  }
  if (Object.keys(verified).length) {
    out.verified = verified;
    out.values = values;
  }
  return out;
}

/** The values of stored wire pii without salts: what is applied to rows. */
export function stripSalts(wire: unknown): PiiValues | undefined {
  if (!isObj(wire)) return undefined;
  const out: PiiValues = {};
  for (const [e, rows] of Object.entries(wire)) {
    if (!isObj(rows)) continue;
    for (const [id, fields] of Object.entries(rows)) {
      if (!isObj(fields)) continue;
      for (const [name, v] of Object.entries(fields)) if (!name.startsWith(PII_SALT_PREFIX)) ((out[e] ??= {})[id] ??= {})[name] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** (entity, row id, field) triples a stored wire pii holds values for. */
export function piiFields(wire: unknown): Array<{ e: string; id: string; f: string }> {
  const out: Array<{ e: string; id: string; f: string }> = [];
  const v = stripSalts(wire);
  if (v) for (const [e, rows] of Object.entries(v)) for (const [id, fields] of Object.entries(rows)) for (const f of Object.keys(fields)) out.push({ e, id, f });
  return out;
}

/** Every string a set of values holds (for matching and purging text copies, e.g. in a print spool). */
export function piiStrings(values: PiiValues): string[] {
  const out = new Set<string>();
  for (const rows of Object.values(values)) for (const fields of Object.values(rows)) for (const v of Object.values(fields)) if (typeof v === "string" && v.length > 0) out.add(v);
  return [...out];
}
