import type { Mutation } from "../sync";
import { restaurantFields } from "../sync/restaurant";
import { INTENT_DEFS } from "./intents.generated";

/**
 * The sync intent registry (api-specs `sync/intents/*.yaml`), generated into `intents.generated.ts`. An intent names
 * what an op means and which entities and mutation kinds it may touch. The op writer checks every op against it
 * before anything is recorded, so a builder that drifts from the contract fails in a test, not at the gateway.
 */
export type IntentDef = {
  v: number;
  class: "trading" | "config" | "control";
  owner: string | null;
  permission: string | null;
  proof: "session" | "action" | null;
  /** `proof.binds`: the overridden fields whose recorded values form `values` in the action hash (sync/protocol-v1.md). */
  binds: string[];
  override: boolean;
  /** Session types that may record the intent (`pin`, `strong`, `device`). */
  sessions: string[];
  deviceKinds: string[];
  streams: string[];
  numbering: "allocated" | "typed" | "none";
  /** Document types the op may take a number for. */
  documents: string[];
  /** Entity name to the mutation kinds the intent may use. */
  entities: Record<string, string[]>;
  /** Protocol records that are not synced entities (`session`, `approval`, `series_close`, ...): insert only. */
  records: string[];
};

export type IntentErrorCode =
  | "unknown_intent"
  | "entity_not_allowed"
  | "kind_not_allowed"
  | "unknown_field"
  | "number_not_allowed"
  | "number_missing"
  | "stream_not_configured";

export class IntentError extends Error {
  constructor(
    readonly code: IntentErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "IntentError";
  }
}

export const INTENTS: Readonly<Record<string, IntentDef>> = INTENT_DEFS;

export const intentDef = (name: string): IntentDef => {
  const d = INTENTS[name];
  if (!d) throw new IntentError("unknown_intent", name);
  return d;
};

/** Checks the mutations of an op, and the numbers it took, against its intent. Throws IntentError. */
export function validateOp(intent: string, muts: readonly Mutation[], numbers: readonly string[]): void {
  const def = intentDef(intent);
  for (const m of muts) {
    const kinds = def.entities[m.e] ?? (def.records.includes(m.e) ? ["insert"] : undefined);
    if (!kinds) throw new IntentError("entity_not_allowed", `${intent} may not touch ${m.e}`);
    if (!kinds.includes(m.k)) throw new IntentError("kind_not_allowed", `${intent} may not ${m.k} ${m.e}`);
    const known = restaurantFields(m.e);
    if (known) {
      for (const k of Object.keys(m.f ?? {})) {
        if (!known.includes(k)) throw new IntentError("unknown_field", `${m.e}.${k} is not in the entity contract`);
      }
    }
  }
  for (const t of numbers) {
    if (def.numbering !== "allocated" || !def.documents.includes(t)) throw new IntentError("number_not_allowed", `${intent} may not number a ${t}`);
  }
  if (def.numbering === "allocated" && numbers.length === 0) throw new IntentError("number_missing", `${intent} must allocate a number`);
}

/** The stream kind an intent is recorded on (an op touches one stream). */
export function streamKindOf(intent: string): string {
  const s = intentDef(intent).streams;
  if (s.length === 0) throw new IntentError("stream_not_configured", `${intent} has no stream`);
  return s[0]!;
}
