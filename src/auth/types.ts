/**
 * Auth/session types per ADR-0005. Interface stubs only: token handling, PIN verification and the
 * device keystore are built later (ADR-0005 Amendment A1 is Proposed; do not build the keystore yet).
 */

/** `grants` claim entry: permission strings valid at the listed outlets. */
export type Grant = {
  /** Outlet ids, or ["*"] for all outlets of the tenant. */
  outlets: string[];
  /** Fine-grained permission strings (`bill.void`). Only the owner role holds the single wildcard "*". */
  perms: string[];
};

/** `personal`: owner/manager phone, long-lived with app lock. `shared`: outlet device, staff PIN, 12 h at most. */
export type SessionKind = "personal" | "shared";

export type Session = {
  tenantId: string;
  /** Member id. */
  memberId: string;
  deviceId: string;
  /** Session id (`sid`). */
  sessionId: string;
  kind: SessionKind;
  /** Permissions as last synced (offline pack or token). Never trusted beyond that. */
  grants: Grant[];
  /** RFC 3339 UTC. Offline sessions expire; the device re-validates on reconnect. */
  expiresAt: string;
  /** True when established from the offline pack with no network. */
  offline: boolean;
};

export type MemberSummary = { memberId: string; displayName: string };

/** Online-only: first-time device activation and owner/manager OTP login (offline-first-sync). */
export interface AuthClient {
  /** Start owner/manager OTP sign-in (online). */
  startOtp(phone: string): Promise<{ challengeId: string }>;
  completeOtp(challengeId: string, code: string): Promise<Session>;
  /** Activate this installation with a manager-created code (online, first time only). */
  activateDevice(activationCode: string): Promise<{ deviceId: string }>;
}

/** Works offline from the signed offline pack. The PIN is checked on the device, the same way online. */
export interface PinLogin {
  /** Staff on this device (from the offline pack) shown as tap-your-name choices. */
  members(): Promise<MemberSummary[]>;
  signIn(memberId: string, pin: string): Promise<Session>;
  signOut(): Promise<void>;
}

export interface SessionStore {
  current(): Session | undefined;
  onChange(listener: (session: Session | undefined) => void): () => void;
}
