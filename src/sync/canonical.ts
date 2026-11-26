/**
 * Canonical JSON per RFC 8785 (JCS) for the integer-only subset the protocol uses (svc-sync
 * `syncproto.Canonicalize`): objects, arrays, strings, booleans, null and integers within +-(2^53-1).
 * Fractions and exponents are refused because money is paise and quantities are milli-units, which
 * keeps number formatting identical in every language. Object members sort by UTF-16 code units
 * (the JS default); `undefined` members are omitted.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error(`canonical json: ${value} is not a safe integer`);
      return JSON.stringify(value === 0 ? 0 : value); // "-0" is "0"
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical json: unsupported type ${typeof value}`);
  }
}
