import type { BillDoc, CreditNoteDoc, KotDoc, PreBillDoc, ZReportDoc } from "./types";

/** Test fixtures: reference bill R1 from docs/design/restaurant-app-flows.md section 4. 13:05 IST = 07:35 UTC. */
export const BUSINESS = {
  name: "Anand Foods Pvt Ltd",
  addressLines: ["12 Main Road, Gudalur"],
  gstin: "33ABCDE1234F1Z5",
  fssai: "12345678901234",
};

export const DOSA = { en: "Masala Dosa", local: "மசாலா தோசை", script: "ta" as const };
export const COFFEE = { en: "Filter Coffee", local: "ஃபில்டர் காபி", script: "ta" as const };
export const DOSA_ML = { en: "Masala Dosa", local: "മസാല ദോശ", script: "ml" as const };
export const COFFEE_ML = { en: "Filter Coffee", local: "ഫിൽട്ടർ കാപ്പി", script: "ml" as const };

export function billR1(over: Partial<BillDoc> = {}): BillDoc {
  return {
    kind: "bill",
    variant: "tax_invoice",
    business: BUSINESS,
    number: "A07/2627/000123",
    issuedAt: "2026-11-24T07:35:00Z",
    tableLabel: "T6",
    orderType: "Dine-in",
    waiter: "Ravi",
    billLabel: "1",
    guest: { name: "Sea Foods Ltd", gstin: "33AAAAA0000A1Z5" },
    lines: [
      { name: { en: "Masala Dosa" }, qty: 3, rate: 8000, amount: 24000 },
      { name: { en: "Filter Coffee" }, qty: 2, rate: 3000, amount: 6000 },
    ],
    subtotal: 30000,
    taxGroups: [
      {
        rateLabel: "5%",
        taxable: 30000,
        taxes: [
          { label: "CGST 2.5%", amount: 750 },
          { label: "SGST 2.5%", amount: 750 },
        ],
      },
    ],
    total: 31500,
    tenders: [{ label: "Cash", amount: 40000 }],
    change: 8500,
    placeOfSupply: "Tamil Nadu",
    reverseCharge: false,
    cashier: "Asha",
    footer: "Thank you. Visit again.",
    ...over,
  };
}

export function billTamil(script: "ta" | "ml" = "ta"): BillDoc {
  const [d, c] = script === "ta" ? [DOSA, COFFEE] : [DOSA_ML, COFFEE_ML];
  return billR1({
    lines: [
      { name: d, qty: 3, rate: 8000, amount: 24000 },
      { name: c, qty: 2, rate: 3000, amount: 6000 },
    ],
  });
}

export function preBill(over: Partial<PreBillDoc> = {}): PreBillDoc {
  return {
    kind: "pre_bill",
    businessName: "Anand Bhavan",
    sequence: 1,
    presentedAt: "2026-11-24T07:34:00Z",
    tableLabel: "T6",
    waiter: "Ravi",
    lines: billR1().lines,
    subtotal: 30000,
    estimatedTaxes: [
      { label: "CGST 2.5%", amount: 750 },
      { label: "SGST 2.5%", amount: 750 },
    ],
    total: 31500,
    ...over,
  };
}

export function creditNote(over: Partial<CreditNoteDoc> = {}): CreditNoteDoc {
  return {
    kind: "credit_note",
    business: BUSINESS,
    number: "CN07/2627/000004",
    issuedAt: "2026-11-24T09:00:00Z",
    originalNumber: "A07/2627/000123",
    originalDate: "2026-11-24T07:35:00Z",
    lines: [{ name: { en: "Filter Coffee" }, qty: 1, rate: 3000, amount: 3000 }],
    taxGroups: [{ rateLabel: "5%", taxable: 3000, taxes: [{ label: "CGST 2.5%", amount: 75 }, { label: "SGST 2.5%", amount: 75 }] }],
    total: 3150,
    refundMode: "Cash",
    reason: "Wrong item",
    approvedBy: "Meena",
    ...over,
  };
}

export function kot(over: Partial<KotDoc> = {}): KotDoc {
  return {
    kind: "kot",
    variant: "original",
    station: "KITCHEN",
    tableLabel: "T6",
    orderType: "Dine-in",
    waiter: "Ravi",
    billLabel: "1",
    kotNumber: "K2-014",
    createdAt: "2026-11-24T07:32:00Z",
    lines: [
      { qty: 3, name: DOSA, modifiers: ["Less spicy"] },
      { qty: 2, name: COFFEE, modifiers: ["Sugar less"] },
      { qty: 1, name: { en: "Parotta", local: "பரோட்டா", script: "ta" }, variant: "Half", modifiers: ["+ Extra gravy"] },
    ],
    note: "Allergy - no peanuts",
    ...over,
  };
}

export function zReport(over: Partial<ZReportDoc> = {}): ZReportDoc {
  return {
    kind: "z_report",
    number: "Z/2026-11-24/A07",
    outletName: "Anand Bhavan - Main Road",
    businessDate: "2026-11-24",
    closedAt: "2026-11-24T18:10:00Z",
    closedBy: "Meena",
    rows: [
      { label: "Gross", amount: 4120000 },
      { label: "Discounts", amount: -124000 },
      { label: "Net", amount: 3996000 },
      { label: "Service charge", amount: 0 },
      { label: "CGST 2.5%", amount: 48000 },
      { label: "SGST 2.5%", amount: 48000 },
      { label: "Round-off", amount: -35 },
    ],
    total: 4091965,
    bills: 96,
    covers: 210,
    average: 42625,
    tenders: [
      { label: "Cash", amount: 2100000 },
      { label: "UPI", amount: 1750000 },
      { label: "Card", amount: 241965 },
    ],
    channels: [
      { label: "Dine-in", amount: 3100000 },
      { label: "Counter", amount: 800000 },
      { label: "Takeaway", amount: 191965 },
    ],
    control: { voids: 2, cancels: 3, comps: 1, refunds: 0, creditNotes: 1 },
    series: ["A07: A07/2627/000101 to 000196 (96)", "A08: open tail after 000041 (device revoked)"],
    variances: [{ label: "Asha", amount: -15000 }],
    unpaidCarried: 2,
    ...over,
  };
}
