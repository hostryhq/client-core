import {
  DEFAULT_STATION,
  type Category,
  type Item,
  type ItemOutlet,
  type ItemVariant,
  type LineSelection,
  type MenuRows,
  type Modifier,
  type ModifierGroup,
  type Station,
} from "./types";

export type CatalogErrorCode =
  | "unknown_item"
  | "item_unavailable"
  | "unknown_variant"
  | "variant_required"
  | "no_price"
  | "unknown_modifier"
  | "modifier_not_offered"
  | "modifier_min"
  | "modifier_max"
  | "invalid_qty"
  | "note_too_long"
  | "no_tax_class";

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CatalogError";
  }
}

/** The order_line fields the ordering device snapshots at add time (RM-M6); ids and check placement are the caller's. */
export type OrderLineDraft = {
  item_id: string;
  variant_id?: string;
  /** Item name, with " (Variant)" appended when the item has variants. */
  name: string;
  kitchen_name: string;
  category_id: string;
  category_name: string;
  qty_milli: number;
  unit_price_paise: number;
  modifier_delta_paise: number;
  modifiers_text?: string;
  note?: string;
  seat_no?: number;
  tax_class: string;
  station_code: string;
  state: "draft";
};

const byOrder = <T extends { sort_order: number }>(a: T, b: T): number => a.sort_order - b.sort_order;

/** Tax class of an item: its own, else its category's default. Never a rate; the rule set maps it. */
export function resolveTaxClass(item: Pick<Item, "tax_class">, category?: Pick<Category, "default_tax_class">): string {
  const c = item.tax_class || category?.default_tax_class;
  if (!c) throw new CatalogError("no_tax_class");
  return c;
}

/** Read model over the local menu rows. Hidden/unavailable filtering and price/station/tax resolution live here. */
export class Menu {
  private readonly cats = new Map<string, Category>();
  private readonly items = new Map<string, Item>();
  private readonly variants = new Map<string, ItemVariant[]>();
  private readonly groups = new Map<string, ModifierGroup>();
  private readonly mods = new Map<string, Modifier[]>();
  private readonly modById = new Map<string, Modifier>();
  private readonly itemGroups = new Map<string, string[]>();
  private readonly prices = new Map<string, number>();
  private readonly outlet = new Map<string, ItemOutlet>();
  private readonly stationsByCode = new Map<string, Station>();
  private readonly stationsById = new Map<string, Station>();

  constructor(rows: MenuRows) {
    for (const c of rows.categories) this.cats.set(c.id, c);
    for (const i of rows.items) this.items.set(i.id, i);
    for (const v of rows.variants ?? []) this.variants.set(v.item_id, [...(this.variants.get(v.item_id) ?? []), v]);
    for (const v of this.variants.values()) v.sort(byOrder);
    for (const g of rows.modifierGroups ?? []) this.groups.set(g.id, g);
    for (const m of rows.modifiers ?? []) {
      this.mods.set(m.group_id, [...(this.mods.get(m.group_id) ?? []), m]);
      this.modById.set(m.id, m);
    }
    for (const l of this.mods.values()) l.sort(byOrder);
    const links = [...(rows.itemModifierGroups ?? [])].sort(byOrder);
    for (const l of links) this.itemGroups.set(l.item_id, [...(this.itemGroups.get(l.item_id) ?? []), l.group_id]);
    for (const p of rows.prices) this.prices.set(`${p.item_id}|${p.variant_id ?? "-"}`, p.price_paise);
    for (const o of rows.itemOutlets ?? []) this.outlet.set(o.item_id, o);
    for (const s of rows.stations ?? []) {
      this.stationsByCode.set(s.code, s);
      this.stationsById.set(s.id, s);
    }
  }

  item(id: string): Item {
    const i = this.items.get(id);
    if (!i) throw new CatalogError("unknown_item", id);
    return i;
  }

  category(id: string): Category | undefined {
    return this.cats.get(id);
  }

  /** Sellable here and now: item and category active, not marked sold out at this outlet. */
  isSellable(itemId: string): boolean {
    const i = this.items.get(itemId);
    if (!i || i.status !== "active") return false;
    const c = this.cats.get(i.category_id);
    if (c && c.status !== "active") return false;
    return this.outlet.get(itemId)?.available !== false;
  }

  /** Items of a category in display order, sellable only. */
  itemsIn(categoryId: string): Item[] {
    return [...this.items.values()].filter((i) => i.category_id === categoryId && this.isSellable(i.id)).sort(byOrder);
  }

  /** Quick items (up to 12) in quick order, sellable only. */
  quickItems(): Item[] {
    return [...this.outlet.values()]
      .filter((o) => o.quick_item && this.isSellable(o.item_id))
      .sort((a, b) => (a.quick_sort ?? 0) - (b.quick_sort ?? 0))
      .slice(0, 12)
      .map((o) => this.items.get(o.item_id)!);
  }

  variantsOf(itemId: string): ItemVariant[] {
    return this.variants.get(itemId) ?? [];
  }

  /** The variant to preselect: the one marked default, else the first. */
  defaultVariant(itemId: string): ItemVariant | undefined {
    const vs = this.variantsOf(itemId);
    return vs.find((v) => v.is_default) ?? vs[0];
  }

  modifierGroupsOf(itemId: string): Array<{ group: ModifierGroup; options: Modifier[] }> {
    return (this.itemGroups.get(itemId) ?? [])
      .map((gid) => this.groups.get(gid))
      .filter((g): g is ModifierGroup => g !== undefined)
      .map((group) => ({ group, options: this.mods.get(group.id) ?? [] }));
  }

  /**
   * Unit price in paise (before modifiers). An item with variants is priced per variant. The outlet override
   * (`item_outlet.outlet_price_paise`) applies to an item without variants only: the row carries one price and
   * the entity does not say which variant it overrides (open point, reported to the orchestrator).
   */
  unitPrice(itemId: string, variantId?: string): number {
    const vs = this.variantsOf(itemId);
    if (vs.length > 0) {
      if (!variantId) throw new CatalogError("variant_required", itemId);
      if (!vs.some((v) => v.id === variantId)) throw new CatalogError("unknown_variant", variantId);
    } else if (variantId) throw new CatalogError("unknown_variant", variantId);
    const override = vs.length === 0 ? this.outlet.get(itemId)?.outlet_price_paise : undefined;
    const p = override ?? this.prices.get(`${itemId}|${variantId ?? "-"}`);
    if (p === undefined) throw new CatalogError("no_price", `${itemId}${variantId ? `/${variantId}` : ""}`);
    return p;
  }

  taxClassOf(itemId: string): string {
    const i = this.item(itemId);
    return resolveTaxClass(i, this.cats.get(i.category_id));
  }

  station(code: string): Station | undefined {
    return this.stationsByCode.get(code);
  }

  /**
   * Station for the kitchen ticket: the outlet override, then the item's code, then the category default, then
   * DEFAULT. A code with no station row at this outlet also falls to DEFAULT so a ticket is never lost.
   */
  stationCodeOf(itemId: string): string {
    const i = this.item(itemId);
    const overrideId = this.outlet.get(itemId)?.station_id;
    const candidates = [
      overrideId ? this.stationsById.get(overrideId)?.code : undefined,
      i.station_code,
      this.cats.get(i.category_id)?.default_station_code,
    ];
    for (const c of candidates) if (c && this.stationsByCode.has(c)) return c;
    return DEFAULT_STATION;
  }

  /**
   * Validates a selection and builds the order line snapshot: price, modifier delta (signed, per unit), names
   * and routing are frozen at this moment, so a later menu edit never changes an open check.
   */
  buildOrderLine(sel: LineSelection): OrderLineDraft {
    if (!Number.isSafeInteger(sel.qtyMilli) || sel.qtyMilli < 1) throw new CatalogError("invalid_qty", String(sel.qtyMilli));
    if (sel.note !== undefined && sel.note.length > 100) throw new CatalogError("note_too_long");
    const item = this.item(sel.itemId);
    if (!this.isSellable(item.id)) throw new CatalogError("item_unavailable", item.id);
    const base = this.unitPrice(item.id, sel.variantId);
    const variant = sel.variantId ? this.variantsOf(item.id).find((v) => v.id === sel.variantId) : undefined;

    const picked = new Set(sel.modifierIds ?? []);
    const offered = this.modifierGroupsOf(item.id);
    const offeredIds = new Set(offered.flatMap((g) => g.options.map((o) => o.id)));
    for (const id of picked) {
      if (!this.modById.has(id)) throw new CatalogError("unknown_modifier", id);
      if (!offeredIds.has(id)) throw new CatalogError("modifier_not_offered", id);
    }
    for (const { group, options } of offered) {
      const n = options.filter((o) => picked.has(o.id)).length;
      if (n < group.min_select) throw new CatalogError("modifier_min", group.name);
      if (n > group.max_select) throw new CatalogError("modifier_max", group.name);
    }
    const chosen = offered.flatMap((g) => g.options).filter((o) => picked.has(o.id));
    const delta = chosen.reduce((s, m) => s + m.price_delta_paise, 0);

    const cat = this.cats.get(item.category_id);
    const text = chosen.map((m) => m.name).join(", ");
    const line: OrderLineDraft = {
      item_id: item.id,
      name: variant ? `${item.name_en} (${variant.name})` : item.name_en,
      kitchen_name: item.kitchen_name,
      category_id: item.category_id,
      category_name: cat?.name_en ?? "",
      qty_milli: sel.qtyMilli,
      unit_price_paise: base,
      modifier_delta_paise: delta,
      tax_class: resolveTaxClass(item, cat),
      station_code: this.stationCodeOf(item.id),
      state: "draft",
    };
    if (variant) line.variant_id = variant.id;
    if (text) line.modifiers_text = text.slice(0, 200);
    if (sel.note) line.note = sel.note;
    if (sel.seatNo !== undefined) line.seat_no = sel.seatNo;
    return line;
  }

  /** Name in a station's language when the item has one, else undefined (the ticket prints English). */
  localName(itemId: string, lang: "ta" | "ml"): string | undefined {
    const i = this.items.get(itemId);
    return (lang === "ta" ? i?.name_ta : i?.name_ml) || undefined;
  }
}
