# Phase 2 integration notes

`feat/phase2-integration` = `feat/phase2-domain` (tax, catalog, documents, printing) merged with `feat/phase1-sync` (engine, runner, transport).
One merge conflict, in `tsconfig.build.json` (both sides excluded test-only files from the build): resolved by keeping every exclusion.

## What the integration adds (`src/ops`, `src/sync`)

| Need (from app-restaurant `docs/integration-notes.md`) | Where |
|---|---|
| Documents take numbers from the engine's series allocator | `allocatorForOp(ctx)` wraps `BuildCtx.number`; every builder in `ops/documents.ts` runs the document function inside the op's build step, so the number commits with the op or not at all |
| One op, several legal numbers (`bill.rebill`) | `SyncEngine.record` no longer throws on a second `number()` call. `OpEnvelope.doc` is the first number; `OpEnvelope.docs` lists all of them when there are two or more (absent otherwise, so existing ops and the Go conformance vectors are byte-identical) |
| Mixed per-field policy (`check`, `order_line`) | `EntitySchema.policy: "mixed"` with `fields` (`immutable`, `lww`, `lww_review`, `rank`, `delta`), applied in `sync/apply.ts`; schemas are generated from `api-specs/entities/restaurant` into `sync/restaurant.generated.ts` (`restaurantRegistry()`) |
| Intent to op builder | `ops/documents.ts` (`finalizeBillSpec`, `manualEntrySpec`, `creditNoteSpec`, `rebillSpec`, `presentSpec`, `paymentSpec`), `ops/catalog.ts` (`availabilitySpec`, `priceSetSpec`, `orderLineAddSpec`, `orderLineQtySpec`); the intent registry is generated into `ops/intents.generated.ts` |
| `OpWriter` / `SyncPort` | `ops/ports.ts`; `EngineOpWriter(engine, { streams })` and `createSyncPort(runner, engine)` |

`EngineOpWriter` checks every op against its intent before it is recorded: entities, mutation kinds, fields of the entity contract, and which document types it may number. A violation throws `IntentError` and rolls the transaction back (no number is burnt).

Regenerate after an `api-specs` change: `python3 -I scripts/gen-sync-registry.py ../api-specs` (needs PyYAML; generator only). The two `*.generated.ts` files carry the api-specs commit.

## Names app-restaurant coded to

Same names, same shapes: `OpWriter`, `RecordedOp`, `SeriesDocType`, `Delivery`, `SyncView`, `SyncPort`, `BuildCtx`, `RecordSpec` (the last two are the engine's own). Differences, all additive:

- `RecordedOp.docs` (all numbers of a re-bill); the app's `LocalOpWriter` records only the first.
- `SyncPort.delivery(seq)` (the app reads delivery from its sim's op row; the real source is `engine.delivery(seq)`).
- `SyncView` is the engine's `SyncStatus`: it has `atHubOps`, `upstream`, `state`, `clockWrong` and also `attentionOps`, `checkingOps`, `keyLost`.
- `RecordSpec` has `stream`, `actor`, `sid`, `proof`; the writer picks the stream from the intent (outlet stream by default; `streams.brand` / `streams.tenant` for the others). Set `engine.session` after sign-in.
- The engine's `record` returns the `OpEnvelope`; `EngineOpWriter.record` returns it typed as `RecordedOp`.

## Mixed-policy semantics

Immutable fields come from the insert (a second insert of one id keeps the lower stamp). `lww` and `lww_review` fields keep candidates by `(hlc, origin)`; a review field carries `prev` and a concurrent edit raises a conflict row as for an lww entity. `rank` fields only move forward (also for `k: "rank"`). `delta` fields add. The field policy decides, the mutation kind says what the writer meant; a field that does not accept the kind, or is not in the contract, is ignored (invariant 8). A mixed row has no tombstone. Field groups in the entity files are not used yet: each field has its own stamp, as in the lww entities.

## Open items (need a ruling or another repo)

1. `ADR needed: op envelope with several document numbers`. `docs` is client-core's provisional encoding. `svc-sync` `syncproto.Op` and the gateway's series register read only `doc`, so until they read `docs` a re-bill's replacement numbers look like gaps to the register. Also `sync/protocol-v1.md` and a conformance vector.
2. `ADR needed: shape of the op's `pii` object`. Bill and check carry `customer_name` / `customer_phone` as pii fields; the builders write them into the op body today. Moving them into `pii` means local rows lose them unless the engine keeps a local side table.
3. `op_too_large` (256 KiB body, ADR-0014 A2.1 item 3) is not enforced before recording.
4. `restaurantRegistry()` carries the restaurant entities only; hospitality and the other apps add theirs.
5. The harness `reopen` rebuilds a device with the demo registry; the new tests do not reopen.
