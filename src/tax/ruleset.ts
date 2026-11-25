import { CALC_V, type DocKind, type OrderChannel, type Regime, type Rule } from "./types";

/**
 * Rule set loader and validator (api-specs tax/rule-set.schema.yaml). Rates are data from the vendor's published
 * rule set, never code. The loader takes an already parsed JSON document; YAML parsing stays with the caller so
 * the client does not carry a YAML dependency.
 */

export type RuleRow = {
  tax_class: string;
  regime: Regime;
  specified_premises: boolean;
  order_channel: OrderChannel;
  doc_type: DocKind;
  gst_applies: boolean;
  cgst_bp: number;
  sgst_bp: number;
  igst_bp: number;
  sac?: string;
};

export type RuleSetDoc = {
  name: string;
  effective_date: string;
  calc_v: number;
  rules: RuleRow[];
  signoff?: { reviewer_name: string; signed_on: string; reference_note: string };
};

export class RuleSetError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid rule set: ${problems.join("; ")}`);
    this.name = "RuleSetError";
  }
}

const REGIMES: readonly string[] = ["regular", "composition", "unregistered"];
const CHANNELS: readonly string[] = ["dine_in", "takeaway", "counter", "eco"];
const DOC_FOR_REGIME: Record<Regime, DocKind> = { regular: "tax_invoice", composition: "bill_of_supply", unregistered: "plain_bill" };
const CLASS_RE = /^[a-z][a-z0-9_]{1,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBp = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2800;

function validDate(s: unknown): boolean {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Returns every problem found; empty means valid. Checks the schema and the semantic rules the schema cannot say. */
export function validateRuleSet(doc: unknown): string[] {
  const p: string[] = [];
  if (!isObj(doc)) return ["rule set must be an object"];
  if (typeof doc.name !== "string" || doc.name.length === 0 || doc.name.length > 80) p.push("name must be 1 to 80 characters");
  if (!validDate(doc.effective_date)) p.push("effective_date must be a calendar date YYYY-MM-DD");
  if (typeof doc.calc_v !== "number" || !Number.isInteger(doc.calc_v) || doc.calc_v < 1) p.push("calc_v must be an integer >= 1");
  else if (doc.calc_v !== CALC_V) p.push(`calc_v ${doc.calc_v} is not supported (this client implements ${CALC_V})`);
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    p.push("rules must be a non-empty array");
    return p;
  }
  const seen = new Set<string>();
  doc.rules.forEach((raw: unknown, i) => {
    const at = `rules[${i}]`;
    if (!isObj(raw)) return void p.push(`${at} must be an object`);
    const allowed = new Set(["tax_class", "regime", "specified_premises", "order_channel", "doc_type", "gst_applies", "cgst_bp", "sgst_bp", "igst_bp", "sac"]);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) p.push(`${at}.${k} is not allowed`);
    if (typeof raw.tax_class !== "string" || !CLASS_RE.test(raw.tax_class)) p.push(`${at}.tax_class is not a valid class key`);
    if (typeof raw.regime !== "string" || !REGIMES.includes(raw.regime)) p.push(`${at}.regime`);
    if (typeof raw.specified_premises !== "boolean") p.push(`${at}.specified_premises must be boolean`);
    if (typeof raw.order_channel !== "string" || !CHANNELS.includes(raw.order_channel)) p.push(`${at}.order_channel`);
    if (typeof raw.gst_applies !== "boolean") p.push(`${at}.gst_applies must be boolean`);
    if (!isBp(raw.cgst_bp)) p.push(`${at}.cgst_bp must be an integer 0..2800`);
    if (!isBp(raw.sgst_bp)) p.push(`${at}.sgst_bp must be an integer 0..2800`);
    if (raw.igst_bp !== 0) p.push(`${at}.igst_bp must be 0 (intra-state only)`);
    if (raw.sac !== undefined && (typeof raw.sac !== "string" || !/^[0-9]{4,8}$/.test(raw.sac))) p.push(`${at}.sac must be 4 to 8 digits`);
    if (isBp(raw.cgst_bp) && isBp(raw.sgst_bp) && raw.cgst_bp !== raw.sgst_bp) p.push(`${at}: sgst_bp must equal cgst_bp`);
    if (raw.gst_applies === false && (raw.cgst_bp !== 0 || raw.sgst_bp !== 0)) p.push(`${at}: a row with gst_applies false must have zero rates`);
    if (typeof raw.regime === "string" && REGIMES.includes(raw.regime) && raw.doc_type !== DOC_FOR_REGIME[raw.regime as Regime]) {
      p.push(`${at}.doc_type must be ${DOC_FOR_REGIME[raw.regime as Regime]} for regime ${raw.regime}`);
    }
    if (raw.regime !== "regular" && raw.gst_applies === true) p.push(`${at}: regime ${String(raw.regime)} cannot charge GST`);
    const key = [raw.tax_class, raw.regime, raw.specified_premises, raw.order_channel].join("|");
    if (seen.has(key)) p.push(`${at} duplicates (${key})`);
    seen.add(key);
  });
  if (isObj(doc.signoff)) {
    const s = doc.signoff;
    if (typeof s.reviewer_name !== "string" || s.reviewer_name.length < 2) p.push("signoff.reviewer_name");
    if (!validDate(s.signed_on)) p.push("signoff.signed_on");
    if (typeof s.reference_note !== "string" || s.reference_note.length < 10) p.push("signoff.reference_note");
  } else if (doc.signoff !== undefined) p.push("signoff must be an object");
  return p;
}

/** Validates and returns a typed rule set; throws RuleSetError listing every problem. */
export function loadRuleSet(doc: unknown): RuleSetDoc {
  const problems = validateRuleSet(doc);
  if (problems.length > 0) throw new RuleSetError(problems);
  return doc as RuleSetDoc;
}

export type RuleContext = { regime: Regime; specifiedPremises: boolean; channel: OrderChannel };

export type ResolvedRules = {
  rules: Record<string, Rule>;
  docType: DocKind;
  /** Rows by class, for SAC and rate labels. */
  rows: Record<string, RuleRow>;
};

/**
 * Rows for one document: the regime, the outlet's specified-premises flag and the order channel pick one row per
 * tax class. Returns undefined when the rule set has no row for the context (caller must not guess a rate).
 */
export function resolveRules(set: RuleSetDoc, ctx: RuleContext): ResolvedRules | undefined {
  const rows = set.rules.filter(
    (r) => r.regime === ctx.regime && r.specified_premises === ctx.specifiedPremises && r.order_channel === ctx.channel,
  );
  if (rows.length === 0) return undefined;
  const rules: Record<string, Rule> = {};
  const byClass: Record<string, RuleRow> = {};
  for (const r of rows) {
    rules[r.tax_class] = { gst: r.gst_applies, cgst_bp: r.cgst_bp, sgst_bp: r.sgst_bp };
    byClass[r.tax_class] = r;
  }
  return { rules, docType: rows[0]!.doc_type, rows: byClass };
}

/** The set in force on an IST invoice date: the latest effective_date not after it. */
export function ruleSetInForce<T extends { effective_date: string }>(sets: readonly T[], invoiceDate: string): T | undefined {
  let best: T | undefined;
  for (const s of sets) {
    if (s.effective_date <= invoiceDate && (!best || s.effective_date > best.effective_date)) best = s;
  }
  return best;
}
