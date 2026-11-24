import type { CanvasFont, TextCanvas, TextCanvasFactory } from "./raster";
import type { LayoutOp, Script } from "./types";

/**
 * Deterministic test doubles and helpers for the printing module (exported for app tests too).
 */

/**
 * Fake canvas factory: every non-space character is a fixed-width block whose pixel pattern depends on
 * the character, so different text gives different bitmaps and the same text always gives the same one.
 * Glyph advance is 0.55 em, like a typical proportional font, so wrapping behaves realistically.
 */
export class FakeTextCanvasFactory implements TextCanvasFactory {
  constructor(private readonly fonts: ReadonlySet<Script> = new Set<Script>(["ta", "ml"])) {}
  hasFont(script: Script): boolean {
    return this.fonts.has(script);
  }
  create(width: number, height: number, font: CanvasFont): TextCanvas {
    const adv = Math.round(font.sizePx * 0.55);
    const px = new Uint8Array(width * height * 4); // transparent
    return {
      measure: (t) => Array.from(t).length * adv,
      drawText: (t, x, base) => {
        let cx = x;
        for (const ch of Array.from(t)) {
          const code = ch.codePointAt(0)!;
          if (ch !== " ") {
            for (let dy = 0; dy < Math.round(font.sizePx * 0.8); dy++) {
              for (let dx = 1; dx < adv - 1; dx++) {
                const X = cx + dx;
                const Y = base - dy;
                if (X < 0 || X >= width || Y < 0 || Y >= height) continue;
                if ((code + dx * 3 + dy * 5) % 4 === 0) continue; // glyph texture
                const i = (Y * width + X) * 4;
                px[i + 3] = 255;
              }
            }
          }
          cx += adv;
        }
      },
      readRgba: () => px,
    };
  }
}

/** FNV-1a 32-bit, for compact raster fingerprints in golden dumps. */
export function fnv1a(a: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]! & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

/**
 * Readable, lossless-enough dump of ESC/POS bytes for golden files: text stays text, LF starts a new
 * line, every command is `<NAME args>`, raster blocks show size and an FNV-1a fingerprint of the pixels.
 * Unknown bytes are shown as `<hex>` so nothing is silently hidden.
 */
export function disassemble(b: Uint8Array): string {
  let out = "";
  let i = 0;
  const at = (k: number) => b[i + k] ?? 0;
  while (i < b.length) {
    const c = b[i]!;
    if (c === 0x0a) {
      out += "\n";
      i++;
    } else if (c >= 0x20 && c < 0x7f) {
      out += String.fromCharCode(c);
      i++;
    } else if (c === 0x1b && at(1) === 0x40) {
      out += "<INIT>";
      i += 2;
    } else if (c === 0x1b && at(1) === 0x4d) {
      out += `<FONT ${at(2)}>`;
      i += 3;
    } else if (c === 0x1b && at(1) === 0x74) {
      out += `<CODEPAGE ${at(2)}>`;
      i += 3;
    } else if (c === 0x1b && at(1) === 0x61) {
      out += `<ALIGN ${["L", "C", "R"][at(2)] ?? at(2)}>`;
      i += 3;
    } else if (c === 0x1b && at(1) === 0x45) {
      out += `<BOLD ${at(2)}>`;
      i += 3;
    } else if (c === 0x1b && at(1) === 0x64) {
      out += `<FEED ${at(2)}>`;
      i += 3;
    } else if (c === 0x1b && at(1) === 0x70) {
      out += `<DRAWER pin=${at(2)} ${at(3)} ${at(4)}>`;
      i += 5;
    } else if (c === 0x1d && at(1) === 0x21) {
      out += `<SIZE w${(at(2) >> 4) + 1}h${(at(2) & 15) + 1}>`;
      i += 3;
    } else if (c === 0x1d && at(1) === 0x42) {
      out += `<INVERT ${at(2)}>`;
      i += 3;
    } else if (c === 0x1d && at(1) === 0x56) {
      out += `<CUT ${at(2)}>`;
      i += 3;
    } else if (c === 0x1d && at(1) === 0x76 && at(2) === 0x30) {
      const w = at(4) + at(5) * 256;
      const h = at(6) + at(7) * 256;
      const data = b.subarray(i + 8, i + 8 + w * h);
      out += `<RASTER m=${at(3)} bytesPerRow=${w} rows=${h} fnv=${fnv1a(data)}>`;
      i += 8 + w * h;
    } else if (c === 0x1d && at(1) === 0x28 && at(2) === 0x6b) {
      const n = at(3) + at(4) * 256;
      const body = b.subarray(i + 5, i + 5 + n);
      const fn = body[1] ?? 0;
      const label = fn === 0x50 ? `STORE ${new TextDecoder().decode(body.subarray(3))}` : `fn${hex(fn)} ${Array.from(body.subarray(2)).map(hex).join(" ")}`;
      out += `<QR ${label}>`;
      i += 5 + n;
    } else {
      out += `<${hex(c)}>`;
      i++;
    }
  }
  return out;
}

/** Layout ops as plain text lines, applying alignment padding, for human-readable layout tests. */
export function toPlainText(ops: LayoutOp[], cols: number): string[] {
  const lines: string[] = [];
  for (const op of ops) {
    if (op.t === "text") {
      const w = Math.floor(cols / (op.style.w ?? 1));
      const t = op.text;
      const pad = op.style.align === "center" ? Math.floor((w - t.length) / 2) : op.style.align === "right" ? w - t.length : 0;
      lines.push(" ".repeat(Math.max(0, pad)) + t);
    } else if (op.t === "raster") {
      lines.push(`${" ".repeat(op.indentCols)}[${op.script}: ${op.text}]`);
    } else if (op.t === "qr") {
      lines.push(`[QR ${op.data}]`);
    } else if (op.t === "drawer") {
      lines.push("[DRAWER]");
    } else if (op.t === "cut") {
      lines.push("[CUT]");
    }
  }
  return lines;
}
