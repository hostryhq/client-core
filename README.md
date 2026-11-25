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
- `printing/`: product-neutral printing (ADR-0014 R8). Document model (bill, pre-bill, KOT, credit note, Z-report) -> `layoutDocument` (48/32 columns from a `PrinterProfile`) -> `encodeOps` (ESC/POS: text, bold/size, align, cut, drawer kick, QR, GS v 0 raster) -> `PrintService` (per-printer `PrintQueue` with backoff/retry, 15-minute stale-KOT hold). Tamil/Malayalam item names go through a `TextRasterizer`; tests use `FakeTextCanvasFactory`, the app supplies `OffscreenTextCanvasFactory` plus a bundled font (no font is bundled here; see the licensing note in `raster.ts`). Transports (`ByteTransport`) are interfaces; `LanRawTcpTransport` (port 9100) is a stub until the shell supplies a `TcpConnector`. Golden dumps live in `src/printing/__golden__/`; after an intended output change review the diff and run `pnpm vitest run -u`.
- `tax/`: calc_v 1 tax engine (api-specs `tax/README.md`): `calculateBill`, `calculateCredit` (integers: paise, milli-units, basis points; BigInt inside the multiply-divide steps), rule-set loader/validator (`loadRuleSet`, `resolveRules`, `ruleSetInForce`). Must reproduce every vector in `__vectors__/vectors.v1.json` (`pnpm test`; refresh with `node scripts/sync-tax-vectors.mjs`). Changing the calculation is a new `calc_v` and a new vector file, never an edit.
- `catalog/`: menu read model (`Menu`: variants, modifiers with group bounds, tax-class and station resolution, order-line snapshot) and KOT routing per station (`routeToStations`, `toKotDoc`). Product-neutral rows (snake_case, as on the wire).
- `documents/`: trading documents. `finalizeBill` (bill.finalize), `presentCheck` (unnumbered pre-bill), `manualBookEntry`, `issueCreditNote`, `rebill`, business-day helpers, `toBillDoc`/`toPreBillDoc`/`toCreditNoteDoc` (to the printing model), `billMutations` (sync op mutations). Numbers come from a `DocumentNumberAllocator` interface; wire the sync engine's `allocateNumber` with `allocatorFromFn` inside the op's transaction. `MemorySeriesAllocator` (testing.ts) is the fake.
- `ids.ts`: `uuidv7()` for client-generated IDs.

Generated types last synced from api-specs branch `feat/phase1-api-specs` (identity, tenancy; phase 2: admin, billing, catalog, orders from `feat/phase2-specs`).
