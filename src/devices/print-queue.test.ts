import { describe, expect, it } from "vitest";
import { FakeReceiptPrinter } from "./fakes";
import { PrintQueue, type PrintJob } from "./print-queue";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("PrintQueue", () => {
  it("keeps a job when the printer fails and prints it in order after recovery", async () => {
    const printer = new FakeReceiptPrinter();
    const q = new PrintQueue((p) => printer.print(p));
    q.enqueue("a", bytes(1));
    q.enqueue("b", bytes(2));

    printer.failWith = "paper_out";
    expect(await q.flush()).toBe(0);
    expect(q.pending().map((j) => j.id)).toEqual(["a", "b"]);
    expect(q.pending()[0]?.lastError).toMatch(/paper_out/);

    printer.failWith = undefined;
    expect(await q.flush()).toBe(2);
    expect(q.pending()).toEqual([]);
    expect(printer.printed).toEqual([bytes(1), bytes(2)]);
  });
});

describe("PrintQueue retry policy", () => {
  it("backs off after a failure and resumes when the delay has passed", async () => {
    let now = 1000;
    let fail = true;
    const sent: number[] = [];
    const q = new PrintQueue(
      async (p) => {
        if (fail) throw new Error("down");
        sent.push(p[0]!);
      },
      { now: () => now, backoffMs: () => 5000 },
    );
    q.enqueue("a", bytes(1));
    await q.flush();
    expect(q.pending()[0]?.attempts).toBe(1);
    await q.flush();
    expect(q.pending()[0]?.attempts).toBe(1); // still backing off
    expect(q.nextAttemptAt()).toBe(6000);
    fail = false;
    now = 6000;
    expect(await q.flush()).toBe(1);
    expect(sent).toEqual([1]);
  });

  it("after maxAttempts a job is marked failed but stays listed, does not block later jobs, and can be retried", async () => {
    let failA = true;
    const sent: number[] = [];
    const q = new PrintQueue(
      async (p) => {
        if (p[0] === 1 && failA) throw new Error("jam");
        sent.push(p[0]!);
      },
      { maxAttempts: 2 },
    );
    q.enqueue("a", bytes(1));
    q.enqueue("b", bytes(2));
    expect(await q.flush()).toBe(0); // a attempt 1 fails, holds b
    expect(await q.flush()).toBe(1); // a attempt 2 fails -> failed; b prints
    expect(q.pending().map((j) => [j.id, j.status])).toEqual([["a", "failed"]]);
    failA = false;
    expect(q.retry("a")).toBe(true);
    expect(await q.flush()).toBe(1);
    expect(sent).toEqual([2, 1]);
    expect(q.pending()).toEqual([]);
  });

  it("reports every change so the queue can be persisted and restored", async () => {
    let saved: PrintJob[] = [];
    let last = -1;
    const q = new PrintQueue(async () => {}, {
      onChange: (j) => {
        saved = j.map((x) => ({ ...x }));
        last = j.length;
      },
    });
    q.enqueue("a", bytes(1), "kot");
    expect(saved[0]).toMatchObject({ id: "a", kind: "kot", status: "pending" });
    const q2 = new PrintQueue(async () => {});
    q2.restore(saved);
    expect(q2.has("a")).toBe(true);
    await q.flush();
    expect(last).toBe(0);
  });
});
