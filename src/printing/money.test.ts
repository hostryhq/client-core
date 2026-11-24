import { describe, expect, it } from "vitest";
import { businessDate, formatPaise, formatQty, istDateTime } from "./money";

describe("money formatting (integer paise, Western digits)", () => {
  it("formats paise exactly, with Indian grouping and signs", () => {
    expect(formatPaise(0)).toBe("0.00");
    expect(formatPaise(5)).toBe("0.05");
    expect(formatPaise(31500)).toBe("315.00");
    expect(formatPaise(100000)).toBe("1,000.00");
    expect(formatPaise(10000000)).toBe("1,00,000.00");
    expect(formatPaise(123456789)).toBe("12,34,567.89");
    expect(formatPaise(-3000)).toBe("-30.00");
    expect(formatPaise(4, { sign: true })).toBe("+0.04");
    expect(formatPaise(0, { sign: true })).toBe("0.00");
  });

  it("rejects floats and unsafe integers instead of rounding silently", () => {
    expect(() => formatPaise(10.5)).toThrow();
    expect(() => formatPaise(Number.NaN)).toThrow();
    expect(() => formatPaise(2 ** 60)).toThrow();
  });

  it("quantities keep up to 3 decimals", () => {
    expect(formatQty(3)).toBe("3");
    expect(formatQty(0.5)).toBe("0.5");
    expect(formatQty(1.25)).toBe("1.25");
    expect(formatQty(0.1 + 0.2)).toBe("0.3");
  });

  it("UTC to IST, including crossing midnight; business dates are not shifted", () => {
    expect(istDateTime("2026-11-24T07:35:00Z")).toBe("24-11-2026 13:05");
    expect(istDateTime("2026-11-24T19:00:00Z")).toBe("25-11-2026 00:30");
    expect(businessDate("2026-11-24")).toBe("24-11-2026");
  });
});
