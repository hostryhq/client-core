import { drawerKickBytes, encodeOps, initBytes } from "./escpos";
import { LABELS_EN, type Labels } from "./labels";
import { layoutDocument } from "./layout";
import type { TextRasterizer } from "./raster";
import type { LayoutOp, PrinterProfile, PrintDocument } from "./types";

export type RenderDeps = {
  /** Without one, Tamil/Malayalam lines fall back to the English name. */
  rasterizer?: TextRasterizer;
  labels?: Labels;
};

export function layoutFor(doc: PrintDocument, profile: PrinterProfile, deps: RenderDeps = {}): LayoutOp[] {
  const r = deps.rasterizer;
  return layoutDocument(doc, {
    profile,
    labels: deps.labels ?? LABELS_EN,
    canRaster: (s) => profile.raster && !!r && r.hasFont(s),
  });
}

/** Document to ESC/POS bytes for one printer profile. One cut after the document. */
export function renderDocument(doc: PrintDocument, profile: PrinterProfile, deps: RenderDeps = {}): Uint8Array {
  return encodeOps(layoutFor(doc, profile, deps), profile, deps.rasterizer);
}

/** "No sale" drawer open: init plus the pulse, nothing printed. */
export function renderDrawerKick(profile: PrinterProfile): Uint8Array {
  return Uint8Array.from([...initBytes(profile), ...drawerKickBytes(profile)]);
}
