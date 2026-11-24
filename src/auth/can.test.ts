import { describe, expect, it } from "vitest";
import { can } from "./can";

const future = "2026-12-01T00:00:00Z";
const now = new Date("2026-11-24T00:00:00Z");

describe("can", () => {
  const cashier = {
    expiresAt: future,
    grants: [{ outlets: ["o1"], perms: ["order.create", "bill.finalize"] }],
  };

  it("allows a granted permission at a granted outlet only", () => {
    expect(can(cashier, "order.create", "o1", now)).toBe(true);
    expect(can(cashier, "order.create", "o2", now)).toBe(false);
  });

  it("denies permissions that were not granted", () => {
    expect(can(cashier, "bill.void", "o1", now)).toBe(false);
  });

  it("a tenant-wide check needs an all-outlets grant", () => {
    expect(can(cashier, "order.create", undefined, now)).toBe(false);
    const manager = { expiresAt: future, grants: [{ outlets: ["*"], perms: ["report.view"] }] };
    expect(can(manager, "report.view", undefined, now)).toBe(true);
  });

  it("owner wildcard matches everything; partial wildcards match nothing", () => {
    const owner = { expiresAt: future, grants: [{ outlets: ["*"], perms: ["*"] }] };
    expect(can(owner, "bill.void", "o9", now)).toBe(true);
    const partial = { expiresAt: future, grants: [{ outlets: ["*"], perms: ["bill.*"] }] };
    expect(can(partial, "bill.void", "o1", now)).toBe(false);
  });

  it("denies when signed out or the session has expired", () => {
    expect(can(undefined, "order.create", "o1", now)).toBe(false);
    expect(can({ ...cashier, expiresAt: "2026-11-23T00:00:00Z" }, "order.create", "o1", now)).toBe(false);
  });
});
