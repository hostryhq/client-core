import { describe, expect, it } from "vitest";
import { billR1, billTamil, creditNote, kot, preBill, zReport } from "./fixtures";
import { CanvasTextRasterizer } from "./raster";
import { renderDocument } from "./render";
import { GENERIC_58, GENERIC_80 } from "./profiles";
import { disassemble, FakeTextCanvasFactory } from "./testing";
import type { PrintDocument } from "./types";

/**
 * Golden ESC/POS output per document type and width (ADR-0014 test layer). Files live in __golden__/ as
 * readable dumps (text as text, commands as <NAME args>, raster as size plus pixel fingerprint). A change
 * in printed output shows as a diff here; review it, then update with `vitest -u`.
 * Raster pixels come from the deterministic fake canvas, not a real font.
 */
const rasterizer = new CanvasTextRasterizer(new FakeTextCanvasFactory());

const cases: [string, PrintDocument][] = [
  ["bill-r1", billR1()],
  ["bill-cash-drawer-upi", billR1({ openDrawer: true, upiUri: "upi://pay?pa=anand@bank&pn=Anand&am=315.00&cu=INR" })],
  ["bill-tamil", billTamil("ta")],
  ["bill-malayalam", billTamil("ml")],
  ["bill-duplicate", billR1({ duplicate: { copy: 2, reprintedAt: "2026-11-24T08:50:00Z" } })],
  [
    "bill-of-supply",
    billR1({ variant: "bill_of_supply", taxGroups: [], total: 30000, subtotal: 30000, guest: undefined, tenders: [{ label: "UPI", amount: 30000 }], change: undefined }),
  ],
  ["pre-bill", preBill()],
  ["pre-bill-second", preBill({ sequence: 2 })],
  ["credit-note", creditNote()],
  ["kot-tamil-station", kot({ stationScript: "ta" })],
  ["kot-english", kot()],
  ["kot-cancel", kot({ variant: "cancel", reason: "Wrong item", lines: [{ qty: 1, name: { en: "Vada" } }] })],
  ["kot-late", kot({ variant: "late", ageMinutes: 31 })],
  ["kot-duplicate", kot({ variant: "duplicate", reprintedAt: "2026-11-24T08:00:00Z" })],
  ["kot-takeaway", kot({ tableLabel: "TAKEAWAY #27", orderType: undefined, waiter: undefined })],
  ["z-report", zReport()],
];

describe("golden ESC/POS output", () => {
  for (const [name, doc] of cases) {
    for (const [wname, profile] of [["80", GENERIC_80], ["58", GENERIC_58]] as const) {
      it(`${name} @ ${wname} mm`, async () => {
        const bytes = renderDocument(doc, profile, { rasterizer });
        await expect(disassemble(bytes)).toMatchFileSnapshot(`./__golden__/${name}.${wname}.txt`);
      });
    }
  }

  it("is deterministic: the same document renders to identical bytes", () => {
    const a = renderDocument(billTamil(), GENERIC_80, { rasterizer });
    const b = renderDocument(billTamil(), GENERIC_80, { rasterizer });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
