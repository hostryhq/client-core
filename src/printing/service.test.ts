import { describe, expect, it } from "vitest";
import { billR1, kot } from "./fixtures";
import { GENERIC_80 } from "./profiles";
import { disassemble } from "./testing";
import { KOT_STALE_AFTER_MS, PrintService } from "./service";
import { LanRawTcpTransport, printerFromTransport, TransportUnavailableError } from "./transport";

const T0 = Date.parse("2026-11-24T07:32:00Z"); // = kot().createdAt

function setup(nowMs: number) {
  let now = nowMs;
  const sent: Uint8Array[] = [];
  let failing = false;
  const svc = new PrintService({ now: () => now });
  svc.addPrinter("kitchen", GENERIC_80, async (b) => {
    if (failing) throw new Error("printer offline");
    sent.push(b);
  });
  return {
    svc,
    sent,
    setNow: (n: number) => (now = n),
    setFailing: (f: boolean) => (failing = f),
  };
}

describe("PrintService: stale KOT rule (ADR-0014 A1.6)", () => {
  it("prints a fresh KOT", async () => {
    const s = setup(T0 + 60_000);
    expect(s.svc.print("kitchen", kot(), { jobId: "k1" })).toBe("queued");
    expect(await s.svc.flush()).toBe(1);
    expect(disassemble(s.sent[0]!)).toContain("KOT K2-014");
  });

  it("holds a KOT older than 15 minutes when it arrives; lists it; never prints it by itself", async () => {
    const s = setup(T0 + KOT_STALE_AFTER_MS + 1);
    expect(s.svc.print("kitchen", kot(), { jobId: "k1" })).toBe("late");
    expect(await s.svc.flush()).toBe(0);
    expect(s.sent).toHaveLength(0);
    expect(s.svc.lateTickets()).toMatchObject([{ id: "k1", reason: "stale", ageMinutes: 15 }]);
  });

  it("exactly 15 minutes old still prints; one millisecond over is held", () => {
    expect(setup(T0 + KOT_STALE_AFTER_MS).svc.print("kitchen", kot(), { jobId: "a" })).toBe("queued");
    expect(setup(T0 + KOT_STALE_AFTER_MS + 1).svc.print("kitchen", kot(), { jobId: "a" })).toBe("late");
  });

  it("holds a KOT handed over by hand however fresh it is", () => {
    const s = setup(T0 + 1000);
    expect(s.svc.print("kitchen", kot({ handedOver: true }), { jobId: "k1" })).toBe("late");
    expect(s.svc.lateTickets()[0]?.reason).toBe("handover");
  });

  it("a person can print a held ticket: it prints once, marked LATE with its age", async () => {
    const s = setup(T0 + 31 * 60_000);
    s.svc.print("kitchen", kot(), { jobId: "k1" });
    expect(s.svc.printLate("k1")).toBe(true);
    expect(s.svc.printLate("k1")).toBe(false);
    await s.svc.flush();
    expect(s.sent).toHaveLength(1);
    expect(disassemble(s.sent[0]!)).toMatch(/LATE - NOT AN ORIGINAL[\s\S]*31 min old/);
    expect(s.svc.lateTickets()).toEqual([]);
  });

  it("dismissing a held ticket removes it for good, even if sync delivers the same KOT again", async () => {
    const s = setup(T0 + 40 * 60_000);
    s.svc.print("kitchen", kot(), { jobId: "k1" });
    expect(s.svc.dismissLate("k1")).toBe(true);
    expect(s.svc.print("kitchen", kot(), { jobId: "k1" })).toBe("already_handled");
    expect(await s.svc.flush()).toBe(0);
    expect(s.svc.lateTickets()).toEqual([]);
  });

  it("a manual reprint (duplicate) of an old KOT prints; the rule covers automatic prints only", async () => {
    const s = setup(T0 + 3 * 3600_000);
    expect(s.svc.print("kitchen", kot({ variant: "duplicate", reprintedAt: "2026-11-24T10:32:00Z" }), { jobId: "d1", trigger: "manual" })).toBe("queued");
    expect(await s.svc.flush()).toBe(1);
  });

  it("does not apply the stale rule to bills or reports", () => {
    const s = setup(T0 + 24 * 3600_000);
    expect(s.svc.print("kitchen", billR1(), { jobId: "b1" })).toBe("queued");
  });
});

describe("PrintService: retry and no double print", () => {
  it("a job for a printer that is down stays queued and visible, then prints in order after recovery", async () => {
    const s = setup(T0 + 1000);
    s.setFailing(true);
    s.svc.print("kitchen", kot({ kotNumber: "K1" }), { jobId: "k1" });
    s.svc.print("kitchen", kot({ kotNumber: "K2" }), { jobId: "k2" });
    expect(await s.svc.flush()).toBe(0);
    const q = s.svc.queue("kitchen");
    expect(q.pending().map((j) => j.id)).toEqual(["k1", "k2"]);
    expect(q.pending()[0]?.lastError).toMatch(/offline/);
    s.setFailing(false);
    s.setNow(T0 + 120_000); // past the backoff
    expect(await s.svc.flush()).toBe(2);
    expect(s.sent.map((b) => /K[12]/.exec(disassemble(b))![0])).toEqual(["K1", "K2"]);
  });

  it("backs off between attempts and does not hammer a dead printer", async () => {
    const s = setup(T0 + 1000);
    s.setFailing(true);
    s.svc.print("kitchen", kot(), { jobId: "k1" });
    await s.svc.flush();
    const attempts = () => s.svc.queue("kitchen").pending()[0]!.attempts;
    expect(attempts()).toBe(1);
    await s.svc.flush(); // same instant: still backing off
    expect(attempts()).toBe(1);
    s.setNow(T0 + 1000 + 60_000);
    await s.svc.flush();
    expect(attempts()).toBe(2);
  });

  it("the same job id re-delivered by sync prints once", async () => {
    const s = setup(T0 + 1000);
    expect(s.svc.print("kitchen", kot(), { jobId: "k1" })).toBe("queued");
    expect(s.svc.print("kitchen", kot(), { jobId: "k1" })).toBe("already_handled");
    await s.svc.flush();
    expect(s.svc.print("kitchen", kot(), { jobId: "k1" })).toBe("already_handled");
    expect(s.sent).toHaveLength(1);
  });

  it("an unknown printer is an error, not a silent drop", () => {
    expect(() => setup(T0).svc.print("nope", kot(), { jobId: "x" })).toThrow(/unknown printer/);
  });
});

describe("LAN raw TCP transport stub", () => {
  it("without a connector it is offline and rejects sends, so jobs stay queued", async () => {
    const t = new LanRawTcpTransport("192.168.1.50");
    expect(t.port).toBe(9100);
    expect(await t.status()).toBe("offline");
    await expect(t.send(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it("with a connector it connects per job, writes, and always closes", async () => {
    const log: string[] = [];
    const t = new LanRawTcpTransport("10.0.0.9", 9100, async (h, p) => ({
      write: async (b) => void log.push(`write ${h}:${p} ${b.length}`),
      close: async () => void log.push("close"),
    }));
    await printerFromTransport(t).print(new Uint8Array([1, 2, 3]));
    expect(log).toEqual(["write 10.0.0.9:9100 3", "close"]);
  });
});
