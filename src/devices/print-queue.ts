import type { PrintPayload } from "./types";

export type PrintJob = {
  id: string;
  payload: PrintPayload;
  attempts: number;
  /** Last failure message, shown to staff so a failed print is never invisible. */
  lastError?: string;
};

/**
 * In-memory print queue. A job leaves the queue only after the printer accepted it; failures keep it
 * pending and visible (`pending()`), so a printer fault never loses the order. Persistence of the queue
 * in the local store is added with the store implementation.
 */
export class PrintQueue {
  private jobs: PrintJob[] = [];

  constructor(private readonly send: (payload: PrintPayload) => Promise<void>) {}

  enqueue(id: string, payload: PrintPayload): void {
    this.jobs.push({ id, payload, attempts: 0 });
  }

  pending(): readonly PrintJob[] {
    return this.jobs;
  }

  /** Try jobs in order; stop at the first failure so print order is preserved. Returns jobs printed. */
  async flush(): Promise<number> {
    let printed = 0;
    while (this.jobs.length > 0) {
      const job = this.jobs[0]!;
      job.attempts++;
      try {
        await this.send(job.payload);
      } catch (e) {
        job.lastError = e instanceof Error ? e.message : String(e);
        return printed;
      }
      this.jobs.shift();
      printed++;
    }
    return printed;
  }
}
