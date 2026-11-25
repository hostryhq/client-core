export type * from "./types";
export { canonicalize } from "./canonical";
export { HlcClock, compareStamp, packHlc, unpackHlc, MAX_FUTURE_MS } from "./hlc";
export {
  KeyRing,
  SoftwareSigner,
  genesisHash,
  makeSeal,
  sealMessage,
  endorsementMessage,
  sha256Hex,
  verifySeal,
  type Credential,
  type CredentialEnvelope,
  type SealVerifier,
  type Signer,
  type StoreProtection,
} from "./crypto";
export { DEMO_SCHEMAS, SchemaRegistry, demoRegistry, reviewFields, type DocType, type EntitySchema, type FieldPolicy, type FieldRule, type Policy } from "./schema";
export { restaurantRegistry, restaurantSchemas, restaurantFields, restaurantIdRule, type EntityDef } from "./restaurant";
export { SeriesError, financialYear, formatNumber, type SeriesGrant, type SeriesState } from "./series";
export { detect, seriesGaps, type SeriesGap, type Violation } from "./detectors";
export { DRAIN_TAG, drainSigningMessage, drainStatementHash, type DrainStatement } from "./drain";
export { visible, type ConflictRow } from "./apply";
export {
  KeyLostError,
  SyncEngine,
  type BuildCtx,
  type EngineConfig,
  type RecordSpec,
  type RemoteProofs,
  type RemoteResult,
  DIRECT_CLOUD_INTERVAL_MS,
  type OpSession,
} from "./engine";
export {
  HttpTransport,
  TransportError,
  fromWireVector,
  bearerAuth,
  toWireVector,
  type HelloRequest,
  type HttpAuth,
  type HelloResponse,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncTransport,
} from "./transport";
export { SyncRunner, type RunnerConfig } from "./runner";
export { MAX_OP_BODY_BYTES, MAX_PII_BYTES, OpTooLargeError, isPiiObject, splitPii, withPii, type PiiObject } from "./pii";
export {
  PII_SALT_BYTES,
  PII_SALT_PREFIX,
  commitPii,
  openPii,
  piiStrings,
  stripSalts,
  type OpenedPii,
  type PiiCommit,
  type PiiValues,
  type PiiWire,
  type RandomBytes,
} from "./pii-commit";
export { mergePii, missingPiiFields, servesPii, withCommits, type DeviceKind } from "./pii-serve";
export { COMMIT_PREFIX, digestRowText, entityDigest, stateDigest } from "./digest";
export {
  actionHash,
  actionValues,
  approvalProofMessage,
  goQuote,
  proofTime,
  sessionProofMessage,
  type ActionHashFields,
  type ApprovalProofFields,
  type SessionProofFields,
} from "./proof";
export {
  HELLO_LAN_PATH,
  LAN_SESSION_HEADER,
  LAN_SESSION_TTL_S,
  LanError,
  LanTransport,
  OPEN_LAN_SESSION_PATH,
  browserLanChannel,
  lanProofMessage,
  makeLanProof,
  spkiHash,
  validLanToken,
  verifyLanCredential,
  verifyLanProof,
  type CredentialCheck,
  type CredentialExpect,
  type CredentialRefusal,
  type LanChannel,
  type LanChannelResponse,
  type LanErrorCode,
  type LanProofFields,
  type LanTransportConfig,
} from "./lan";
