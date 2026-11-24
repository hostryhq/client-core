import createClient, { type Middleware } from "openapi-fetch";

export type ApiClientOptions = {
  /** Base URL of the service, e.g. the cloud gateway or the LAN hub. */
  baseUrl: string;
  /** Current access token, if any. Read per request so refreshes are picked up. */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /** Key for mutations that do not already carry `Idempotency-Key`. Defaults to crypto.randomUUID. */
  newIdempotencyKey?: () => string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Typed client over a generated `paths` type (from src/generated). Adds the bearer token and an
 * `Idempotency-Key` on mutations (api-contract-standard). Tenant is never sent: it comes from the token.
 *
 *   import type { paths } from "./generated/identity";
 *   const identity = createApiClient<paths>({ baseUrl, getAccessToken });
 */
export function createApiClient<Paths extends object>(options: ApiClientOptions) {
  const newKey = options.newIdempotencyKey ?? (() => crypto.randomUUID());

  const middleware: Middleware = {
    async onRequest({ request }) {
      const token = await options.getAccessToken?.();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      if (MUTATING.has(request.method) && !request.headers.has("Idempotency-Key")) {
        request.headers.set("Idempotency-Key", newKey());
      }
      return request;
    },
  };

  const client = createClient<Paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  client.use(middleware);
  return client;
}
