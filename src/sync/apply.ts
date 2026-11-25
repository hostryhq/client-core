import type { Row, StoreTx } from "../store";
import { compareStamp } from "./hlc";
import { reviewFields, type EntitySchema, type SchemaRegistry } from "./schema";
import type { Hlc, Mutation, OpEnvelope, OpRef } from "./types";

/** Internal tables. Underscore-prefixed fields of domain rows are internal and never sent. */
export const T = {
  op: "_s_op",
  void: "_s_void",
  conflict: "_s_conflict",
  head: "_s_head",
  vv: "_s_vv",
  seal: "_s_seal",
  meta: "_s_meta",
  deliv: "_s_deliv",
  held: "_s_held",
  grant: "_s_grant",
  series: "_s_series",
  clockq: "_s_clockq",
  ph: "_s_ph",
  /** Slots taken by hash with no binding yet (A2.8): row per slot. */
  unbound: "_s_unbound",
  /** Recorded chain conflicts, one row per (origin, stream, kind of upstream) (A2.8 item 1.4). */
  cc: "_s_cc",
} as const;

export const opId = (r: OpRef): string => `${r.stream}|${r.origin}|${r.seq}`;
export const opRowId = (r: OpRef): string => `${r.stream}|${r.origin}|${String(r.seq).padStart(10, "0")}`;

/** A written value of one lww field, kept until the cloud confirms it (ADR-0002 S6 "candidates"). */
type Cand = { h: Hlc; o: string; i: string; v: unknown; p?: Hlc; c?: number };
type Groups = Record<string, Cand[]>;

export type ApplyCtx = {
  tenantId: string;
  schemas: SchemaRegistry;
  /** True when the cloud has accepted and confirmed this op (used only to trim candidates). */
  confirmed: (ref: OpRef) => boolean;
};

const TOMB = "_del";

/** Fields a writer may not set directly. */
const reserved = (k: string): boolean => k.startsWith("_") || k === "id" || k === "tenant_id" || k === "deleted";

function clean(f: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f ?? {})) if (!reserved(k)) out[k] = v;
  return out;
}

function parseRef(i: string): OpRef {
  const [stream, origin, seq] = i.split("|") as [string, string, string];
  return { stream, origin, seq: Number(seq) };
}

function winner(cands: Cand[]): Cand {
  let w = cands[0]!;
  for (const c of cands) if (compareStamp(c.h, c.o, w.h, w.o) > 0) w = c;
  return w;
}

/** Recompute visible values of a row from its candidates, skipping voided ops. A row with no candidate does not exist. */
function recompute(tx: StoreTx, row: Row & { _g?: Groups }, mixed = false): void {
  const g: Groups = row._g ?? {};
  for (const f of Object.keys(g)) {
    const live = g[f]!.filter((c) => !tx.get(T.void, c.i));
    if (live.length === 0) {
      delete g[f];
      if (f !== TOMB) delete row[f];
      continue;
    }
    g[f] = live;
    if (f !== TOMB) row[f] = winner(live).v;
  }
  row._g = g;
  if (mixed) return; // a mixed row has no tombstone: it is never "deleted", whatever order its ops arrive in
  const t = g[TOMB];
  row.deleted = !t || winner(t).v !== false;
}

/**
 * Drops candidates the cloud has confirmed once a higher confirmed one exists. Review fields are never
 * trimmed: a late concurrent edit must still find the candidate it conflicts with, or two nodes would
 * disagree about whether a manager is owed a decision. (Edits to those fields are rare; the cost is a
 * few retained candidates per price. Trimming them safely is a follow-up.)
 */
function trim(g: Groups, ctx: ApplyCtx, review: string[] = []): void {
  for (const f of Object.keys(g)) {
    if (review.includes(f)) continue;
    const cands = g[f]!;
    const conf = cands.filter((c) => ctx.confirmed(parseRef(c.i)));
    if (conf.length < 2) continue;
    const top = winner(conf);
    g[f] = cands.filter((c) => !conf.includes(c) || c === top);
  }
}

export type ConflictRow = Row & {
  entity: string;
  row_id: string;
  field: string;
  winner: unknown;
  loser: unknown;
  lo: string;
  hi: string;
};

function detectConflicts(tx: StoreTx, schema: EntitySchema, rowId: string, g: Groups, ctx: ApplyCtx): void {
  for (const f of reviewFields(schema)) {
    const cands = g[f] ?? [];
    for (let a = 0; a < cands.length; a++) {
      for (let b = a + 1; b < cands.length; b++) {
        const x = cands[a]!;
        const y = cands[b]!;
        // Concurrent edits were made from the same base: both carry the same non-empty `prev`.
        if (x.p === undefined || y.p === undefined || x.p !== y.p) continue;
        const [lo, hi] = compareStamp(x.h, x.o, y.h, y.o) < 0 ? [x, y] : [y, x];
        tx.put(T.conflict, {
          id: `${schema.name}|${rowId}|${f}|${lo.i}|${hi.i}`,
          tenant_id: ctx.tenantId,
          entity: schema.name,
          row_id: rowId,
          field: f,
          winner: hi.v,
          loser: lo.v,
          lo: lo.i,
          hi: hi.i,
        } satisfies ConflictRow);
      }
    }
  }
}

/**
 * Mixed-policy entity (check, order_line): each field follows its own rule, so replaying or reordering ops gives the
 * same row. Immutable fields come from the insert (two inserts of one id, a client bug, keep the lower stamp);
 * lww and lww_review fields keep candidates by (hlc, origin) as in an lww entity, with `prev` for review fields;
 * rank fields only move forward; delta fields add up. The mutation kind says what the writer meant; the field's
 * policy decides what happens, and a field that does not accept the kind is ignored.
 */
function applyMixed(
  ctx: ApplyCtx,
  op: OpEnvelope,
  m: Mutation,
  schema: EntitySchema,
  existing: Row | undefined,
  f: Record<string, unknown>,
  i: string,
  out: ApplyResult,
  tx: StoreTx,
): void {
  if (m.k === "del" || m.k === "undel") {
    out.ignored.push(`${m.e}: ${m.k} ignored`);
    return;
  }
  const row = (existing ?? { id: m.id, tenant_id: ctx.tenantId, _g: {} }) as Row & { _g: Groups; _ih?: string; _io?: string };
  row._g ??= {};
  const g = row._g;
  const rules = schema.fields ?? {};

  let takesImmutable = false;
  if (m.k === "insert") {
    // A lower stamp replaces the immutable fields of an earlier insert of the same id, so every node settles on one.
    takesImmutable = row._ih === undefined || compareStamp(op.hlc, op.origin, row._ih, row._io as string) < 0;
    if (takesImmutable) {
      for (const [k, r] of Object.entries(rules)) if (r.policy === "immutable") delete row[k];
      row._ih = op.hlc;
      row._io = op.origin;
    }
  }

  for (const [k, v] of Object.entries(f)) {
    const r = rules[k];
    if (!r) {
      out.ignored.push(`${m.e}.${k}: unknown field`);
      continue;
    }
    switch (r.policy) {
      case "immutable":
        if (m.k !== "insert") out.ignored.push(`${m.e}.${k}: immutable, ${m.k} ignored`);
        else if (takesImmutable) row[k] = v;
        break;
      case "lww":
      case "lww_review": {
        if (m.k !== "insert" && m.k !== "set") {
          out.ignored.push(`${m.e}.${k}: ${m.k} ignored`);
          break;
        }
        const list = (g[k] ??= []);
        if (!list.some((c) => c.i === i)) {
          const p = m.k === "set" ? m.prev?.[k] : undefined;
          list.push({ h: op.hlc, o: op.origin, i, v, ...(p !== undefined ? { p } : {}) });
        }
        break;
      }
      case "rank": {
        if (m.k === "delta") {
          out.ignored.push(`${m.e}.${k}: delta ignored`);
          break;
        }
        const order = r.order ?? [];
        const nr = order.indexOf(v as string);
        const cr = row[k] === undefined ? -1 : order.indexOf(row[k] as string);
        if (nr > cr) row[k] = v; // never backwards; an unknown value (-1) never wins
        break;
      }
      case "delta": {
        if (m.k !== "insert" && m.k !== "delta") {
          out.ignored.push(`${m.e}.${k}: ${m.k} ignored`);
          break;
        }
        if (typeof v === "number" && Number.isInteger(v)) row[k] = ((row[k] as number | undefined) ?? 0) + v;
        break;
      }
    }
  }
  trim(g, ctx, reviewFields(schema));
  detectConflicts(tx, schema, m.id, g, ctx);
  recompute(tx, row, true);
  tx.put(m.e, row);
}

export type ApplyResult = { ignored: string[] };

/** Apply one mutation. Pure function of (row state, op); commutative and idempotent under each policy. */
function applyMutation(tx: StoreTx, ctx: ApplyCtx, op: OpEnvelope, m: Mutation, out: ApplyResult): void {
  const schema = ctx.schemas.get(m.e);
  if (!schema) {
    out.ignored.push(`unknown entity ${m.e}`); // invariant 8: tolerate newer ops
    return;
  }
  const ref: OpRef = { origin: op.origin, stream: op.stream, seq: op.seq };
  const i = opId(ref);
  const existing = tx.get(m.e, m.id) as (Row & { _g?: Groups }) | undefined;
  const f = clean(m.f);

  switch (schema.policy) {
    case "mixed": {
      applyMixed(ctx, op, m, schema, existing, f, i, out, tx);
      return;
    }
    case "append": {
      if (m.k !== "insert") {
        out.ignored.push(`${m.e}: append entities are immutable, ${m.k} ignored`);
        return;
      }
      // A duplicate insert of the same id is a no-op. If two different ops inserted one id (a client bug),
      // the lower stamp wins on every node, so even that case converges.
      const incoming = { ...f, id: m.id, tenant_id: ctx.tenantId, _o: i, _h: op.hlc, _ho: op.origin };
      if (existing) {
        const eh = existing._h as string | undefined;
        if (eh === undefined || compareStamp(op.hlc, op.origin, eh, existing._ho as string) >= 0) return;
      }
      tx.put(m.e, incoming);
      return;
    }
    case "delta": {
      if (m.k !== "insert" && m.k !== "delta") {
        out.ignored.push(`${m.e}: ${m.k} ignored`);
        return;
      }
      const row: Row = existing ?? { id: m.id, tenant_id: ctx.tenantId };
      for (const [k, v] of Object.entries(f)) {
        if (schema.deltas?.includes(k)) {
          if (typeof v === "number" && Number.isInteger(v)) row[k] = ((row[k] as number | undefined) ?? 0) + v;
        } else if (m.k === "insert" && row[k] === undefined) {
          row[k] = v;
        }
      }
      tx.put(m.e, row);
      return;
    }
    case "rank": {
      if (m.k !== "insert" && m.k !== "set" && m.k !== "rank") {
        out.ignored.push(`${m.e}: ${m.k} ignored`);
        return;
      }
      const row: Row = existing ?? { id: m.id, tenant_id: ctx.tenantId };
      for (const [k, v] of Object.entries(f)) {
        const order = schema.ranks?.[k];
        if (order) {
          const nr = order.indexOf(v as string);
          const cr = row[k] === undefined ? -1 : order.indexOf(row[k] as string);
          if (nr > cr) row[k] = v; // never backwards
        } else if (m.k === "insert" && row[k] === undefined) {
          row[k] = v;
        }
      }
      tx.put(m.e, row);
      return;
    }
    case "lww": {
      const row = (existing ?? { id: m.id, tenant_id: ctx.tenantId, _g: {} }) as Row & { _g: Groups };
      row._g ??= {};
      const g = row._g;
      const add = (field: string, v: unknown, p?: Hlc): void => {
        const list = (g[field] ??= []);
        if (list.some((c) => c.i === i)) return;
        list.push({ h: op.hlc, o: op.origin, i, v, ...(p !== undefined ? { p } : {}) });
      };
      if (m.k === "insert") {
        for (const [k, v] of Object.entries(f)) add(k, v);
        add(TOMB, false);
      } else if (m.k === "set") {
        // A set that arrives before its insert is kept as a candidate; the row shows once the insert lands.
        for (const [k, v] of Object.entries(f)) add(k, v, m.prev?.[k]);
      } else if (m.k === "del" || m.k === "undel") {
        if (!schema.deletable) {
          out.ignored.push(`${m.e}: not deletable`);
          return;
        }
        add(TOMB, m.k === "del"); // true = deleted
      } else {
        out.ignored.push(`${m.e}: ${m.k} ignored`);
        return;
      }
      trim(g, ctx, reviewFields(schema));
      detectConflicts(tx, schema, m.id, g, ctx);
      recompute(tx, row);
      tx.put(m.e, row);
      return;
    }
  }
}

export function applyMutations(tx: StoreTx, ctx: ApplyCtx, op: OpEnvelope): ApplyResult {
  const out: ApplyResult = { ignored: [] };
  for (const m of op.muts) applyMutation(tx, ctx, op, m, out);
  return out;
}

/** True when the op changes last-writer-wins master data (the only ops that depend on the clock for correctness). */
export function touchesLww(ctx: ApplyCtx, op: OpEnvelope): boolean {
  return op.muts.some((m) => {
    const s = ctx.schemas.get(m.e);
    if (s?.policy === "lww") return true;
    return s?.policy === "mixed" && Object.values(s.fields ?? {}).some((r) => r.policy === "lww" || r.policy === "lww_review");
  });
}

/**
 * A refused configuration op is voided on every node: its candidates are dropped and the winner is
 * recomputed locally, so a later legitimate edit is never overwritten (ADR-0002 S6, review M-1).
 */
export function applyVoidTo(tx: StoreTx, ctx: ApplyCtx, target: OpRef, appliedOp: OpEnvelope | undefined): void {
  const id = opId(target);
  tx.put(T.void, { id, tenant_id: ctx.tenantId });
  if (appliedOp) {
    for (const m of appliedOp.muts) {
      const pol = ctx.schemas.get(m.e)?.policy;
      if (pol !== "lww" && pol !== "mixed") continue;
      const row = tx.get(m.e, m.id) as (Row & { _g?: Groups }) | undefined;
      if (row) {
        recompute(tx, row, pol === "mixed");
        tx.put(m.e, row);
      }
    }
  }
  for (const c of tx.list(T.conflict) as ConflictRow[]) {
    if (c.lo === id || c.hi === id) tx.del(T.conflict, c.id);
  }
}

/** Strip internal fields: what a screen or a state hash sees. */
export function visible(row: Row): Row {
  const out: Row = { id: row.id, tenant_id: row.tenant_id };
  for (const [k, v] of Object.entries(row)) if (!k.startsWith("_") && k !== "deleted") out[k] = v;
  return out;
}
