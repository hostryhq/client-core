import type { Hlc } from "./types";

/** Largest value of the 16-bit counter. */
const MAX_COUNTER = 0xffff;
/** A remote stamp further ahead than this is never folded into the local clock (ADR-0002 S5: 10 minutes). */
export const MAX_FUTURE_MS = 10 * 60 * 1000;

export function packHlc(ms: number, counter: number): Hlc {
  return ms.toString(16).padStart(12, "0") + counter.toString(16).padStart(4, "0");
}

export function unpackHlc(h: Hlc): { ms: number; counter: number } {
  if (!/^[0-9a-f]{16}$/.test(h)) throw new Error(`invalid hlc: ${h}`);
  return { ms: parseInt(h.slice(0, 12), 16), counter: parseInt(h.slice(12), 16) };
}

/** Total order of stamps: HLC text order, ties broken on origin (ADR-0002 S5). Negative if a < b. */
export function compareStamp(aHlc: Hlc, aOrigin: string, bHlc: Hlc, bOrigin: string): number {
  if (aHlc !== bHlc) return aHlc < bHlc ? -1 : 1;
  if (aOrigin !== bOrigin) return aOrigin < bOrigin ? -1 : 1;
  return 0;
}

/**
 * Hybrid logical clock: 48-bit ms plus 16-bit counter. `now` is the device wall clock; `offsetMs` is the
 * persisted correction learned from the upstream handshake (cloud time over hub time over local time).
 * Stamps are strictly increasing on one clock, and never behind a remote stamp that was observed.
 */
export class HlcClock {
  private lastMs = 0;
  private lastCounter = 0;

  constructor(
    private readonly now: () => number,
    private offsetMs = 0,
    last?: Hlc,
  ) {
    if (last) this.restore(last);
  }

  private physical(): number {
    return this.now() + this.offsetMs;
  }

  restore(last: Hlc): void {
    const { ms, counter } = unpackHlc(last);
    if (ms > this.lastMs || (ms === this.lastMs && counter > this.lastCounter)) {
      this.lastMs = ms;
      this.lastCounter = counter;
    }
  }

  setOffset(offsetMs: number): void {
    this.offsetMs = offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  /** Stamp for a local event. */
  next(): Hlc {
    const p = this.physical();
    if (p > this.lastMs) {
      this.lastMs = p;
      this.lastCounter = 0;
    } else if (this.lastCounter >= MAX_COUNTER) {
      this.lastMs += 1;
      this.lastCounter = 0;
    } else {
      this.lastCounter += 1;
    }
    return packHlc(this.lastMs, this.lastCounter);
  }

  /** Fold in a stamp seen on a remote op, so later local stamps sort after it. Stamps too far ahead are ignored. */
  observe(remote: Hlc): void {
    const { ms, counter } = unpackHlc(remote);
    if (ms > this.physical() + MAX_FUTURE_MS) return;
    if (ms > this.lastMs || (ms === this.lastMs && counter > this.lastCounter)) {
      this.lastMs = ms;
      this.lastCounter = counter;
    }
  }

  last(): Hlc {
    return packHlc(this.lastMs, this.lastCounter);
  }
}
