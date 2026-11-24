import type { Paise } from "./types";

/** Indian digit grouping (1,00,000) with Western digits. */
function group(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  let rest = intPart.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

/** Integer paise to "1,234.50". Never uses floats. `sign` forces "+" on positives (round-off lines). */
export function formatPaise(p: Paise, opts: { sign?: boolean; grouping?: boolean } = {}): string {
  if (!Number.isSafeInteger(p)) throw new Error(`money must be integer paise, got ${p}`);
  const neg = p < 0;
  const abs = Math.abs(p);
  const rupees = String(Math.floor(abs / 100));
  const paise = String(abs % 100).padStart(2, "0");
  const body = `${opts.grouping === false ? rupees : group(rupees)}.${paise}`;
  return neg ? `-${body}` : opts.sign && abs > 0 ? `+${body}` : body;
}

/** Quantity with up to 3 decimals, trailing zeros trimmed ("3", "0.5", "1.25"). */
export function formatQty(q: number): string {
  if (!Number.isFinite(q)) throw new Error(`bad quantity ${q}`);
  return String(Math.round(q * 1000) / 1000);
}

const IST_OFFSET_MS = 330 * 60_000;
const p2 = (n: number) => String(n).padStart(2, "0");

function istParts(iso: string) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`bad timestamp ${iso}`);
  const d = new Date(t + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** UTC instant to IST "24-11-2026". */
export function istDate(iso: string): string {
  const x = istParts(iso);
  return `${p2(x.d)}-${p2(x.mo)}-${x.y}`;
}
/** UTC instant to IST "13:05". */
export function istTime(iso: string): string {
  const x = istParts(iso);
  return `${p2(x.h)}:${p2(x.mi)}`;
}
/** UTC instant to IST "24-11-2026 13:05". */
export function istDateTime(iso: string): string {
  return `${istDate(iso)} ${istTime(iso)}`;
}
/** Business date "2026-11-24" to "24-11-2026" (already a date: no timezone maths). */
export function businessDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`bad business date ${d}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}
