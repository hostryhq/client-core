import type { SchemaRegistry } from "./schema";
import type { Mutation, OpEnvelope } from "./types";

/**
 * Personal data beside an op (ADR-0002 S4, review M-10): entity -> row id -> field -> value. It travels in the item's
 * `pii`, outside the op hash, and the cloud keeps it in an erasable side table. This is the shape
 * go-common `sync.ParseOp` enforces; a flat `{ field: value }` object is refused there.
 */
export type PiiObject = Record<string, Record<string, Record<string, unknown>>>;

/** Limits of go-common `sync` (`MaxBodyBytes`, `MaxPIIBytes`): the op body (UTF-8 bytes of the JSON that `h` covers) and the compact `pii` JSON. */
export const MAX_OP_BODY_BYTES = 262_144;
export const MAX_PII_BYTES = 16_384;

/** An op is over the size limit: refused before it is recorded, so nothing (numbers included) is consumed. */
export class OpTooLargeError extends Error {
  readonly code = "op_too_large" as const;
  constructor(
    readonly part: "body" | "pii",
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`op_too_large: ${part} is ${bytes} bytes, the limit is ${limit}`);
    this.name = "OpTooLargeError";
  }
}

const enc = new TextEncoder();
export const utf8Bytes = (s: string): number => enc.encode(s).length;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for entity -> row id -> field -> value. An empty object is valid (and means no personal data). */
export function isPiiObject(v: unknown): v is PiiObject {
  if (!isObj(v)) return false;
  return Object.values(v).every((rows) => isObj(rows) && Object.values(rows).every((fields) => isObj(fields)));
}

/**
 * Moves every field the entity schema declares `pii` out of the mutations into the op's `pii` object, so the
 * hashed body never carries personal data. An explicit `pii` of the right shape is kept and merged; one of any
 * other shape (the old flat form) is ignored, because the schema-driven split is the source of truth. Returns
 * new mutations; the input is not changed.
 */
export function splitPii(muts: Mutation[], schemas: SchemaRegistry, explicit?: unknown): { muts: Mutation[]; pii: PiiObject | undefined } {
  const pii: PiiObject = {};
  const put = (e: string, id: string, f: string, v: unknown): void => {
    ((pii[e] ??= {})[id] ??= {})[f] = v;
  };
  if (isPiiObject(explicit)) {
    for (const [e, rows] of Object.entries(explicit)) for (const [id, fs] of Object.entries(rows)) for (const [f, v] of Object.entries(fs)) put(e, id, f, v);
  }
  const out = muts.map((m) => {
    const declared = schemas.get(m.e)?.pii;
    if (!declared?.length || !m.f) return m;
    const keep: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(m.f)) {
      if (declared.includes(f) && v !== undefined) put(m.e, m.id, f, v);
      else keep[f] = v;
    }
    return { ...m, f: keep };
  });
  return { muts: out, pii: Object.keys(pii).length ? pii : undefined };
}

/**
 * The op as a node applies it: the body's mutations with the personal data that travelled beside it put back into
 * the fields it names, so a row reads as before and each field keeps its own conflict policy. Only (entity, row)
 * pairs the op's own mutations touch are merged, and `pii` of any other shape is ignored.
 */
export function withPii(op: OpEnvelope, pii: unknown): OpEnvelope {
  if (!isPiiObject(pii)) return op;
  const muts = op.muts.map((m) => {
    const extra = pii[m.e]?.[m.id];
    return extra ? { ...m, f: { ...m.f, ...extra } } : m;
  });
  return { ...op, muts };
}
