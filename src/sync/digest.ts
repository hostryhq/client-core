import type { Row } from "../store";
import { canonicalize } from "./canonical";
import { sha256Hex } from "./crypto";

/**
 * The canonical row form of every convergence hash (api-specs sync/protocol-v1.md "Projection digest"; ADR-0014 A3.2).
 * Row text = JCS of `id`, every non-pii field the row has set and, for each pii field it holds a commitment for, the
 * member `~c:<field>` carrying that commitment. Never a pii value or a salt, so the text is equal on a till, a kds,
 * the hub and the cloud and does not change when a field is erased.
 */
export const COMMIT_PREFIX = "~c:";

const internal = (k: string): boolean => k.startsWith("_") || k === "tenant_id" || k === "deleted";

/** The row text for the digest. `piiFields` are the entity's `pii: true` field names; their values are always left out. */
export function digestRowText(row: Row, piiFields: readonly string[] = []): string {
  const pii = new Set(piiFields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (internal(k) || pii.has(k) || v === undefined || v === null) continue;
    out[k] = v;
  }
  return canonicalize(out);
}

/** `hash` of one entity: SHA-256 over the row texts in ascending id order (byte order), each followed by a line feed. */
export async function entityDigest(rows: Array<{ id: string; text: string }>): Promise<{ hash: string; rowCount: number }> {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hash: await sha256Hex(sorted.map((r) => `${r.text}\n`).join("")), rowCount: sorted.length };
}

/** State hash: SHA-256 over `<entity>\n<row_count>\n<hash>\n` for each listed entity in ascending name order. */
export function stateDigest(entities: Array<{ name: string; rowCount: number; hash: string }>): Promise<string> {
  const sorted = [...entities].filter((e) => e.rowCount > 0).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(sorted.map((e) => `${e.name}\n${e.rowCount}\n${e.hash}\n`).join(""));
}
