import type { KotDoc, KotLine, LocalName } from "../printing";
import { DEFAULT_STATION, type Station } from "./types";

/** The order_line fields station routing and the kitchen ticket need. */
export type SendableLine = {
  id: string;
  item_id: string;
  variant_id?: string;
  /** Item name, with " (Variant)" appended when variant_id is set (Menu.buildOrderLine). */
  name: string;
  kitchen_name: string;
  qty_milli: number;
  modifiers_text?: string;
  note?: string;
  station_code: string;
  state: "draft" | "sent";
};

export type StationTicket = { station: Station; lines: SendableLine[] };

/** Lines the next KOT carries: draft, with quantity. Order is kept. */
export function linesToSend<T extends SendableLine>(lines: readonly T[]): T[] {
  return lines.filter((l) => l.state === "draft" && l.qty_milli > 0);
}

/**
 * Splits the lines to send into one ticket per station (one KOT per station per send). A line whose station is
 * not an outlet station goes to DEFAULT; if the outlet has no DEFAULT row a synthetic printer-less one is used,
 * so the ticket exists and shows on the KDS or the fallback list instead of being lost. Tickets are ordered by
 * station code so reprints and tests are stable.
 */
export function routeToStations(lines: readonly SendableLine[], stations: readonly Station[]): StationTicket[] {
  const byCode = new Map(stations.map((s) => [s.code, s]));
  const fallback: Station = byCode.get(DEFAULT_STATION) ?? { id: "", code: DEFAULT_STATION, name: "Kitchen", output: "both", language: "en" };
  const groups = new Map<string, StationTicket>();
  for (const l of lines) {
    const station = byCode.get(l.station_code) ?? fallback;
    const t = groups.get(station.code) ?? { station, lines: [] };
    t.lines.push(l);
    groups.set(station.code, t);
  }
  return [...groups.values()].sort((a, b) => (a.station.code < b.station.code ? -1 : a.station.code > b.station.code ? 1 : 0));
}

/** KOT display number: device prefix plus the per-business-date counter ("A07-012"); at most 12 characters. */
export function formatKotNo(devicePrefix: string, counter: number): string {
  if (!Number.isInteger(counter) || counter < 1) throw new Error("kot counter must be a positive integer");
  const n = `${devicePrefix}-${String(counter).padStart(3, "0")}`;
  if (n.length > 12) throw new Error(`kot number ${n} longer than 12 characters`);
  return n;
}

export type KotBuildContext = {
  kotNumber: string;
  /** "T6" or "TAKEAWAY #27". */
  tableLabel: string;
  orderTypeLabel?: string;
  waiter?: string;
  billLabel?: string;
  createdAt: string;
  note?: string;
  /** Local-script name of an item for a station that prints Tamil or Malayalam. */
  localName?: (itemId: string, lang: "ta" | "ml") => string | undefined;
};

function variantText(l: SendableLine): string | undefined {
  if (!l.variant_id) return undefined;
  const m = /\s\(([^()]*)\)$/.exec(l.name);
  return m?.[1];
}

/** Maps one station ticket to the printing model. A KOT has no prices and no guest details by construction. */
export function toKotDoc(ticket: StationTicket, ctx: KotBuildContext): KotDoc {
  const lang = ticket.station.language;
  const script = lang === "en" ? undefined : lang;
  const lines: KotLine[] = ticket.lines.map((l) => {
    const local = script ? ctx.localName?.(l.item_id, script) : undefined;
    const name: LocalName = local && script ? { en: l.kitchen_name, local, script } : { en: l.kitchen_name };
    const out: KotLine = { qty: l.qty_milli / 1000, name };
    const v = variantText(l);
    if (v) out.variant = v;
    const mods = [l.modifiers_text, l.note].filter((x): x is string => !!x);
    if (mods.length > 0) out.modifiers = mods;
    return out;
  });
  const doc: KotDoc = {
    kind: "kot",
    variant: "original",
    station: ticket.station.name,
    tableLabel: ctx.tableLabel,
    kotNumber: ctx.kotNumber,
    createdAt: ctx.createdAt,
    lines,
  };
  if (script) doc.stationScript = script;
  if (ctx.orderTypeLabel) doc.orderType = ctx.orderTypeLabel;
  if (ctx.waiter) doc.waiter = ctx.waiter;
  if (ctx.billLabel) doc.billLabel = ctx.billLabel;
  if (ctx.note) doc.note = ctx.note;
  return doc;
}
