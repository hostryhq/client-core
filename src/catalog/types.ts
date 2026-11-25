/**
 * Menu entity rows as the ordering device holds them (api-specs entities/restaurant). Only the fields the domain
 * logic reads are typed; rows may carry more (sync metadata) and unknown fields are ignored. Product-neutral:
 * bakery, stall and hotel F&B build their menus from the same shapes. Rows are snake_case like the wire.
 */

export type VegMark = "veg" | "non_veg" | "egg" | "none";
export type StationLanguage = "en" | "ta" | "ml";
export type StationOutput = "printer" | "kds" | "both";

export type Category = {
  id: string;
  name_en: string;
  name_ta?: string;
  name_ml?: string;
  default_station_code?: string;
  default_tax_class?: string;
  sort_order: number;
  status: "active" | "hidden";
};

export type Item = {
  id: string;
  category_id: string;
  name_en: string;
  name_ta?: string;
  name_ml?: string;
  kitchen_name: string;
  station_code?: string;
  veg_mark: VegMark;
  /** Tax class key (never a rate). Empty falls back to the category default. */
  tax_class: string;
  code?: string;
  status: "active" | "hidden";
  sort_order: number;
};

export type ItemVariant = { id: string; item_id: string; name: string; is_default: boolean; sort_order: number };

export type ModifierGroup = { id: string; name: string; min_select: number; max_select: number };

export type Modifier = { id: string; group_id: string; name: string; price_delta_paise: number; sort_order: number };

export type ItemModifierGroup = { item_id: string; group_id: string; sort_order: number };

/** One price per (item, variant); `variant_id` absent for an item without variants. */
export type PriceEntry = { item_id: string; variant_id?: string; price_paise: number };

/** Per-outlet overlay of an item. */
export type ItemOutlet = {
  item_id: string;
  available: boolean;
  outlet_price_paise?: number;
  station_id?: string;
  quick_item?: boolean;
  quick_sort?: number;
};

export type Station = {
  id: string;
  /** Short code, unique per outlet; DEFAULT is seeded. */
  code: string;
  name: string;
  output: StationOutput;
  printer_id?: string;
  language: StationLanguage;
  cashier_copy?: boolean;
};

export type MenuRows = {
  categories: Category[];
  items: Item[];
  variants?: ItemVariant[];
  modifierGroups?: ModifierGroup[];
  modifiers?: Modifier[];
  itemModifierGroups?: ItemModifierGroup[];
  prices: PriceEntry[];
  itemOutlets?: ItemOutlet[];
  stations?: Station[];
};

/** What the waiter picked for one line. */
export type LineSelection = {
  itemId: string;
  variantId?: string;
  qtyMilli: number;
  modifierIds?: string[];
  note?: string;
  seatNo?: number;
};

export const DEFAULT_STATION = "DEFAULT";
