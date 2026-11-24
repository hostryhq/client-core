import type { PrinterProfile } from "./types";

/**
 * Built-in profiles are generic ESC/POS 80 mm and 58 mm. Model-specific tweaks (code page, raster band
 * size, drawer pin, cut command) are added as `makeProfile(base, {...})` once the real-hardware matrix
 * has run (devices skill: manual per-model check). Layout always reads columns/dots from the profile.
 */
export const GENERIC_80: PrinterProfile = {
  id: "generic-80",
  name: "Generic ESC/POS 80 mm",
  widthMm: 80,
  columns: 48,
  dots: 576,
  raster: true,
  rasterBandRows: 128,
  qr: true,
  qrModuleSize: 6,
  cut: "partial",
  feedBeforeCut: 3,
  drawerPin: 0,
};

export const GENERIC_58: PrinterProfile = {
  id: "generic-58",
  name: "Generic ESC/POS 58 mm",
  widthMm: 58,
  columns: 32,
  dots: 384,
  raster: true,
  rasterBandRows: 128,
  qr: true,
  qrModuleSize: 5,
  cut: "none",
  feedBeforeCut: 4,
  drawerPin: 0,
};

export function makeProfile(base: PrinterProfile, over: Partial<PrinterProfile> & { id: string }): PrinterProfile {
  const p = { ...base, ...over };
  if (p.columns < 20 || p.dots < p.columns * 8) throw new Error(`implausible printer profile ${p.id}`);
  return p;
}

export const BUILTIN_PROFILES: readonly PrinterProfile[] = [GENERIC_80, GENERIC_58];
