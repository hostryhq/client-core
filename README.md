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
- `store/`: `LocalStore` interface (tenant-scoped, single-writer transactions, tombstones) and `InMemoryStore` for tests and browser runs. No SQLite yet (ADR-0007).
- `sync/`: ADR-0002 op envelope types and a `SyncClient` interface stub. No engine yet.
- `auth/`: ADR-0005 session/grant types, `AuthClient`/`PinLogin` interface stubs, and `can()` permission check. No keystore (ADR-0005 A1 is Proposed).
- `devices/`: `ReceiptPrinter`, `KitchenPrinter`, `LabelPrinter`, `Scale`, `BarcodeScanner`, `CashDrawer` interfaces, a fake for each, and `PrintQueue` (a failed print stays queued and visible).
- `printing/`: product-neutral printing (ADR-0014 R8). Document model (bill, pre-bill, KOT, credit note, Z-report) -> `layoutDocument` (48/32 columns from a `PrinterProfile`) -> `encodeOps` (ESC/POS: text, bold/size, align, cut, drawer kick, QR, GS v 0 raster) -> `PrintService` (per-printer `PrintQueue` with backoff/retry, 15-minute stale-KOT hold). Tamil/Malayalam item names go through a `TextRasterizer`; tests use `FakeTextCanvasFactory`, the app supplies `OffscreenTextCanvasFactory` plus a bundled font (no font is bundled here; see the licensing note in `raster.ts`). Transports (`ByteTransport`) are interfaces; `LanRawTcpTransport` (port 9100) is a stub until the shell supplies a `TcpConnector`. Golden dumps live in `src/printing/__golden__/`; after an intended output change review the diff and run `pnpm vitest run -u`.
- `ids.ts`: `uuidv7()` for client-generated IDs.

Generated types last synced from api-specs branch `feat/phase1-api-specs` (identity, tenancy).
