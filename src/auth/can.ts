import type { Grant, Session } from "./types";

/**
 * Permission check on the last-synced grants (tenancy-auth-rbac: check permissions, never role names).
 * `"*"` as a permission is the owner wildcard and matches everything; there are no partial wildcards,
 * so `bill.*` matches nothing. An outlet-scoped check passes if any grant covers that outlet.
 * A missing outlet means a tenant-wide permission: only a grant with outlets ["*"] satisfies it.
 * Expired sessions grant nothing.
 */
export function can(
  session: Pick<Session, "grants" | "expiresAt"> | undefined,
  permission: string,
  outletId?: string,
  now: Date = new Date(),
): boolean {
  if (!session) return false;
  if (new Date(session.expiresAt).getTime() <= now.getTime()) return false;
  return session.grants.some((g) => covers(g, permission, outletId));
}

function covers(g: Grant, permission: string, outletId: string | undefined): boolean {
  const outletOk = g.outlets.includes("*") || (outletId !== undefined && g.outlets.includes(outletId));
  return outletOk && (g.perms.includes("*") || g.perms.includes(permission));
}
