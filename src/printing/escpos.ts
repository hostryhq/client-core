import type { Bitmap1bit, TextRasterizer } from "./raster";
import type { LayoutOp, PrinterProfile, TextStyle } from "./types";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Growable byte buffer. */
class Bytes {
  private buf: number[] = [];
  push(...b: number[]): void {
    for (const x of b) this.buf.push(x & 0xff);
  }
  pushArr(a: ArrayLike<number>): void {
    for (let i = 0; i < a.length; i++) this.buf.push(a[i]! & 0xff);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** ESC @ then font A and the profile's code page. */
export function initBytes(p: PrinterProfile): number[] {
  const b = [ESC, 0x40, ESC, 0x4d, 0x00];
  if (p.codePage !== undefined) b.push(ESC, 0x74, p.codePage);
  return b;
}

/** ESC p m t1 t2: pulse the drawer pin (t1 = 25 x 2 ms on, t2 = 250 x 2 ms off). */
export function drawerKickBytes(p: PrinterProfile): number[] {
  return [ESC, 0x70, p.drawerPin, 0x19, 0xfa];
}

/** GS v 0 raster in bands of at most `bandRows` rows. */
export function rasterBytes(bmp: Bitmap1bit, bandRows: number): number[] {
  const rowBytes = Math.ceil(bmp.widthDots / 8);
  const out: number[] = [];
  for (let y0 = 0; y0 < bmp.heightDots; y0 += bandRows) {
    const rows = Math.min(bandRows, bmp.heightDots - y0);
    out.push(GS, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8);
    const slice = bmp.data.subarray(y0 * rowBytes, (y0 + rows) * rowBytes);
    for (let i = 0; i < slice.length; i++) out.push(slice[i]!);
  }
  return out;
}

/** GS ( k QR: model 2, module size, error correction M, store, print. */
export function qrBytes(data: string, moduleSize: number): number[] {
  const bytes = Array.from(new TextEncoder().encode(data));
  if (bytes.length === 0 || bytes.length > 7000) throw new Error("QR data length out of range");
  const n = bytes.length + 3;
  return [
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, moduleSize)),
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
    GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30, ...bytes,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
  ];
}

type State = { align: number; bold: boolean; size: number; invert: boolean };

/**
 * Encode layout ops to ESC/POS bytes. Text is ASCII (layout already folded it). Raster ops need a
 * rasterizer; layout only emits them when one reports a font, so a missing one is a programming error.
 */
export function encodeOps(ops: LayoutOp[], profile: PrinterProfile, rasterizer?: TextRasterizer): Uint8Array {
  const out = new Bytes();
  out.push(...initBytes(profile));
  const st: State = { align: 0, bold: false, size: 0, invert: false };

  const apply = (s: TextStyle) => {
    const align = s.align === "center" ? 1 : s.align === "right" ? 2 : 0;
    if (align !== st.align) {
      out.push(ESC, 0x61, align);
      st.align = align;
    }
    const bold = !!s.bold;
    if (bold !== st.bold) {
      out.push(ESC, 0x45, bold ? 1 : 0);
      st.bold = bold;
    }
    const size = (((s.w ?? 1) - 1) << 4) | ((s.h ?? 1) - 1);
    if (size !== st.size) {
      out.push(GS, 0x21, size);
      st.size = size;
    }
    const inv = !!s.invert;
    if (inv !== st.invert) {
      out.push(GS, 0x42, inv ? 1 : 0);
      st.invert = inv;
    }
  };

  for (const op of ops) {
    switch (op.t) {
      case "text":
        apply(op.style);
        for (let i = 0; i < op.text.length; i++) {
          const c = op.text.charCodeAt(i);
          out.push(c >= 0x20 && c < 0x7f ? c : 0x3f);
        }
        out.push(LF);
        break;
      case "raster": {
        if (!rasterizer) throw new Error("raster op without a rasterizer");
        apply({});
        const dotsPerCol = profile.dots / profile.columns;
        const bmp = rasterizer.render({
          text: op.text,
          script: op.script,
          widthDots: profile.dots,
          indentDots: Math.round(op.indentCols * dotsPerCol),
          scale: op.scale,
          bold: op.bold,
          align: op.align,
        });
        out.pushArr(rasterBytes(bmp, profile.rasterBandRows));
        break;
      }
      case "qr":
        apply({ align: "center" });
        out.pushArr(qrBytes(op.data, profile.qrModuleSize));
        out.push(LF);
        break;
      case "feed":
        out.push(ESC, 0x64, Math.min(255, op.lines));
        break;
      case "drawer":
        out.pushArr(drawerKickBytes(profile));
        break;
      case "cut":
        apply({});
        out.push(ESC, 0x64, profile.feedBeforeCut);
        if (profile.cut !== "none") out.push(GS, 0x56, profile.cut === "full" ? 0 : 1);
        break;
    }
  }
  return out.done();
}
