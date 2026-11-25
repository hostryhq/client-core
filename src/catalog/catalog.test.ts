import { describe, expect, it } from "vitest";
import { CatalogError, Menu, resolveTaxClass } from "./menu";
import { formatKotNo, linesToSend, routeToStations, toKotDoc, type SendableLine } from "./kot";
import type { MenuRows } from "./types";

const rows: MenuRows = {
  categories: [
    { id: "c-main", name_en: "Mains", default_station_code: "KITCHEN", default_tax_class: "fnb_standard", sort_order: 1, status: "active" },
    { id: "c-bar", name_en: "Bar", default_station_code: "BAR", default_tax_class: "fnb_non_gst", sort_order: 2, status: "active" },
    { id: "c-old", name_en: "Old", sort_order: 3, status: "hidden" },
  ],
  items: [
    { id: "dosa", category_id: "c-main", name_en: "Masala Dosa", name_ta: "மசாலா தோசை", kitchen_name: "M Dosa", veg_mark: "veg", tax_class: "fnb_standard", status: "active", sort_order: 1 },
    { id: "biryani", category_id: "c-main", name_en: "Chicken Biryani", kitchen_name: "Chk Biryani", veg_mark: "non_veg", tax_class: "", status: "active", sort_order: 2 },
    { id: "beer", category_id: "c-bar", name_en: "Beer", kitchen_name: "Beer", veg_mark: "none", tax_class: "fnb_non_gst", status: "active", sort_order: 1 },
    { id: "ghost", category_id: "c-old", name_en: "Ghost", kitchen_name: "Ghost", veg_mark: "none", tax_class: "fnb_standard", status: "active", sort_order: 1 },
    { id: "soldout", category_id: "c-main", name_en: "Sold out", kitchen_name: "SO", veg_mark: "none", tax_class: "fnb_standard", status: "active", sort_order: 9 },
  ],
  variants: [
    { id: "v-half", item_id: "biryani", name: "Half", is_default: false, sort_order: 1 },
    { id: "v-full", item_id: "biryani", name: "Full", is_default: true, sort_order: 2 },
  ],
  modifierGroups: [
    { id: "g-spice", name: "Spice", min_select: 1, max_select: 1 },
    { id: "g-extra", name: "Extras", min_select: 0, max_select: 2 },
  ],
  modifiers: [
    { id: "m-mild", group_id: "g-spice", name: "Mild", price_delta_paise: 0, sort_order: 1 },
    { id: "m-hot", group_id: "g-spice", name: "Hot", price_delta_paise: 0, sort_order: 2 },
    { id: "m-egg", group_id: "g-extra", name: "Egg", price_delta_paise: 1500, sort_order: 1 },
    { id: "m-raita", group_id: "g-extra", name: "Raita", price_delta_paise: 2000, sort_order: 2 },
    { id: "m-less", group_id: "g-extra", name: "Less rice", price_delta_paise: -500, sort_order: 3 },
  ],
  itemModifierGroups: [
    { item_id: "biryani", group_id: "g-spice", sort_order: 1 },
    { item_id: "biryani", group_id: "g-extra", sort_order: 2 },
  ],
  prices: [
    { item_id: "dosa", price_paise: 8000 },
    { item_id: "biryani", variant_id: "v-half", price_paise: 15000 },
    { item_id: "biryani", variant_id: "v-full", price_paise: 28000 },
    { item_id: "beer", price_paise: 25000 },
    { item_id: "soldout", price_paise: 100 },
  ],
  itemOutlets: [
    { item_id: "soldout", available: false },
    { item_id: "dosa", available: true, outlet_price_paise: 8500, quick_item: true, quick_sort: 1 },
    { item_id: "beer", available: true, station_id: "st-bar2" },
  ],
  stations: [
    { id: "st-def", code: "DEFAULT", name: "Kitchen", output: "both", language: "en" },
    { id: "st-kit", code: "KITCHEN", name: "Main kitchen", output: "printer", language: "ta", printer_id: "p1" },
    { id: "st-bar", code: "BAR", name: "Bar", output: "printer", language: "en" },
    { id: "st-bar2", code: "BAR2", name: "Bar 2", output: "kds", language: "en" },
  ],
};
const menu = new Menu(rows);

describe("menu model", () => {
  it("lists sellable items only: hidden category and sold-out items are not offered", () => {
    expect(menu.itemsIn("c-main").map((i) => i.id)).toEqual(["dosa", "biryani"]);
    expect(menu.itemsIn("c-old")).toEqual([]);
    expect(menu.quickItems().map((i) => i.id)).toEqual(["dosa"]);
    expect(() => menu.buildOrderLine({ itemId: "soldout", qtyMilli: 1000 })).toThrow(/item_unavailable/);
  });

  it("prices per variant, preselects the default variant, and applies an outlet price only to an item without variants", () => {
    expect(menu.defaultVariant("biryani")?.id).toBe("v-full");
    expect(menu.unitPrice("biryani", "v-half")).toBe(15000);
    expect(menu.unitPrice("dosa")).toBe(8500); // outlet override
    expect(menu.unitPrice("beer")).toBe(25000);
    expect(() => menu.unitPrice("biryani")).toThrow(/variant_required/);
    expect(() => menu.unitPrice("dosa", "v-half")).toThrow(/unknown_variant/);
    expect(() => new Menu({ ...rows, prices: [] }).unitPrice("beer")).toThrow(/no_price/);
  });

  it("resolves the tax class: the item's own, else the category default; never a rate", () => {
    expect(menu.taxClassOf("dosa")).toBe("fnb_standard");
    expect(menu.taxClassOf("biryani")).toBe("fnb_standard"); // from the category
    expect(menu.taxClassOf("beer")).toBe("fnb_non_gst");
    expect(() => resolveTaxClass({ tax_class: "" }, {})).toThrow(/no_tax_class/);
  });
});

describe("order line snapshot", () => {
  it("freezes price, signed modifier delta, names and station", () => {
    const l = menu.buildOrderLine({ itemId: "biryani", variantId: "v-half", qtyMilli: 2000, modifierIds: ["m-hot", "m-egg", "m-less"], note: "no onion", seatNo: 2 });
    expect(l).toEqual({
      item_id: "biryani",
      variant_id: "v-half",
      name: "Chicken Biryani (Half)",
      kitchen_name: "Chk Biryani",
      category_id: "c-main",
      category_name: "Mains",
      qty_milli: 2000,
      unit_price_paise: 15000,
      modifier_delta_paise: 1000,
      modifiers_text: "Hot, Egg, Less rice",
      note: "no onion",
      seat_no: 2,
      tax_class: "fnb_standard",
      station_code: "KITCHEN",
      state: "draft",
    });
  });

  it("enforces modifier group bounds and that a modifier is offered on the item", () => {
    const sel = { itemId: "biryani", variantId: "v-full", qtyMilli: 1000 };
    expect(() => menu.buildOrderLine({ ...sel })).toThrow(/modifier_min/); // spice is required
    expect(() => menu.buildOrderLine({ ...sel, modifierIds: ["m-mild", "m-hot"] })).toThrow(/modifier_max/);
    expect(() => menu.buildOrderLine({ ...sel, modifierIds: ["m-mild", "m-egg", "m-raita", "m-less"] })).toThrow(/modifier_max/);
    expect(() => menu.buildOrderLine({ ...sel, modifierIds: ["zzz"] })).toThrow(/unknown_modifier/);
    expect(() => menu.buildOrderLine({ itemId: "dosa", qtyMilli: 1000, modifierIds: ["m-egg"] })).toThrow(/modifier_not_offered/);
  });

  it("refuses bad quantity and long notes", () => {
    expect(() => menu.buildOrderLine({ itemId: "dosa", qtyMilli: 0 })).toThrow(CatalogError);
    expect(() => menu.buildOrderLine({ itemId: "dosa", qtyMilli: 1.5 })).toThrow(/invalid_qty/);
    expect(() => menu.buildOrderLine({ itemId: "dosa", qtyMilli: 1000, note: "x".repeat(101) })).toThrow(/note_too_long/);
  });
});

describe("station routing and KOT", () => {
  it("routes by outlet override, then item, then category, then DEFAULT; an unknown station falls to DEFAULT", () => {
    expect(menu.stationCodeOf("beer")).toBe("BAR2"); // outlet override beats the category's BAR
    expect(menu.stationCodeOf("dosa")).toBe("KITCHEN");
    const m2 = new Menu({ ...rows, items: [{ ...rows.items[0]!, station_code: "GONE" }], categories: [{ ...rows.categories[0]!, default_station_code: undefined }], itemOutlets: [] });
    expect(m2.stationCodeOf("dosa")).toBe("DEFAULT");
  });

  const mk = (id: string, item: string, station: string, over: Partial<SendableLine> = {}): SendableLine => ({ id, item_id: item, name: item, kitchen_name: item, qty_milli: 1000, station_code: station, state: "draft", ...over });

  it("sends only draft lines with quantity, one ticket per station in stable order, unknown station to DEFAULT", () => {
    const ls = [mk("1", "dosa", "KITCHEN"), mk("2", "beer", "BAR"), mk("3", "x", "KITCHEN"), mk("4", "sent", "KITCHEN", { state: "sent" }), mk("5", "zero", "BAR", { qty_milli: 0 }), mk("6", "y", "NOPE")];
    const tickets = routeToStations(linesToSend(ls), rows.stations!);
    expect(tickets.map((t) => [t.station.code, t.lines.map((l) => l.id)])).toEqual([["BAR", ["2"]], ["DEFAULT", ["6"]], ["KITCHEN", ["1", "3"]]]);
    expect(routeToStations([mk("1", "a", "NOPE")], []).map((t) => t.station.code)).toEqual(["DEFAULT"]); // outlet without a DEFAULT row
  });

  it("builds a KOT with no prices, the station's script when the item has a name in it, variant and modifiers", () => {
    const built = menu.buildOrderLine({ itemId: "biryani", variantId: "v-half", qtyMilli: 2000, modifierIds: ["m-hot"], note: "no onion" });
    const dosa = menu.buildOrderLine({ itemId: "dosa", qtyMilli: 1000 });
    const lines: SendableLine[] = [{ id: "L1", ...built }, { id: "L2", ...dosa }];
    const [ticket] = routeToStations(lines, rows.stations!);
    const doc = toKotDoc(ticket!, { kotNumber: formatKotNo("A07", 12), tableLabel: "T6", orderTypeLabel: "Dine-in", createdAt: "2026-11-24T07:35:00Z", localName: (id, lang) => menu.localName(id, lang) });
    expect(doc).toMatchObject({ kind: "kot", variant: "original", station: "Main kitchen", stationScript: "ta", kotNumber: "A07-012", tableLabel: "T6" });
    expect(doc.lines).toEqual([
      { qty: 2, name: { en: "Chk Biryani" }, variant: "Half", modifiers: ["Hot", "no onion"] },
      { qty: 1, name: { en: "M Dosa", local: "மசாலா தோசை", script: "ta" } },
    ]);
    expect(JSON.stringify(doc)).not.toMatch(/price|rate|amount|customer/i);
  });

  it("KOT numbers fit 12 characters", () => {
    expect(formatKotNo("A07", 7)).toBe("A07-007");
    expect(() => formatKotNo("ABCDEFGHIJ", 1)).toThrow();
    expect(() => formatKotNo("A", 0)).toThrow();
  });
});
