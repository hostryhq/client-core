import type { PrintPayload } from "./types";

export type PrintJob = {
  id: string;
  payload: PrintPayload;
  attempts: number;
  /** "pending" retries; "failed" ran out of attempts and waits for a person (`retry`). Both stay visible. */
  status: "pending" | "failed";
  /** Free-text kind for the queue screen ("kot", "bill", ...). */
  kind?: string;
  /** Earliest time (ms) the next attempt may run; set by backoff after a failure. */
  nextAttemptAt?: number;
  /** Last failure message, shown to staff so a failed print is never invisible. */
  lastError?: string;
};

export type PrintQueueOptions = {
  /** Injectable clock (ms). */
  now?: () => number;
  /** Delay before the next attempt after `attempts` failures. Default 0 (retry on the next flush). */
  backoffMs?: (attempts: number) => number;
  /** After this many failed attempts a job becomes "failed" (still listed). Default: never. */
  maxAttempts?: number;
  /** Called after every change so the caller can persist the queue in the local store. */
  onChange?: (jobs: readonly PrintJob[]) => void;
};

/** 2 s, 4 s, 8 s ... capped at 60 s. */
export const exponentialBackoff = (attempts: number): number => Math.min(60_000, 1_000 * 2 ** attempts);

/**
 * In-memory print queue. A job leaves the queue only after the printer accepted it; failures keep it
 * visible (`pending()`), so a printer fault never loses the order. Order is preserved: a job that is
 * failing or backing off holds the jobs behind it (a failed one, past `maxAttempts`, does not).
 * Persist through `onChange`/`restore`.
 */
export class PrintQueue {
  private jobs: PrintJob[] = [];
  private readonly now: () => number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly maxAttempts: number;
  private readonly onChange?: (jobs: readonly PrintJob[]) => void;

  constructor(
    private readonly send: (payload: PrintPayload) => Promise<void>,
    opts: PrintQueueOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.backoffMs = opts.backoffMs ?? (() => 0);
    this.maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    this.onChange = opts.onChange;
  }

  enqueue(id: string, payload: PrintPayload, kind?: string): void {
    this.jobs.push({ id, payload, attempts: 0, status: "pending", kind });
    this.changed();
  }

  /** Reload jobs saved through `onChange` after a restart. */
  restore(jobs: readonly PrintJob[]): void {
    this.jobs = jobs.map((j) => ({ ...j }));
    this.changed();
  }

  has(id: string): boolean {
    return this.jobs.some((j) => j.id === id);
  }

  pending(): readonly PrintJob[] {
    return this.jobs;
  }

  /** When the head job may next be tried (ms), or undefined if nothing is waiting on backoff. */
  nextAttemptAt(): number | undefined {
    return this.jobs.find((j) => j.status === "pending")?.nextAttemptAt;
  }

  /** Put a failed job back in play (one-tap retry). */
  retry(id: string): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    j.status = "pending";
    j.attempts = 0;
    j.nextAttemptAt = undefined;
    this.changed();
    return true;
  }

  /** Drop a job a person chose to discard. Returns false if it was not queued. */
  remove(id: string): boolean {
    const n = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length === n) return false;
    this.changed();
    return true;
  }

  /** Try jobs in order; stop at the first failure or backoff so print order is preserved. Returns jobs printed. */
  async flush(): Promise<number> {
    let printed = 0;
    for (;;) {
      const job = this.jobs.find((j) => j.status === "pending");
      if (!job) return printed;
      if (job.nextAttemptAt !== undefined && job.nextAttemptAt > this.now()) return printed;
      job.attempts++;
      try {
        await this.send(job.payload);
      } catch (e) {
        job.lastError = e instanceof Error ? e.message : String(e);
        if (job.attempts >= this.maxAttempts) {
          job.status = "failed";
          this.changed();
          continue; // later jobs are not held hostage by one that needs a person
        }
        job.nextAttemptAt = this.now() + this.backoffMs(job.attempts);
        this.changed();
        return printed;
      }
      this.jobs = this.jobs.filter((j) => j !== job);
      printed++;
      this.changed();
    }
  }

  private changed(): void {
    this.onChange?.(this.jobs);
  }
}
