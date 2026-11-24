import { describe, expect, it } from "vitest";
import { uuidv7 } from "./ids";

describe("uuidv7", () => {
  const zeros = () => new Uint8Array(16);

  it("encodes the timestamp, version and variant", () => {
    const id = uuidv7(() => 0x0193a5f2c7b4, zeros);
    expect(id).toBe("0193a5f2-c7b4-7000-8000-000000000000");
  });

  it("sorts by time as text", () => {
    const a = uuidv7(() => 1_700_000_000_000);
    const b = uuidv7(() => 1_700_000_000_001);
    expect(a < b).toBe(true);
  });
});
