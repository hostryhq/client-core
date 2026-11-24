import { describe, expect, it } from "vitest";
import { createApiClient } from "./client";
import type { IdentityPaths } from "./index";

function fakeFetch(seen: Request[]): typeof fetch {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    seen.push(req);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("createApiClient", () => {
  it("adds bearer token and an idempotency key on mutations only", async () => {
    const seen: Request[] = [];
    const api = createApiClient<IdentityPaths>({
      baseUrl: "http://hub.local",
      getAccessToken: () => "tok-1",
      newIdempotencyKey: () => "key-1",
      fetch: fakeFetch(seen),
    });

    await api.GET("/v1/devices");
    await api.POST("/v1/otp-challenges", {} as never);

    const [get, post] = seen;
    expect(get?.headers.get("Authorization")).toBe("Bearer tok-1");
    expect(get?.headers.has("Idempotency-Key")).toBe(false);
    expect(post?.headers.get("Idempotency-Key")).toBe("key-1");
  });

  it("sends no Authorization header when signed out", async () => {
    const seen: Request[] = [];
    const api = createApiClient<IdentityPaths>({ baseUrl: "http://x", fetch: fakeFetch(seen) });
    await api.GET("/v1/devices");
    expect(seen[0]?.headers.has("Authorization")).toBe(false);
  });
});
