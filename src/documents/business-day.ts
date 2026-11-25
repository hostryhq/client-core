import { uuidv5 } from "./uuid5";

/**
 * Business day rules (ADR-0014 A1.1). A trading day is keyed by (outlet, business date), never derived from a
 * document's timestamp. A document takes the open day with the latest date its device knows and keeps it for ever.
 */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** IST calendar date "YYYY-MM-DD" of a UTC instant (epoch ms). */
export function istDateOf(utcMs: number): string {
  return new Date(utcMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The date after `date` ("2026-12-31" -> "2027-01-01"). */
export function nextDate(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`bad date ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Four-digit financial year (April to March) of an IST date: "2026-11-24" -> "2627", "2027-03-31" -> "2627". */
export function financialYearOfDate(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`bad date ${date}`);
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  const two = (n: number) => String(n % 100).padStart(2, "0");
  return two(start) + two(start + 1);
}

/** Deterministic id of a business day so two devices opening the same date write the same row. */
export function businessDayId(outletId: string, businessDate: string): string {
  return uuidv5(`business_day|${outletId}|${businessDate}`);
}

export type BusinessDayState = { business_date: string; status: "open" | "closed" };

/**
 * Date a device may open: the later of the IST date now and the day after the last closed date it knows, so a new
 * day can never collide with a closed one (close at 23:00, next guest at 23:30 stays on the next date, never
 * the closed one). Returns undefined when a day is already open (a device opens a day only when it knows of none).
 */
export function dateToOpen(days: readonly BusinessDayState[], nowMs: number): string | undefined {
  if (days.some((d) => d.status === "open")) return undefined;
  const today = istDateOf(nowMs);
  const closed = days.filter((d) => d.status === "closed").map((d) => d.business_date).sort();
  const last = closed[closed.length - 1];
  const after = last ? nextDate(last) : undefined;
  return after && after > today ? after : today;
}

/**
 * Business date a new document is stamped with: the open day with the latest date known. Undefined means no day
 * is open and the caller must open one first (or, for a manual-book entry, say so).
 */
export function stampingDate(days: readonly BusinessDayState[]): string | undefined {
  const open = days.filter((d) => d.status === "open").map((d) => d.business_date).sort();
  return open[open.length - 1];
}
