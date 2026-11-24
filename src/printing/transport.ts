import type { DeviceStatus, ReceiptPrinter } from "../devices/types";

/**
 * How a printer is reached (ADR-0014 R8 item 2). Transports only move bytes; formatting is never done here.
 * USB, Bluetooth and spooler transports are implemented by the native shell (Tauri) and registered against
 * this interface; this repo ships the types and the LAN stub.
 */
export type PrinterTarget =
  | { kind: "lan"; host: string; port: number }
  /** USB, Bluetooth or spooler on another device: printed by that device when the document reaches it. */
  | { kind: "device"; deviceId: string };

export interface ByteTransport {
  send(bytes: Uint8Array): Promise<void>;
  status(): Promise<DeviceStatus>;
}

/** One open raw socket; the shell provides it (browsers cannot open raw TCP). */
export interface TcpConnection {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export type TcpConnector = (host: string, port: number) => Promise<TcpConnection>;

export const RAW_PRINT_PORT = 9100;

export class TransportUnavailableError extends Error {
  constructor(what: string) {
    super(`transport unavailable: ${what}`);
    this.name = "TransportUnavailableError";
  }
}

/**
 * LAN raw-TCP (port 9100) transport. STUB: with no connector (browser build, or a shell that has not
 * wired one yet) it reports "offline" and rejects sends, so the job stays queued and visible. The Tauri
 * shell supplies a `TcpConnector`; connect per job, write, close (printers accept one client at a time).
 */
export class LanRawTcpTransport implements ByteTransport {
  constructor(
    readonly host: string,
    readonly port: number = RAW_PRINT_PORT,
    private readonly connect?: TcpConnector,
  ) {}

  async status(): Promise<DeviceStatus> {
    return this.connect ? "ready" : "offline";
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.connect) throw new TransportUnavailableError(`no TCP connector for ${this.host}:${this.port}`);
    const conn = await this.connect(this.host, this.port);
    try {
      await conn.write(bytes);
    } finally {
      await conn.close();
    }
  }
}

/** Adapt a transport to the `ReceiptPrinter` device interface. */
export function printerFromTransport(t: ByteTransport): ReceiptPrinter {
  return { status: () => t.status(), print: (payload) => t.send(payload) };
}
