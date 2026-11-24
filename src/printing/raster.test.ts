import { describe, expect, it } from "vitest";
import { CachingRasterizer, CanvasTextRasterizer, type RasterRequest, type TextRasterizer } from "./raster";
import { FakeTextCanvasFactory } from "./testing";

const req = (over: Partial<RasterRequest> = {}): RasterRequest => ({
  text: "மசாலா தோசை",
  script: "ta",
  widthDots: 384,
  indentDots: 0,
  scale: 1,
  bold: false,
  align: "left",
  ...over,
});

describe("CanvasTextRasterizer", () => {
  const r = new CanvasTextRasterizer(new FakeTextCanvasFactory());

  it("always produces a bitmap exactly the paper's dot width, with some ink", () => {
    const b = r.render(req());
    expect(b.widthDots).toBe(384);
    expect(b.data.length).toBe(48 * b.heightDots);
    expect(b.data.some((v) => v !== 0)).toBe(true);
  });

  it("is deterministic and differs by text", () => {
    expect(r.render(req()).data).toEqual(r.render(req()).data);
    expect(r.render(req({ text: "ഫിൽട്ടർ" })).data).not.toEqual(r.render(req()).data);
  });

  it("wraps long text onto more lines instead of running off the paper; double scale is taller", () => {
    const one = r.render(req({ text: "மசாலா" }));
    const many = r.render(req({ text: "மசாலா தோசை சட்னி சாம்பார் இட்லி வடை பொங்கல் பூரி கிழங்கு" }));
    expect(many.heightDots).toBeGreaterThan(one.heightDots);
    expect(r.render(req({ text: "மசாலா", scale: 2 })).heightDots).toBeGreaterThan(one.heightDots);
  });

  it("splits a single word wider than the paper by characters", () => {
    const b = r.render(req({ text: "அ".repeat(80), widthDots: 200 }));
    expect(b.heightDots).toBeGreaterThan(36);
  });

  it("indent leaves the left dots blank; centre and right move ink away from the left edge", () => {
    const firstInkCol = (data: Uint8Array, rowBytes: number) => {
      for (let x = 0; x < rowBytes * 8; x++) for (let y = 0; y < data.length / rowBytes; y++) if (data[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7))) return x;
      return -1;
    };
    const left = r.render(req({ text: "அ" }));
    const indented = r.render(req({ text: "அ", indentDots: 24 }));
    const centred = r.render(req({ text: "அ", align: "center" }));
    const lc = firstInkCol(left.data, 48);
    expect(firstInkCol(indented.data, 48)).toBe(lc + 24);
    expect(firstInkCol(centred.data, 48)).toBeGreaterThan(lc + 100);
  });

  it("refuses to render a script whose font is not loaded (callers check hasFont first)", () => {
    const noTamil = new CanvasTextRasterizer(new FakeTextCanvasFactory(new Set(["ml"])));
    expect(noTamil.hasFont("ta")).toBe(false);
    expect(() => noTamil.render(req())).toThrow(/no font/);
  });
});

describe("CachingRasterizer", () => {
  it("renders identical requests once and evicts the oldest past its limit", () => {
    let calls = 0;
    const inner: TextRasterizer = {
      hasFont: () => true,
      render: (q) => {
        calls++;
        return { widthDots: q.widthDots, heightDots: 1, data: new Uint8Array(q.widthDots / 8) };
      },
    };
    const c = new CachingRasterizer(inner, 2);
    c.render(req({ text: "a" }));
    c.render(req({ text: "a" }));
    expect(calls).toBe(1);
    c.render(req({ text: "b" }));
    c.render(req({ text: "c" })); // evicts "a"
    expect(c.size).toBe(2);
    c.render(req({ text: "a" }));
    expect(calls).toBe(4);
  });
});
