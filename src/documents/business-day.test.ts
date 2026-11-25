import { describe, expect, it } from "vitest";
import { businessDayId, dateToOpen, financialYearOfDate, istDateOf, nextDate, stampingDate } from "./business-day";
import { parseDocumentNumber } from "./numbering";
import { uuidv5 } from "./uuid5";

describe("uuidv5", () => {
  it("matches the RFC 9562 test vector (DNS namespace, www.example.com)", () => {
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
  it("is deterministic and keyed by business key", () => {
    expect(businessDayId("o1", "2026-11-24")).toBe(businessDayId("o1", "2026-11-24"));
    expect(businessDayId("o1", "2026-11-24")).not.toBe(businessDayId("o2", "2026-11-24"));
    expect(businessDayId("o1", "2026-11-24")).not.toBe(businessDayId("o1", "2026-11-25"));
  });
});

describe("business day (ADR-0014 A1.1)", () => {
  it("IST date of an instant crosses midnight at 18:30 UTC", () => {
    expect(istDateOf(Date.parse("2026-11-24T18:29:59Z"))).toBe("2026-11-24");
    expect(istDateOf(Date.parse("2026-11-24T18:30:00Z"))).toBe("2026-11-25");
  });
  it("opens today, never a closed date: close at 23:00, next guest at 23:30 opens the next date; a skewed clock cannot reopen a closed date", () => {
    const now = Date.parse("2026-11-24T18:00:00Z"); // 23:30 IST on the 24th
    expect(dateToOpen([], now)).toBe("2026-11-24");
    expect(dateToOpen([{ business_date: "2026-11-24", status: "closed" }], now)).toBe("2026-11-25");
    expect(dateToOpen([{ business_date: "2026-11-30", status: "closed" }], now)).toBe("2026-12-01");
  });
  it("opens nothing while a day is open", () => {
    expect(dateToOpen([{ business_date: "2026-11-24", status: "open" }], Date.now())).toBeUndefined();
  });
  it("stamps the open day with the latest date, ignoring closed days", () => {
    expect(stampingDate([{ business_date: "2026-11-23", status: "open" }, { business_date: "2026-11-24", status: "open" }, { business_date: "2026-11-25", status: "closed" }])).toBe("2026-11-24");
    expect(stampingDate([{ business_date: "2026-11-25", status: "closed" }])).toBeUndefined();
  });
  it("next date handles month and year ends; financial year turns on 1 April", () => {
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
    expect(nextDate("2028-02-28")).toBe("2028-02-29");
    expect([financialYearOfDate("2027-03-31"), financialYearOfDate("2027-04-01"), financialYearOfDate("2026-11-24")]).toEqual(["2627", "2728", "2627"]);
  });
  it("parses legal numbers", () => {
    expect(parseDocumentNumber("A07/2627/000123")).toMatchObject({ seriesCode: "A07", financialYear: "2627", running: 123 });
    expect(() => parseDocumentNumber("A07-2627-1")).toThrow();
  });
});
