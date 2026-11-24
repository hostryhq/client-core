# Sync client: proof-of-concept notes (ADR-0002, roadmap item 1e, client side)

Status: Phase 1 proof of concept. Written against ADR-0002 with Amendment A1 (Proposed) applied provisionally, and against the Go wire format in `svc-sync/syncproto` as of 2026-11-24. Nothing here is a decision of record; where the ADR was silent or inconsistent the conservative choice is listed under "Choices".

## Modules (`src/sync/`)

| File | What it does |
|---|---|
| `hlc.ts` | Hybrid logical clock (48-bit ms + 16-bit counter, 16 hex chars), persisted upstream offset, refusal to fold in stamps more than 10 minutes ahead |
| `canonical.ts` | RFC 8785 canonical JSON for the integer-only subset (same bytes as Go `syncproto.Canonicalize`, checked against golden vectors in `wire.test.ts`) |
| `crypto.ts` | SHA-256, genesis hash, seal and attestation messages, `Signer` interface, `SoftwareSigner` (ES256 via WebCrypto), `KeyRing` (public keys by origin and kid, fed from identity-signed credentials) |
| `schema.ts` | Conflict policy declared per entity (`append`, `lww`, `rank`, `delta`, review fields, deletable) and the demo entities that exercise every policy |
| `apply.ts` | The generic apply engine: per-policy mechanics, lww candidates, void set, concurrent-edit detection for review fields |
| `series.ts` | Legal document numbers: grants from the pack, `<code>/<FY>/<running>` (15 chars), IST financial year, allocated inside the op's transaction |
| `engine.ts` | `SyncEngine`: `record` (local-first write: seq, ph, hlc, doc number, op, row changes in one single-writer transaction), `applyRemote` (chain + seal verification, exactly-once apply, placeholders, void, clock quarantine), outbox, seals (per push and every 5 min), vectors, delivery state, epoch / re-offer, own-op read-back, status observable, key-lost state and recovery upload |
| `detectors.ts` | Derived queries for `guarded` data: overpayment, duplicate finalisation |
| `transport.ts` | Wire types (mirror of `syncproto`), `HttpTransport` (JSON over fetch), `bearerAuth` (cloud), `lanAuth` (device assertion and verification of the hub's proof), vector conversion |
| `runner.ts` | `SyncRunner` (`SyncClient`): hub first, cloud on failover (3 tries or 10 s), probe the hub every 15 s, hello / push / pull, resume by vector, jittered backoff, status |
| `testkit/` | Test support only (excluded from the build): `FakeNode` (gateway/hub double with chain and seal verification, hold, void, release, cloud emit, rollback, fault injection), `harness.ts` (world of devices, hub, cloud), `scenario.ts` (seeded simulation) |
| `../store/memory.ts`, `../store/indexeddb.ts` | `InMemoryStore` is now copy-on-write (cost proportional to what a transaction touches) and takes an optional `Persistence`; `IndexedDbPersistence` is the browser persistence |

Internal tables live in the `LocalStore` under `_s_*` entity names; underscore-prefixed fields on domain rows are internal and stripped by `visible()` / `engine.rows()`.

## Wire format

Taken from `svc-sync/syncproto` (the Go side owns it): item = `{origin, stream, seq, h, body, pii}` with `body` the canonical JSON text hashed as sent; vectors flat `origin/stream`; `hello`, `push`, `pull` shapes; genesis hash `sha256("hostry-genesis-v1\n" + origin + "\n" + stream)`; seal message `hostry-seal-v1\n...`; ES256 raw r||s, public keys as X9.62 points; LAN assertion headers `Hostry-Device-Assertion` / `Hostry-Hub-Proof`. The TypeScript encoder gives the same body bytes, hash, genesis hash and seal message as the Go one (golden vectors in `src/sync/wire.test.ts`). `api-specs/sync/conformance/` should replace them.

Assumed where `syncproto` does not say yet (please confirm or correct):
1. A `sync.void` op is `intent: "sync.void"` from an origin `cloud-<epoch>` with one mutation `{e: "sync_void", id: "<stream>|<origin>|<seq>", k: "insert", f: {origin, stream, seq, reason: "refused"}}`.
2. Paths are `POST /sync/v1/hello|push|pull` with JSON bodies (no NDJSON/gzip yet).
3. The gateway op-signing key reaches the client as a public key keyed by `kid` (`KeyRing.addCloudKey`); how it travels in the pack is not defined.
4. The hub's `cloud_vector` in `hello` is taken as the cloud's confirmation for the device's ops (delivery state `in_cloud` through a hub).
5. `snapshot_required` in `hello` is not acted on: the snapshot bootstrap client is not built.

## Choices (conservative, no ADR needed unless the founder objects)

- **Field group = one field.** Each lww field has its own stamp and candidates. `prev` is keyed by field name. The ADR allows grouped fields; the generated registry can add groups later.
- **Concurrent edit of a review field** = two candidates of one field whose `prev` stamps are present and equal (both writers started from the same value). The later stamp wins, the earlier value is kept in a `_s_conflict` row and listed by `engine.conflicts()` until a manager confirms (`confirmConflict`, an append `conflict_ack`). Edits without `prev` are never flagged. Review-field candidates are not trimmed, so every node sees the same pairs whatever the arrival order (found by the simulation: trimming made the conflict list node-dependent).
- **Candidate trimming** for other fields drops a confirmed candidate once a higher confirmed one exists. "Confirmed" is conservative: covered by the cloud vector and not in the held list.
- **Append duplicates**: a second insert of one id from a different op keeps the lower stamp on every node (the ADR says no-op; this keeps even that bug case convergent).
- **Series code shape**: the client checks only `^[A-Z0-9]{3}$`. ADR-0002 S7 says the registry's alphabet excludes `I O 0 1` but its own example `A07/2627/000123` contains a `0`. The registry is the authority; the ADR text should be corrected.
- **Grants are replaced, not merged**, by each pack (`setSeriesGrants`), so a device that adopts a kept database (A1.3) can never number in its predecessor's series. The chain head is per origin: an adopting device starts its own chain. Both bugs were found by the key-loss test.
- **Clock**: an lww op stamped `clk: manual` or more than 10 minutes ahead of the receiver is stored and held (`clockQuarantine()`), not applied; append and delta ops always apply. Banner flag `clockWrong` above 2 minutes of skew.
- **Seals** are stored for every origin forever in the PoC (no compaction, S14 retention not built). Relayed runs end on a stored seal boundary.
- **State hash** (`stateHash()`) covers the visible rows of every declared entity. It is not byte-compatible with the Go simulator's hash; parity needs the shared conformance vectors.
- **Attestation** is signed over origin, stream, seq, h, by and rec as in `syncproto.AttestationMessage`.
- **Hub proof** (`Hostry-Hub-Proof`) is verified by `lanAuth`; a missing or forged proof is a non-retriable transport error.

## A1 applied provisionally

- A1.2 read-back: the device learns only `pending`, `held_manager`, `held_support` (push response `held`, pull `own_held`, via a hub from the hub's relayed list) and `refused` (a `sync.void` naming its op). `SyncStatus` has no flag, proof or attribution field; a test asserts it. Placeholders are stored, advance the vector, are named in the next pull and applied when released (checked against the held hash).
- A1.3 key loss: `engine.keyLost` freezes `record` (`KeyLostError`), `sealIfDue` keeps the unsealed tail to at most the seal interval, `recoveryUpload` builds the old origin's unconfirmed ops, stored seals and a new-key attestation. The upload itself (recovery drain token, `quarantine-upload`) is not wired into the runner.
- A1.1 (foreign series verdict) is a gateway and hub check; the client only guarantees that it never numbers outside its own grants.

## Not built (deliberately, for this PoC)

Snapshot bootstrap and eviction/compaction (S14); WebSocket poke and mDNS/QR discovery (shell); the SQLite adapter (no Rust or native shell here; `IndexedDbPersistence` plus the in-memory working set stands in, and an OPFS SQLite adapter, official sqlite-wasm with the `opfs-sahpool` VFS per the r16 notes, would implement the same `Persistence`/`LocalStore` seam); NDJSON + gzip framing; the quarantine-upload client; upcasters (S13); per-device `pii` erasure side table (client keeps `pii` beside the op, outside the hash).

## Measurements (Node 22, in-memory store, this machine; baselines, not budgets)

- Op size: 420 bytes JSON for a small order insert, 649 for a bill finalisation with a stock delta; about 527 wire bytes per item on average, uncompressed (10,000 ops a day is about 5 MB before compression, matching the ADR's assumption).
- Local write (`record`, includes hashing, apply and the transaction): about 0.5 ms per op.
- Apply of a pulled batch (hash, chain check, one seal verification, apply): about 2,700 ops per second.
- Keystore signature latency, order to KDS latency, hub memory and gateway ingest need the reference Android device, a LAN and the Go binaries: not measured here.

## Tests

`pnpm test` runs everything below (about 40 s). `SYNC_SOAK=1 pnpm test src/sync/simulation.test.ts` runs the long soak (about 7 simulated hours, 12,000 steps, six devices, partitions, restarts, skew, one cloud rollback, plus a 6,000-step all-offline run; about 80 s).

| File | Covers |
|---|---|
| `wire.test.ts` | Byte-for-byte conformance with the Go encoder; seals; credentials; HLC |
| `policy.test.ts` | Conflict policy per entity, in every arrival order; concurrent review edits; tombstones; money detectors; void in all 6 arrival orders; idempotent replay; unknown entities and fields |
| `numbers.test.ts` | Gapless unique numbers, crash around finalisation, concurrent finalisation racing apply, FY rollover across 1 April IST, dormant/closed series, restored device |
| `integrity.test.ts` | Chain and seal: alter, drop, reorder, inject, wrong key, no seal, re-offer; tenancy; clock quarantine; key loss and recovery upload; periodic seals |
| `resume.test.ts` | Lost responses, cuts, process kill, hub failover, offline writes, delivery states, restore epoch and re-offer, held/void read-back, status observable |
| `transport.test.ts` | HTTP mapping, bearer, LAN assertion and hub proof |
| `simulation.test.ts` | Seeded multi-client simulation: 20 seeds, 5 rollback seeds, soak, all-offline run. Checks equal vectors, equal state hash, equal conflict and detector output, cloud holds every op gaplessly, numbers unique and gapless per series |
| `../store/indexeddb.test.ts` | IndexedDB persistence: atomic commit, tenant filtering, engine state across a restart |
| `e2e.go.test.ts` | Against the real Go gateway and hub. Skipped unless `SYNC_E2E_FIXTURE` names a fixture (format in the file); the svc-sync `cmd/gateway` and `cmd/hub` binaries were not there when this was written |
