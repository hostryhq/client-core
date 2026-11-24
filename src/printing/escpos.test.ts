import { describe, expect, it } from "vitest";
import { drawerKickBytes, encodeOps, qrBytes, rasterBytes } from "./escpos";
import { GENERIC_58, GENERIC_80, makeProfile } from "./profiles";
import { renderDocument, renderDrawerKick } from "./render";
import { billR1, kot } from "./fixtures";
import { CanvasTextRasterizer, toBitmap, type Bitmap1bit } from "./raster";
import { FakeTextCanvasFactory } from "./testing";

const arr = (u: Uint8Array) => Array.from(u);

describe("ESC/POS encoder: exact command bytes", () => {
  it("starts with ESC @, font A; selects the profile code page when set", () => {
    expect(arr(encodeOps([], GENERIC_80)).slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x4d, 0x00]);
    const p = makeProfile(GENERIC_80, { id: "cp", codePage: 19 });
    expect(arr(encodeOps([], p)).slice(5, 8)).toEqual([0x1b, 0x74, 19]);
  });

  it("text: bold, double size and alignment are switched only when they change; LF ends the line", () => {
    const out = arr(
      encodeOps(
        [
          { t: "text", text: "A", style: { bold: true, h: 2, align: "center" } },
          { t: "text", text: "B", style: { bold: true, h: 2, align: "center" } },
        ],
        GENERIC_80,
      ),
    );
    expect(out.slice(5)).toEqual([0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x01, 0x41, 0x0a, 0x42, 0x0a]);
  });

  it("cut: feed then partial cut on 80 mm; feed only when the profile has no cutter", () => {
    expect(arr(encodeOps([{ t: "cut" }], GENERIC_80)).slice(5)).toEqual([0x1b, 0x64, 3, 0x1d, 0x56, 1]);
    expect(arr(encodeOps([{ t: "cut" }], makeProfile(GENERIC_80, { id: "full", cut: "full" }))).slice(-3)).toEqual([0x1d, 0x56, 0]);
    expect(arr(encodeOps([{ t: "cut" }], GENERIC_58)).slice(5)).toEqual([0x1b, 0x64, 4]);
  });

  it("cash drawer kick: ESC p pin t1 t2, on the profile's pin; also available alone for no-sale", () => {
    expect(drawerKickBytes(GENERIC_80)).toEqual([0x1b, 0x70, 0, 0x19, 0xfa]);
    expect(drawerKickBytes(makeProfile(GENERIC_80, { id: "p5", drawerPin: 1 }))[2]).toBe(1);
    expect(arr(renderDrawerKick(GENERIC_80))).toEqual([0x1b, 0x40, 0x1b, 0x4d, 0, 0x1b, 0x70, 0, 0x19, 0xfa]);
  });

  it("QR: model 2, module size, EC level M, store with length+3, print", () => {
    const q = qrBytes("upi://x", 6);
    expect(q.slice(0, 9)).toEqual([0x1d, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0]);
    expect(q.slice(9, 17)).toEqual([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6]);
    const store = q.slice(25);
    expect(store.slice(0, 8)).toEqual([0x1d, 0x28, 0x6b, 7 + 3, 0, 0x31, 0x50, 0x30]);
    expect(q.slice(-8)).toEqual([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]);
    expect(() => qrBytes("", 6)).toThrow();
  });

  it("raster: GS v 0 header carries bytes-per-row and rows; tall images are split into bands", () => {
    const bmp: Bitmap1bit = { widthDots: 16, heightDots: 300, data: new Uint8Array(2 * 300).fill(0xaa) };
    const out = rasterBytes(bmp, 128);
    expect(out.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 128, 0]);
    // 128 + 128 + 44 rows: three headers
    expect(out.length).toBe(3 * 8 + 2 * 300);
    expect(out.slice(8 + 256, 8 + 256 + 8)).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 128, 0]);
  });

  it("a raster op without a rasterizer is a programming error, not silent garbage", () => {
    expect(() => encodeOps([{ t: "raster", text: "x", script: "ta", indentCols: 0, scale: 1, bold: false, align: "left" }], GENERIC_80)).toThrow(/rasterizer/);
  });

  it("raster op emits a bitmap exactly the profile's dot width", () => {
    const r = new CanvasTextRasterizer(new FakeTextCanvasFactory());
    const out = encodeOps([{ t: "raster", text: "மசாலா", script: "ta", indentCols: 2, scale: 1, bold: false, align: "left" }], GENERIC_58, r);
    const i = out.findIndex((v, k) => v === 0x1d && out[k + 1] === 0x76);
    expect(out[i + 4]).toBe(GENERIC_58.dots / 8);
  });

  it("an item name with embedded ESC/POS commands cannot reach the printer as commands", () => {
    const evil = billR1({ lines: [{ name: { en: "Tea\u001bp\u0000\u0019ú" }, qty: 1, rate: 100, amount: 100 }] });
    const bytes = arr(renderDocument(evil, GENERIC_80));
    const drawer = bytes.findIndex((v, k) => v === 0x1b && bytes[k + 1] === 0x70);
    expect(drawer).toBe(-1);
    const at = bytes.findIndex((v, k) => v === 0x54 && bytes[k + 1] === 0x65 && bytes[k + 2] === 0x61); // "Tea"
    const lf = bytes.indexOf(0x0a, at);
    for (const b of bytes.slice(at, lf)) expect(b >= 0x20 && b < 0x7f).toBe(true);
  });

  it("every document ends with exactly one cut command", () => {
    const bytes = arr(renderDocument(kot(), GENERIC_80));
    let cuts = 0;
    bytes.forEach((v, k) => {
      if (v === 0x1d && bytes[k + 1] === 0x56) cuts++;
    });
    expect(cuts).toBe(1);
  });
});

describe("toBitmap", () => {
  it("thresholds opaque dark pixels to 1 and packs MSB first", () => {
    const rgba = new Uint8Array(9 * 1 * 4);
    for (const x of [0, 8]) rgba[x * 4 + 3] = 255; // ink at x=0 and x=8
    const b = toBitmap(rgba, 9, 1);
    expect(arr(b.data)).toEqual([0x80, 0x80]);
  });
});
