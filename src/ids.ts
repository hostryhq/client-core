/**
 * Client-generated, time-sortable IDs (UUIDv7, RFC 9562) so offline devices can create records
 * without a server. `now` and `random` are injectable for deterministic tests.
 */
export function uuidv7(
  now: () => number = Date.now,
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): string {
  const b = random();
  const ms = now();
  // 48-bit big-endian millisecond timestamp. Divide (not shift): shifts truncate to 32 bits.
  for (let i = 5, t = ms; i >= 0; i--, t = Math.floor(t / 256)) b[i] = t % 256;
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
