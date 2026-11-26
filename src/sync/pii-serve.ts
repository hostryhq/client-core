import { COMMIT_PREFIX } from "./digest";
import { piiFields, type PiiCommit, type PiiWire } from "./pii-commit";
import type { OpEnvelope } from "./types";

/** Credential kinds (api-specs `Credential.kind`). */
export type DeviceKind = "pos" | "waiter" | "personal" | "kds" | "hub";

/**
 * Who receives `pii` (ADR-0014 A3.1 item 1; vectors `pii_placement`): every kind that takes a member session, plus the
 * hub; never a `kds`. The commitments are in the sealed body and reach every kind.
 */
export function servesPii(kind: DeviceKind): boolean {
  return kind !== "kds";
}

/**
 * The op as a node applies it: each committed pii field gets a pseudo-field `~c:<field>` carrying its commitment, in
 * the mutation that sets the row. The commitment then follows the field's own merge rule (the winner of
 * `customer_name` carries its commitment with it), and every node holds it whether or not it holds the value.
 * It is what the convergence hash covers in place of the value (ADR-0014 A3.2).
 */
export function withCommits(op: OpEnvelope): OpEnvelope {
  const pc = op.pii_c;
  if (!pc) return op;
  const muts = op.muts.map((m) => {
    const c = pc[m.e]?.[m.id];
    if (!c || (m.k !== "insert" && m.k !== "set")) return m;
    const extra: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(c)) extra[COMMIT_PREFIX + f] = v;
    return { ...m, f: { ...m.f, ...extra } };
  });
  return { ...op, muts };
}

/** Adds the verified fields of `more` (values and salts) to `base`. */
export function mergePii(base: PiiWire | undefined, more: PiiWire): PiiWire {
  const out: PiiWire = structuredClone(base ?? {});
  for (const [e, rows] of Object.entries(more)) {
    for (const [id, fields] of Object.entries(rows)) Object.assign(((out[e] ??= {})[id] ??= {}), fields);
  }
  return out;
}

/** (entity, row id, field) the body commits to for which the stored wire pii holds no value: `pii_incomplete` unless erased. */
export function missingPiiFields(commits: PiiCommit | undefined, held: unknown): Array<{ e: string; id: string; f: string }> {
  const have = new Set(piiFields(held).map((x) => `${x.e}|${x.id}|${x.f}`));
  const out: Array<{ e: string; id: string; f: string }> = [];
  for (const [e, rows] of Object.entries(commits ?? {})) {
    for (const [id, fields] of Object.entries(rows)) for (const f of Object.keys(fields)) if (!have.has(`${e}|${id}|${f}`)) out.push({ e, id, f });
  }
  return out;
}
