/**
 * Plain-text helpers for the layout engine. All text that reaches a native-text print op passes through
 * `printable`: it strips control characters (an item name must never be able to inject ESC/POS commands)
 * and folds to ASCII, because the built-in profiles print Latin through the default code page only.
 */

/** Fold to printable ASCII: rupee sign to "Rs", accents dropped, controls removed, unknown to "?". */
export function printable(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFD")) {
    const c = ch.codePointAt(0)!;
    if (c === 0x20b9) out += "Rs";
    else if (c >= 0x300 && c <= 0x36f) continue; // combining marks
    else if (c === 0x2013 || c === 0x2014) out += "-";
    else if (c === 0x2018 || c === 0x2019) out += "'";
    else if (c === 0x201c || c === 0x201d) out += '"';
    else if (c < 0x20 || c === 0x7f) out += " ";
    else if (c < 0x7f) out += ch;
    else out += "?";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** Wrap at word boundaries; a word longer than `width` is hard-split. Never returns an empty array. */
export function wrapWords(text: string, width: number): string[] {
  if (width < 1) throw new Error("wrap width must be >= 1");
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let w of words) {
    while (w.length > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

/** Left text and right text on one line of `cols`; the left is truncated, the right never is. */
export function justify(left: string, right: string, cols: number): string {
  const room = cols - right.length - 1;
  const l = left.length > room ? left.slice(0, Math.max(0, room)) : left;
  return l + " ".repeat(Math.max(1, cols - l.length - right.length)) + right;
}

export const padLeft = (s: string, w: number) => s.padStart(w);
export const padRight = (s: string, w: number) => s.padEnd(w);

/** Join parts with `sep`, starting a new line at a part boundary when the line would exceed `cols`. */
export function flow(parts: string[], sep: string, cols: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const p of parts.filter(Boolean)) {
    if (!cur) cur = p;
    else if (cur.length + sep.length + p.length <= cols) cur += sep + p;
    else {
      lines.push(cur);
      cur = p;
    }
  }
  if (cur) lines.push(cur);
  return lines.flatMap((l) => (l.length > cols ? wrapWords(l, cols) : [l]));
}
