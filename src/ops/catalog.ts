import type { OrderLineDraft } from "../catalog";
import { uuidv5 } from "../documents";
import type { Row } from "../store";
import type { Mutation, RecordSpec } from "../sync";

/**
 * Intent builders for catalog and ordering actions. Master data is last-writer-wins by hybrid clock; a review field
 * (price) carries `prev`, the stamp of the value the writer saw, so a concurrent edit is kept and a manager is asked
 * (ADR-0002 S6). Rows with a natural key use a deterministic UUIDv5 id so two devices meet on one row.
 */

/** Stamp of the value showing for a field, read from a stored row's candidates (what a review field's `prev` holds). */
export function stampOfField(row: Row | undefined, field: string): string | undefined {
  const cands = (row as (Row & { _g?: Record<string, Array<{ h: string; o: string }>> }) | undefined)?._g?.[field];
  if (!cands?.length) return undefined;
  return cands.reduce((w, c) => (c.h > w.h || (c.h === w.h && c.o > w.o) ? c : w)).h;
}

export const itemOutletId = (outletId: string, itemId: string): string => uuidv5(`item_outlet|${outletId}|${itemId}`);
export const priceEntryId = (itemId: string, variantId?: string): string => uuidv5(`price_entry|${itemId}|${variantId ?? "-"}`);

/** menu.availability.set: mark an item sold out or available at an outlet. Insert on first use, set after. */
export function availabilitySpec(a: { outletId: string; itemId: string; available: boolean }): RecordSpec {
  return {
    intent: "menu.availability.set",
    build: (ctx) => {
      const id = itemOutletId(a.outletId, a.itemId);
      return ctx.get("item_outlet", id)
        ? [{ e: "item_outlet", id, k: "set", f: { available: a.available } }]
        : [{ e: "item_outlet", id, k: "insert", f: { item_id: a.itemId, available: a.available } }];
    },
  };
}

/** menu.price.set: a brand-level price. Needs an action proof and a manager's grant; recorded with `prev` so a concurrent edit is reviewed. */
export function priceSetSpec(a: { itemId: string; variantId?: string; pricePaise: number; approval?: string }): RecordSpec {
  if (!Number.isInteger(a.pricePaise) || a.pricePaise < 0) throw new RangeError("price must be whole paise, zero or more");
  return {
    intent: "menu.price.set",
    ...(a.approval ? { approval: a.approval } : {}),
    build: (ctx) => {
      const id = priceEntryId(a.itemId, a.variantId);
      const row = ctx.get("price_entry", id);
      if (!row) return [{ e: "price_entry", id, k: "insert", f: { item_id: a.itemId, ...(a.variantId ? { variant_id: a.variantId } : {}), price_paise: a.pricePaise } }];
      const prev = stampOfField(row, "price_paise");
      return [{ e: "price_entry", id, k: "set", f: { price_paise: a.pricePaise }, ...(prev ? { prev: { price_paise: prev } } : {}) }];
    },
  };
}

/**
 * order.line.add: a line placed on a check from the catalog's order-line snapshot (`Menu.orderLine`). The snapshot
 * keeps what was sold (name, price, tax class, station) whatever the menu says later.
 */
export function orderLineAddSpec(a: { orderId: string; checkId: string; draft: OrderLineDraft; lineId?: string }): RecordSpec {
  return {
    intent: "order.line.add",
    build: (ctx): Mutation[] => {
      const id = a.lineId ?? ctx.newId();
      return [{ e: "order_line", id, k: "insert", f: { order_id: a.orderId, check_id: a.checkId, ...a.draft } }];
    },
  };
}

/** order.line.edit, quantity part: a signed delta, so two waiters adding to one draft line converge on the sum. */
export function orderLineQtySpec(a: { lineId: string; deltaMilli: number }): RecordSpec {
  if (!Number.isInteger(a.deltaMilli)) throw new RangeError("quantity delta must be whole thousandths");
  return { intent: "order.line.edit", build: () => [{ e: "order_line", id: a.lineId, k: "delta", f: { qty_milli: a.deltaMilli } }] };
}
