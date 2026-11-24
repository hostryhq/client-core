/**
 * Device adapter interfaces (client-app-standard). Hardware sits behind these; every adapter has a fake
 * (./fakes.ts) used in unit and UI tests and in the browser build. Real adapters (ESC/POS over
 * USB/LAN/Bluetooth, scale protocols) arrive with the devices skill and live in the app shell bridge.
 * Device failure never loses the order: callers queue the job (./print-queue.ts) and show it.
 */

import type { Unsubscribe } from "../sync/types";

export type DeviceStatus = "ready" | "offline" | "paper_out" | "error";

export interface Device {
  status(): Promise<DeviceStatus>;
}

/** Raw bytes for the printer (ESC/POS built by a formatter, not by the adapter). */
export type PrintPayload = Uint8Array;

export interface ReceiptPrinter extends Device {
  /** Rejects if the printer cannot take the job; the caller keeps it queued. */
  print(payload: PrintPayload): Promise<void>;
}

/** Kitchen ticket printer (a KOT per station). */
export interface KitchenPrinter extends Device {
  print(payload: PrintPayload, station: string): Promise<void>;
}

export interface LabelPrinter extends Device {
  print(payload: PrintPayload): Promise<void>;
}

export type ScaleReading = {
  /** Integer grams. Never a float. */
  grams: number;
  /** False while the pan is still settling; do not bill an unstable reading. */
  stable: boolean;
};

export interface Scale extends Device {
  read(): Promise<ScaleReading>;
  /** Re-zero (tare) the scale. */
  tare(): Promise<void>;
}

export interface BarcodeScanner extends Device {
  /** Called once per scanned code (keyboard-wedge, serial or camera behind the adapter). */
  onScan(listener: (code: string) => void): Unsubscribe;
}

export interface CashDrawer extends Device {
  open(): Promise<void>;
}
