import { readFileSync } from "node:fs";
import { loadRuleSet } from "../tax";
import { MemorySeriesAllocator, sequentialIds } from "./testing";
import type { BillableLine, BillingSettings, CheckHeader, DocumentDeps, OutletBillingContext } from "./types";

/** Test fixtures (not part of the build). 2026-11-24 13:05 IST = 07:35 UTC. */
export const NOW_MS = Date.parse("2026-11-24T07:35:00Z");

export const DRAFT_RULES = loadRuleSet(JSON.parse(readFileSync(new URL("../tax/__vectors__/draft-unreviewed.v1.json", import.meta.url), "utf8")));

/** The draft rule set is effective 2027-04-01 (a placeholder); the tests use a copy in force now. */
export const RULES_IN_FORCE = { ...DRAFT_RULES, effective_date: "2026-04-01" };

export const SETTINGS: BillingSettings = {
  number_at: "settle",
  price_mode: "exclusive",
  round_off: false,
  service_charge_bp: 0,
  service_charge_dine_in: true,
  service_charge_takeaway: true,
  service_charge_counter: false,
  packing_charge_paise: 0,
  packing_tax_class: "fnb_standard",
  discount_limit_bp: 1000,
};

export function ctx(over: Partial<BillingSettings> = {}, extra: Partial<OutletBillingContext> = {}): OutletBillingContext {
  return {
    outletId: "outlet-1",
    settings: { ...SETTINGS, ...over },
    regime: "regular",
    specifiedPremises: false,
    ruleSets: [{ id: "rs-1", doc: RULES_IN_FORCE }],
    manualBookCodes: ["MB1"],
    ...extra,
  };
}

export function deps(over: Partial<DocumentDeps> = {}): DocumentDeps & { allocator: MemorySeriesAllocator } {
  return {
    allocator: new MemorySeriesAllocator(),
    newId: sequentialIds(),
    nowMs: NOW_MS,
    businessDays: [{ business_date: "2026-11-24", status: "open" }],
    ...over,
  } as DocumentDeps & { allocator: MemorySeriesAllocator };
}

export function line(id: string, over: Partial<BillableLine> = {}): BillableLine {
  return { id, item_id: `item-${id}`, name: `Item ${id}`, category_name: "Mains", qty_milli: 1000, unit_price_paise: 10000, modifier_delta_paise: 0, tax_class: "fnb_standard", ...over };
}

export const DINE_IN: CheckHeader = { id: "check-1", status: "open", order_type: "dine_in" };
