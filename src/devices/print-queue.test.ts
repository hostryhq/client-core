import { describe, expect, it } from "vitest";
import { FakeReceiptPrinter } from "./fakes";
import { PrintQueue } from "./print-queue";

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
