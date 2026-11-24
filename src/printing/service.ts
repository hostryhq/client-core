import { exponentialBackoff, PrintQueue, type PrintQueueOptions } from "../devices/print-queue";
import type { Labels } from "./labels";
import type { TextRasterizer } from "./raster";
import { renderDocument } from "./render";
import type { KotDoc, PrinterProfile, PrintDocument } from "./types";

/** ADR-0014 A1.6 `kot_stale_after` default: a KOT older than this when it first arrives is never auto-printed. */
export const KOT_STALE_AFTER_MS = 15 * 60_000;

export type PrintTrigger = "auto" | "manual";
export type PrintOutcome = "queued" | "late" | "already_handled";

export type LateTicket = {
  id: string;
  printerId: string;
  doc: KotDoc;
  reason: "stale" | "handover";
  ageMinutes: number;
};

export type PrintServiceOptions = {
  now?: () => number;
  rasterizer?: TextRasterizer;
  labels?: Labels;
  staleAfterMs?: number;
  queue?: PrintQueueOptions;
};

type Entry = { profile: PrinterProfile; queue: PrintQueue };

/**
 * Renders documents for a printer profile and puts the bytes on that printer's `PrintQueue`.
 * - Rendering and queuing are synchronous and local: nothing here waits on the network or a printer.
 * - A job id is accepted once: a document re-delivered by sync (same id) does not print twice. (The id
 *   set is in memory; persist `PrintQueue` via `onChange` and seed ids on start when the store lands.)
 * - Stale rule (ADR-0014 A1.6): an automatic KOT print is held, not printed, when the KOT was handed over
 *   by hand, or is older than `staleAfterMs` when it arrives. Held tickets are listed for a person to print
 *   (marked "LATE - NOT AN ORIGINAL") or dismiss. Duplicates and late prints are manual and always print.
 * - A KOT already queued for a printer that is down is NOT re-judged later: it was fresh when it arrived,
 *   and the queue shows it; the rule is about tickets that arrive late (after a blackout or sync gap).
 */
export class PrintService {
  private readonly printers = new Map<string, Entry>();
  private readonly seen = new Set<string>();
  private readonly late = new Map<string, LateTicket>();
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  constructor(private readonly opts: PrintServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? KOT_STALE_AFTER_MS;
  }

  addPrinter(printerId: string, profile: PrinterProfile, send: (bytes: Uint8Array) => Promise<void>): PrintQueue {
    const queue = new PrintQueue(send, {
      now: this.now,
      backoffMs: exponentialBackoff,
      maxAttempts: 10,
      ...this.opts.queue,
    });
    this.printers.set(printerId, { profile, queue });
    return queue;
  }

  queue(printerId: string): PrintQueue {
    return this.entry(printerId).queue;
  }

  print(printerId: string, doc: PrintDocument, o: { jobId: string; trigger?: PrintTrigger }): PrintOutcome {
    const e = this.entry(printerId);
    if (this.seen.has(o.jobId) || this.late.has(o.jobId)) return "already_handled";
    const trigger = o.trigger ?? "auto";

    if (doc.kind === "kot" && trigger === "auto" && doc.variant !== "duplicate" && doc.variant !== "late") {
      const age = this.now() - Date.parse(doc.createdAt);
      const reason = doc.handedOver ? "handover" : age > this.staleAfterMs ? "stale" : undefined;
      if (reason) {
        this.late.set(o.jobId, { id: o.jobId, printerId, doc, reason, ageMinutes: Math.max(0, Math.floor(age / 60_000)) });
        return "late";
      }
    }
    this.enqueue(e, o.jobId, doc);
    return "queued";
  }

  lateTickets(): readonly LateTicket[] {
    return [...this.late.values()];
  }

  /** A person chose to print a held ticket: it prints once, marked late. */
  printLate(id: string): boolean {
    const t = this.late.get(id);
    if (!t) return false;
    const ageMinutes = Math.max(0, Math.floor((this.now() - Date.parse(t.doc.createdAt)) / 60_000));
    this.late.delete(id);
    this.enqueue(this.entry(t.printerId), id, { ...t.doc, variant: "late", ageMinutes });
    return true;
  }

  /** A person chose not to print a held ticket. It is not printed later and not listed again. */
  dismissLate(id: string): boolean {
    if (!this.late.delete(id)) return false;
    this.seen.add(id);
    return true;
  }

  /** Try every printer's queue. Returns the total jobs printed. Call on a timer and on reconnect. */
  async flush(printerId?: string): Promise<number> {
    const targets = printerId ? [this.entry(printerId)] : [...this.printers.values()];
    let n = 0;
    for (const t of targets) n += await t.queue.flush();
    return n;
  }

  private enqueue(e: Entry, id: string, doc: PrintDocument): void {
    const bytes = renderDocument(doc, e.profile, { rasterizer: this.opts.rasterizer, labels: this.opts.labels });
    this.seen.add(id);
    e.queue.enqueue(id, bytes, doc.kind);
  }

  private entry(printerId: string): Entry {
    const e = this.printers.get(printerId);
    if (!e) throw new Error(`unknown printer ${printerId}`);
    return e;
  }
}
