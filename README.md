# client-core

Shared non-UI client TypeScript: generated API types and a typed client, local store, sync client, auth/session, device adapters. Runs in the native shell, a browser and headless Node. Apps depend on the interfaces here, never on a concrete store or device.

## Run

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Layout (`src/`)

- `generated/`: openapi-typescript output copied from `api-specs`; never hand-edited, regenerate instead (committed so CI needs no sibling repo).
  `pnpm gen:api` runs `scripts/sync-api-types.mjs`: copies `api-specs/gen/ts/*.d.ts` (path: `API_SPECS_DIR`, default `../api-specs`) and writes `generated/index.ts`; `--generate` first runs `make generate-ts` in api-specs.
- `api/`: `createApiClient<paths>()` over `openapi-fetch` (bearer token, `Idempotency-Key` on mutations, tenant never sent).
- `store/`: `LocalStore` interface (tenant-scoped, single-writer transactions, tombstones), copy-on-write `InMemoryStore`, and `IndexedDbPersistence` for browser durability (`InMemoryStore.open(tenant, await IndexedDbPersistence.open(name))`). No SQLite yet (ADR-0007).
- `sync/`: the Phase 1 sync client (ADR-0002): HLC, op log and outbox, apply with per-entity conflict policies, document numbers, hash chain and seals, restore epoch and re-offer, own-op read-back, status observable (`synced` / `pending` / `offline` / `conflict`), HTTP transport and runner. `SyncEngine.record()` is the only write path an app uses; it commits locally and returns. See `docs/sync-poc-notes.md` for the module map, wire alignment with `svc-sync`, choices, gaps and test inventory. `sync/testkit/` is test support and is not built.
- `auth/`: ADR-0005 session/grant types, `AuthClient`/`PinLogin` interface stubs, and `can()` permission check. No keystore (ADR-0005 A1 is Proposed).
- `devices/`: `ReceiptPrinter`, `KitchenPrinter`, `LabelPrinter`, `Scale`, `BarcodeScanner`, `CashDrawer` interfaces, a fake for each, and `PrintQueue` (a failed print stays queued and visible).
- `ids.ts`: `uuidv7()` for client-generated IDs.

Generated types last synced from api-specs branch `feat/phase1-api-specs` (identity, tenancy).
