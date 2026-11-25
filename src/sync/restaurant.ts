import { SchemaRegistry, type DocType, type EntitySchema, type FieldRule } from "./schema";
import { RESTAURANT_ENTITY_DEFS } from "./restaurant.generated";

/**
 * Restaurant entity schemas, generated from `api-specs/entities/restaurant/*.yaml` (scripts/gen-sync-registry.py).
 * The conflict policy of each entity, and of each field of a mixed entity, is declared in the entity file and never
 * restated by hand here (offline-first-sync invariant 5).
 */
export type EntityDef = {
  name: string;
  owner: string;
  stream: string;
  policy: "append" | "lww" | "rank" | "delta" | "mixed";
  id: { rule?: string; name?: string };
  deletable?: boolean;
  guarded?: boolean;
  /** A field of the entity carries a legal document number. */
  docNumber?: boolean;
  fields: Record<string, FieldRule & { pii?: boolean }>;
};

const DOC_OF: Record<string, DocType> = { bill: "tax_invoice", credit_note: "credit_note" };

function toSchema(d: EntityDef): EntitySchema {
  const fieldsOf = (p: string): string[] => Object.entries(d.fields).filter(([, r]) => r.policy === p).map(([k]) => k);
  const s: EntitySchema = { name: d.name, policy: d.policy };
  if (d.deletable) s.deletable = true;
  if (d.guarded) s.guarded = true;
  if (d.docNumber && DOC_OF[d.name]) s.docType = DOC_OF[d.name]!;
  const pii = Object.entries(d.fields).filter(([, r]) => r.pii).map(([k]) => k);
  if (pii.length) s.pii = pii;
  switch (d.policy) {
    case "mixed":
      s.fields = Object.fromEntries(Object.entries(d.fields).map(([k, r]) => [k, { policy: r.policy, ...(r.order ? { order: r.order } : {}) }]));
      break;
    case "lww":
      s.review = fieldsOf("lww_review");
      break;
    case "rank":
      s.ranks = Object.fromEntries(Object.entries(d.fields).filter(([, r]) => r.policy === "rank").map(([k, r]) => [k, r.order ?? []]));
      break;
    case "delta":
      s.deltas = fieldsOf("delta");
      break;
    case "append":
      break;
  }
  return s;
}

/** Protocol records that are entities of every app: refused configuration ops, conflict confirmations, series activations. */
const PROTOCOL_SCHEMAS: EntitySchema[] = [
  { name: "sync_void", policy: "append" },
  { name: "conflict_ack", policy: "append" },
  { name: "series_activation", policy: "append" },
];

export const restaurantSchemas = (): EntitySchema[] => [...RESTAURANT_ENTITY_DEFS.map(toSchema), ...PROTOCOL_SCHEMAS];

export const restaurantRegistry = (): SchemaRegistry => new SchemaRegistry(restaurantSchemas());

/** Declared field names of a restaurant entity (to check that an op builder writes only fields the contract has). */
export function restaurantFields(entity: string): string[] | undefined {
  const d = RESTAURANT_ENTITY_DEFS.find((e) => e.name === entity);
  return d ? Object.keys(d.fields) : undefined;
}

/** The id rule of an entity: client UUIDv7, or a UUIDv5 of a natural key (`name` is the template). */
export function restaurantIdRule(entity: string): EntityDef["id"] | undefined {
  return RESTAURANT_ENTITY_DEFS.find((e) => e.name === entity)?.id;
}
