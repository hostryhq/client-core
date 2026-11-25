/**
 * Entity schemas: the conflict policy of each entity declared in one place, next to the entity
 * (offline-first-sync invariant 5; ADR-0002 S6). In production these are generated from
 * `api-specs/sync/entities/*.yaml`; until that lands, the registry below is the proof-of-concept set
 * that exercises every policy.
 *
 * Field groups: a field group is one field in this implementation (each field has its own stamp).
 */
export type Policy =
  /** Insert only; an inserted row is immutable; duplicate insert is a no-op. Orders, bills, payments. */
  | "append"
  /** Per field, highest (hlc, origin) among non-voided candidates wins. Master data. */
  | "lww"
  /** Forward-only status of one instance: the highest declared rank wins. */
  | "rank"
  /** Signed deltas; the value is the sum. Stock, loyalty points. */
  | "delta"
  /**
   * One policy per field (`fields`): immutable after insert, lww, lww with review, forward-only rank, or delta.
   * Entities such as `check` and `order_line`, which a till edits while the kitchen and the bill move them forward.
   */
  | "mixed";

export type FieldPolicy = "immutable" | "lww" | "lww_review" | "rank" | "delta";

export type FieldRule = {
  policy: FieldPolicy;
  /** rank: values, lowest first. */
  order?: string[];
};

export type DocType = "tax_invoice" | "bill_of_supply" | "plain_bill" | "credit_note";

export type EntitySchema = {
  name: string;
  policy: Policy;
  /** lww: fields whose concurrent edits ask a manager to confirm (price, tax class, discount limits). */
  review?: string[];
  /** rank: field -> ordered values, lowest first. */
  ranks?: Record<string, string[]>;
  /** delta: the fields that carry deltas. */
  deltas?: string[];
  /** lww: del / undel are allowed (tombstones). */
  deletable?: boolean;
  /** Entity carries a legal document number allocated from a device series (S7). Informational. */
  docType?: DocType;
  /** Money or tax: only modelled as append facts; invariants are checked by detectors, never merged. */
  guarded?: boolean;
  /** Fields declared `pii: true` in the entity file: they travel in the op's `pii`, never in the hashed body (S4, review M-10). */
  pii?: string[];
  /** mixed: the policy of each declared field. A field not declared here is ignored (invariant 8). */
  fields?: Record<string, FieldRule>;
};

/** `review` of a mixed entity is the set of its lww_review fields. */
export function reviewFields(s: EntitySchema): string[] {
  if (s.policy !== "mixed") return s.review ?? [];
  return Object.entries(s.fields ?? {})
    .filter(([, r]) => r.policy === "lww_review")
    .map(([k]) => k);
}

export class SchemaRegistry {
  private byName = new Map<string, EntitySchema>();

  constructor(schemas: EntitySchema[]) {
    for (const s of schemas) this.byName.set(s.name, s);
  }

  /** Undefined for an unknown entity: older clients ignore entities they do not know (invariant 8). */
  get(entity: string): EntitySchema | undefined {
    return this.byName.get(entity);
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

/** Demo entities of the Phase 1 proof of concept (ADR-0002, roadmap item 1e scope 4). */
export const DEMO_SCHEMAS: EntitySchema[] = [
  { name: "order", policy: "append" },
  { name: "order_line", policy: "append" },
  { name: "kds_item", policy: "rank", ranks: { status: ["new", "preparing", "ready", "served"] } },
  { name: "seating", policy: "rank", ranks: { status: ["open", "billed", "closed"] } },
  { name: "stock_level", policy: "delta", deltas: ["qty_milli"] },
  { name: "menu_item", policy: "lww", review: ["price_paise", "tax_class"], deletable: true },
  { name: "bill", policy: "append", docType: "tax_invoice", guarded: true },
  { name: "credit_note", policy: "append", docType: "credit_note", guarded: true },
  { name: "payment", policy: "append", guarded: true },
  /** Money returned for a payment: positive `amount_paise`, `bill_id`, `payment_id`. */
  { name: "refund", policy: "append", guarded: true },
  /** Cloud-origin record of a refused configuration op (intent `sync.void`); id names the target. */
  { name: "sync_void", policy: "append" },
  /** A manager's confirmation of a concurrent-edit conflict; id is the conflict id. */
  { name: "conflict_ack", policy: "append" },
  /** An offline activation of a dormant series (ADR-0002 S7); append, flagged for the owner by the cloud. */
  { name: "series_activation", policy: "append" },
];

export const demoRegistry = (): SchemaRegistry => new SchemaRegistry(DEMO_SCHEMAS);
