import type { Align, Script } from "./types";

/**
 * Raster path for Tamil and Malayalam (printers have no such fonts): text is drawn to a canvas, thresholded
 * to a 1-bit bitmap at the paper's dot width, and sent as GS v 0.
 *
 * FONT LICENSING (open question for the founder / CA): the app must bundle a Tamil and a Malayalam font.
 * Noto Sans Tamil and Noto Sans Malayalam are published under the SIL Open Font License 1.1, which allows
 * bundling and embedding in an app if the licence text ships with the app and the fonts are not sold alone.
 * This module bundles no font; the app loads the font (FontFace) and tells the factory when it is ready.
 * Confirm the exact font files and licence text before the first release.
 */

/** 1-bit image. Row-major, ceil(widthDots/8) bytes per row, MSB first, bit 1 = black. */
export type Bitmap1bit = { widthDots: number; heightDots: number; data: Uint8Array };

export type RasterRequest = {
  text: string;
  script: Script;
  /** Full paper width in dots; the bitmap is always exactly this wide. */
  widthDots: number;
  indentDots: number;
  /** 1 = normal, 2 = double height (and width), 3 = triple. */
  scale: 1 | 2 | 3;
  bold: boolean;
  align: Align;
};

export interface TextRasterizer {
  /** True only when the font for this script is loaded and usable. */
  hasFont(script: Script): boolean;
  render(req: RasterRequest): Bitmap1bit;
}

export type CanvasFont = { script: Script; sizePx: number; bold: boolean };

/** The minimal drawing surface the rasterizer needs. A browser one wraps OffscreenCanvas; tests use a fake. */
export interface TextCanvas {
  measure(text: string): number;
  /** Draw black text with its baseline at `baselineY`. */
  drawText(text: string, x: number, baselineY: number): void;
  /** RGBA pixels, width*height*4. Transparent or white background, black ink. */
  readRgba(): ArrayLike<number>;
}

export interface TextCanvasFactory {
  hasFont(script: Script): boolean;
  create(widthPx: number, heightPx: number, font: CanvasFont): TextCanvas;
}

/** Base font size in px at scale 1. Indic scripts need more height than Latin at the same dot pitch. */
export const BASE_FONT_PX = 26;
const LINE_FACTOR = 1.4;
const ASCENT_FACTOR = 1.05;

function wrapMeasured(text: string, maxPx: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const tryLine = cur ? `${cur} ${w}` : w;
    if (measure(tryLine) <= maxPx) {
      cur = tryLine;
      continue;
    }
    if (cur) out.push(cur);
    // A single word wider than the paper is split by characters (Array.from keeps code points whole).
    let chunk = "";
    for (const ch of Array.from(w)) {
      if (chunk && measure(chunk + ch) > maxPx) {
        out.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    cur = chunk;
  }
  if (cur || out.length === 0) out.push(cur);
  return out;
}

export class CanvasTextRasterizer implements TextRasterizer {
  constructor(private readonly factory: TextCanvasFactory) {}

  hasFont(script: Script): boolean {
    return this.factory.hasFont(script);
  }

  render(req: RasterRequest): Bitmap1bit {
    if (!this.factory.hasFont(req.script)) throw new Error(`no font loaded for ${req.script}`);
    const sizePx = BASE_FONT_PX * req.scale;
    const lineH = Math.round(sizePx * LINE_FACTOR);
    const font: CanvasFont = { script: req.script, sizePx, bold: req.bold };
    const maxPx = Math.max(8, req.widthDots - req.indentDots);

    const probe = this.factory.create(req.widthDots, lineH, font);
    const lines = wrapMeasured(req.text, maxPx, (s) => probe.measure(s));
    const height = lineH * lines.length;
    const canvas = this.factory.create(req.widthDots, height, font);
    lines.forEach((line, i) => {
      const w = canvas.measure(line);
      const x = req.align === "center" ? Math.max(0, Math.round((req.widthDots - w) / 2)) : req.align === "right" ? Math.max(0, req.widthDots - w) : req.indentDots;
      canvas.drawText(line, x, i * lineH + Math.round(sizePx * ASCENT_FACTOR));
    });
    return toBitmap(canvas.readRgba(), req.widthDots, height);
  }
}

/** Threshold RGBA to 1 bit: ink is opaque and dark. */
export function toBitmap(rgba: ArrayLike<number>, w: number, h: number): Bitmap1bit {
  const rowBytes = Math.ceil(w / 8);
  const data = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] ?? 0;
      const lum = ((rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0)) / 3;
      if (a >= 128 && lum < 160) data[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { widthDots: w, heightDots: h, data };
}

/** Small LRU in front of a rasterizer: receipts repeat the same dish names all day. */
export class CachingRasterizer implements TextRasterizer {
  private readonly cache = new Map<string, Bitmap1bit>();
  constructor(
    private readonly inner: TextRasterizer,
    private readonly maxEntries = 256,
  ) {}
  hasFont(script: Script): boolean {
    return this.inner.hasFont(script);
  }
  render(req: RasterRequest): Bitmap1bit {
    const key = JSON.stringify([req.script, req.text, req.widthDots, req.indentDots, req.scale, req.bold, req.align]);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const bmp = this.inner.render(req);
    this.cache.set(key, bmp);
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
    return bmp;
  }
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Browser/webview factory over OffscreenCanvas. `families` maps a script to the CSS font family the app
 * loaded; `fontReady` says whether that font has finished loading (for example `document.fonts.check`
 * against a FontFace the app added). Not unit-tested here (needs a real canvas); the Tauri shell run covers it.
 */
export class OffscreenTextCanvasFactory implements TextCanvasFactory {
  constructor(
    private readonly families: Partial<Record<Script, string>>,
    private readonly fontReady: (script: Script) => boolean,
  ) {}
  hasFont(script: Script): boolean {
    return this.families[script] !== undefined && this.fontReady(script);
  }
  create(widthPx: number, heightPx: number, font: CanvasFont): TextCanvas {
    const canvas = new OffscreenCanvas(widthPx, Math.max(1, heightPx));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    const family = this.families[font.script];
    ctx.font = `${font.bold ? "bold " : ""}${font.sizePx}px "${family}"`;
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    return {
      measure: (t) => ctx.measureText(t).width,
      drawText: (t, x, y) => ctx.fillText(t, x, y),
      readRgba: () => ctx.getImageData(0, 0, widthPx, Math.max(1, heightPx)).data,
    };
  }
}
