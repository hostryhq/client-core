import { describe, expect, it } from "vitest";
import { billR1, billTamil, creditNote, kot, preBill, zReport } from "./fixtures";
import { layoutFor } from "./render";
import { GENERIC_58, GENERIC_80 } from "./profiles";
import { CanvasTextRasterizer } from "./raster";
import { FakeTextCanvasFactory, toPlainText } from "./testing";
import type { LayoutOp, PrinterProfile, PrintDocument } from "./types";

const withFonts = new CanvasTextRasterizer(new FakeTextCanvasFactory());
const noFonts = new CanvasTextRasterizer(new FakeTextCanvasFactory(new Set()));

const plain = (doc: PrintDocument, p: PrinterProfile, r = withFonts) => toPlainText(layoutFor(doc, p, { rasterizer: r }), p.columns);

/** Every native text line fits its width (accounting for double-width characters). */
function assertFits(ops: LayoutOp[], p: PrinterProfile) {
  for (const op of ops) {
    if (op.t !== "text") continue;
    const cap = Math.floor(p.columns / (op.style.w ?? 1));
    expect(op.text.length, `"${op.text}" exceeds ${cap}`).toBeLessThanOrEqual(cap);
  }
}

describe("layout: widths", () => {
  const docs: PrintDocument[] = [billR1(), billTamil("ta"), preBill(), creditNote(), kot({ stationScript: "ml" }), zReport()];
  for (const p of [GENERIC_80, GENERIC_58]) {
    it(`every line of every document type fits ${p.columns} columns`, () => {
      for (const d of docs) assertFits(layoutFor(d, p, { rasterizer: withFonts }), p);
    });
  }

  it("matches the reference 80 mm invoice layout from the flows doc", () => {
    const lines = plain(billR1(), GENERIC_80);
    expect(lines).toContain("Masala Dosa                 3   80.00     240.00");
    expect(lines).toContain("TOTAL                                  Rs 315.00");
    expect(lines).toContain("Inv A07/2627/000123             24-11-2026 13:05");
    expect(lines.at(-1)).toBe("[CUT]");
  });

  it("uses a different item grid on 58 mm, driven by the profile", () => {
    expect(plain(billR1(), GENERIC_58)).toContain("Masala Dosa     3  80.00  240.00");
  });
});

describe("layout: long item names", () => {
  const long = "Special Hyderabadi Chicken Dum Biryani with Extra Raita and Boiled Egg";
  const doc = billR1({ lines: [{ name: { en: long }, qty: 2, rate: 25000, amount: 50000 }], subtotal: 50000 });

  for (const p of [GENERIC_80, GENERIC_58]) {
    it(`wraps the name at word boundaries; qty, rate and amount stay on the first line (${p.columns} col)`, () => {
      const lines = plain(doc, p);
      const i = lines.findIndex((l) => l.startsWith("Special"));
      expect(i).toBeGreaterThan(0);
      expect(lines[i]).toMatch(/ 2 +250\.00 +500\.00$/);
      const end = lines.findIndex((l, k) => k > i && l.startsWith("---"));
      const cont = lines.slice(i + 1, end).filter((l) => l.startsWith("  "));
      expect(cont.length).toBeGreaterThan(0);
      const rejoined = [lines[i]!.replace(/ +2 +250\.00 +500\.00$/, ""), ...cont.map((c) => c.trim())].join(" ");
      expect(rejoined).toBe(long);
      assertFits(layoutFor(doc, p, {}), p);
    });
  }

  it("never splits an amount, even a very large one, and keeps a gap before it", () => {
    const big = billR1({ lines: [{ name: { en: "Banquet" }, qty: 1, rate: 123456789, amount: 123456789 }], subtotal: 123456789, total: 123456789 });
    for (const p of [GENERIC_80, GENERIC_58]) {
      const lines = plain(big, p);
      expect(lines.some((l) => l.endsWith("12,34,567.89") && /\S {2,}/.test(l.slice(0, -12)))).toBe(true);
      assertFits(layoutFor(big, p, {}), p);
    }
  });

  it("holds for any name length 1..120 (property sweep)", () => {
    for (let n = 1; n <= 120; n += 7) {
      const name = Array.from({ length: n }, (_, i) => (i % 9 === 8 ? " " : "x")).join("");
      for (const p of [GENERIC_80, GENERIC_58]) assertFits(layoutFor(billR1({ lines: [{ name: { en: name }, qty: 1, rate: 100, amount: 100 }] }), p, {}), p);
    }
  });

  it("does not wrap the invoice number on 58 mm: the label moves above when the line would not fit", () => {
    const thirty = "A07/2627/00000000000000123456"; // 29 chars: fits alone, not with "Inv "
    const lines = plain(billR1({ number: thirty }), GENERIC_58);
    expect(lines).toContain("Inv");
    expect(lines).toContain(thirty);
    assertFits(layoutFor(billR1({ number: "X".repeat(40) }), GENERIC_58, {}), GENERIC_58); // longer than paper: hard-split
    const normal = plain(billR1(), GENERIC_58);
    expect(normal).toContain("Inv A07/2627/000123");
    expect(normal).toContain("24-11-2026 13:05");
  });
});

describe("layout: Tamil and Malayalam", () => {
  it("invoice: English line stays native text, the local name is a raster line indented 2 under it", () => {
    const ops = layoutFor(billTamil("ta"), GENERIC_80, { rasterizer: withFonts });
    const i = ops.findIndex((o) => o.t === "text" && o.text.startsWith("Masala Dosa"));
    const next = ops[i + 1]!;
    expect(next).toMatchObject({ t: "raster", script: "ta", text: "மசாலா தோசை", indentCols: 2 });
    expect(ops.filter((o) => o.t === "raster")).toHaveLength(2);
  });

  it("invoice: Malayalam uses the Malayalam script", () => {
    const ops = layoutFor(billTamil("ml"), GENERIC_58, { rasterizer: withFonts });
    expect(ops.filter((o) => o.t === "raster").map((o) => (o as { script: string }).script)).toEqual(["ml", "ml"]);
  });

  it("KOT in a Tamil station: item is a double-height raster line with Western-digit quantity; no prices", () => {
    const ops = layoutFor(kot({ stationScript: "ta" }), GENERIC_80, { rasterizer: withFonts });
    const r = ops.filter((o) => o.t === "raster");
    expect(r[0]).toMatchObject({ t: "raster", scale: 2, text: "3 x மசாலா தோசை" });
    expect(r[2]).toMatchObject({ text: "1 x பரோட்டா Half" });
    expect(JSON.stringify(ops)).not.toMatch(/\d\.\d\d\b/);
  });

  it("a missing font prints the English name instead (flows doc rule)", () => {
    const ops = layoutFor(kot({ stationScript: "ta" }), GENERIC_80, { rasterizer: noFonts });
    expect(ops.some((o) => o.t === "raster")).toBe(false);
    expect(plain(kot({ stationScript: "ta" }), GENERIC_80, noFonts)).toContain(" 3 x Masala Dosa");
  });

  it("a printer profile without raster support also falls back to English", () => {
    const p = { ...GENERIC_80, raster: false };
    expect(layoutFor(billTamil(), p, { rasterizer: withFonts }).some((o) => o.t === "raster")).toBe(false);
  });

  it("a Latin-station KOT never rasters, even if names have local text", () => {
    expect(layoutFor(kot(), GENERIC_80, { rasterizer: withFonts }).some((o) => o.t === "raster")).toBe(false);
  });
});

describe("layout: business rules", () => {
  it("pre-bill has no invoice number or tax-invoice heading and is marked NOT A TAX INVOICE twice", () => {
    const t = plain(preBill(), GENERIC_80).join("\n");
    expect(t).not.toMatch(/(?<!NOT A )TAX INVOICE|Inv |GSTIN/);
    expect(t.match(/NOT A TAX INVOICE/g)?.length).toBe(2);
    expect(t).toContain("CGST 2.5% (estimate)");
    expect(t).not.toContain("Replaces");
  });

  it("a second pre-bill says it replaces the first", () => {
    expect(plain(preBill({ sequence: 2 }), GENERIC_80).join("\n")).toContain("Replaces pre-bill 1");
  });

  it("KOT carries no prices and no customer name or phone", () => {
    const t = plain(kot(), GENERIC_80).join("\n");
    expect(t).not.toMatch(/Rs|\d+\.\d\d/);
    expect(Object.keys(kot())).not.toEqual(expect.arrayContaining(["customer", "phone"]));
  });

  it("KOT variants carry their banner (late shows the age)", () => {
    expect(plain(kot({ variant: "late", ageMinutes: 31 }), GENERIC_80).join("\n")).toMatch(/LATE - NOT AN ORIGINAL[\s\S]*31 min old/);
    expect(plain(kot({ variant: "duplicate", reprintedAt: "2026-11-24T08:00:00Z" }), GENERIC_80)[0]).toContain("DUPLICATE");
    expect(plain(kot({ variant: "moved", movedFrom: "T5", movedTo: "T7" }), GENERIC_80)[0]).toContain("MOVED T5 -> T7");
  });

  it("bill of supply and plain bill print no tax lines; composition statement for bill of supply", () => {
    const bos = plain(billR1({ variant: "bill_of_supply", taxGroups: [] }), GENERIC_80).join("\n");
    expect(bos).toContain("BILL OF SUPPLY");
    expect(bos).toContain("Composition taxable person");
    expect(bos).not.toMatch(/CGST|Taxable value/);
    const pb = plain(billR1({ variant: "plain_bill", taxGroups: [], guest: undefined, business: { name: "Cafe" } }), GENERIC_80).join("\n");
    expect(pb).not.toMatch(/GSTIN \d|TAX INVOICE/);
  });

  it("a duplicate invoice keeps the same number and adds the DUPLICATE banner", () => {
    const t = plain(billR1({ duplicate: { copy: 2, reprintedAt: "2026-11-24T08:50:00Z" } }), GENERIC_80);
    expect(t[0]).toContain("DUPLICATE - Copy 2");
    expect(t.join("\n")).toContain("A07/2627/000123");
  });

  it("discount prints negative; round-off prints with a sign; several rate groups print one block each", () => {
    const t = plain(
      billR1({
        discount: { label: "Discount (10%)", amount: 3000 },
        roundOff: 4,
        taxGroups: [
          { rateLabel: "5%", taxable: 10000, taxes: [{ label: "CGST 2.5%", amount: 250 }] },
          { rateLabel: "18%", taxable: 20000, taxes: [{ label: "CGST 9%", amount: 1800 }] },
        ],
      }),
      GENERIC_80,
    ).join("\n");
    expect(t).toMatch(/Discount \(10%\) +-30\.00/);
    expect(t).toMatch(/Round-off +\+0\.04/);
    expect(t).toMatch(/Taxable value \(5%\)[\s\S]*Taxable value \(18%\)/);
  });

  it("money uses Western digits and Rs, never the rupee glyph", () => {
    const t = plain(billR1(), GENERIC_80).join("\n");
    expect(t).not.toContain("₹");
    expect(t).toContain("Rs 315.00");
  });

  it("times print in IST from UTC (07:35Z -> 13:05)", () => {
    expect(plain(billR1(), GENERIC_80).join("\n")).toContain("24-11-2026 13:05");
  });

  it("cash drawer kick comes first, only when asked; one cut at the end", () => {
    const withKick = layoutFor(billR1({ openDrawer: true }), GENERIC_80, {});
    expect(withKick[0]!.t).toBe("drawer");
    expect(layoutFor(billR1(), GENERIC_80, {}).some((o) => o.t === "drawer")).toBe(false);
    expect(withKick.filter((o) => o.t === "cut")).toHaveLength(1);
  });

  it("QR is skipped when the profile has no QR support", () => {
    const doc = billR1({ upiUri: "upi://pay?pa=a@b" });
    expect(layoutFor(doc, GENERIC_80, {}).some((o) => o.t === "qr")).toBe(true);
    expect(layoutFor(doc, { ...GENERIC_80, qr: false }, {}).some((o) => o.t === "qr")).toBe(false);
  });

  it("control characters in names cannot inject printer commands", () => {
    const evil = billR1({ lines: [{ name: { en: "Tea\u001b@\u001dV\u0001 x\nCUT" }, qty: 1, rate: 100, amount: 100 }] });
    for (const op of layoutFor(evil, GENERIC_80, {})) {
      if (op.t === "text") expect([...op.text].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)).toBe(true);
    }
  });
});
