import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as testing from "./testing";

const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as Record<string, unknown>;

describe("@hostry/client-core/testing entry", () => {
  it("exports the sync simulator, and the package publishes it", async () => {
    expect(typeof testing.FakeNode).toBe("function");
    expect(typeof testing.makeWorld).toBe("function");
    expect(typeof testing.authorBatch).toBe("function");
    expect(typeof testing.deliver).toBe("function");
    const w = await testing.makeWorld();
    expect((await w.addDevice("devA", { withHub: false })).engine).toBeDefined();
    const pkg = json("../package.json") as { exports: Record<string, { import: string; types: string }> };
    expect(pkg.exports["./testing"]).toEqual({ types: "./dist/testing.d.ts", import: "./dist/testing.js" });
    const build = json("../tsconfig.build.json") as { exclude: string[] };
    expect(build.exclude.some((e) => e.includes("testkit"))).toBe(false);
  });
});
