import type {
  BarcodeScanner,
  CashDrawer,
  DeviceStatus,
  KitchenPrinter,
  LabelPrinter,
  PrintPayload,
  ReceiptPrinter,
  Scale,
  ScaleReading,
} from "./types";

/** Records printed payloads. Set `failWith` to simulate a printer that is off or out of paper. */
export class FakeReceiptPrinter implements ReceiptPrinter {
  printed: PrintPayload[] = [];
  failWith: DeviceStatus | undefined;
  async status(): Promise<DeviceStatus> {
    return this.failWith ?? "ready";
  }
  async print(payload: PrintPayload): Promise<void> {
    if (this.failWith) throw new Error(`printer ${this.failWith}`);
    this.printed.push(payload);
  }
}

export class FakeKitchenPrinter implements KitchenPrinter {
  printed: { station: string; payload: PrintPayload }[] = [];
  failWith: DeviceStatus | undefined;
  async status(): Promise<DeviceStatus> {
    return this.failWith ?? "ready";
  }
  async print(payload: PrintPayload, station: string): Promise<void> {
    if (this.failWith) throw new Error(`printer ${this.failWith}`);
    this.printed.push({ station, payload });
  }
}

export class FakeLabelPrinter implements LabelPrinter {
  printed: PrintPayload[] = [];
  async status(): Promise<DeviceStatus> {
    return "ready";
  }
  async print(payload: PrintPayload): Promise<void> {
    this.printed.push(payload);
  }
}

export class FakeScale implements Scale {
  reading: ScaleReading = { grams: 0, stable: true };
  async status(): Promise<DeviceStatus> {
    return "ready";
  }
  async read(): Promise<ScaleReading> {
    return { ...this.reading };
  }
  async tare(): Promise<void> {
    this.reading = { grams: 0, stable: true };
  }
}

export class FakeBarcodeScanner implements BarcodeScanner {
  private listeners = new Set<(code: string) => void>();
  async status(): Promise<DeviceStatus> {
    return "ready";
  }
  onScan(listener: (code: string) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** Test helper: simulate a scan. */
  scan(code: string): void {
    for (const l of this.listeners) l(code);
  }
}

export class FakeCashDrawer implements CashDrawer {
  opened = 0;
  async status(): Promise<DeviceStatus> {
    return "ready";
  }
  async open(): Promise<void> {
    this.opened++;
  }
}
