/**
 * Role/capability authorization layer.
 *
 * Extends the existing tenant-isolation architecture in `access.ts`
 * (`requireBusinessAccess()`, `access.scope`, `access.assertOwned()`,
 * `access.assertAttachable()`) with a SECOND, independent check: does this
 * member's role permit the action at all, regardless of which business it
 * belongs to?
 *
 * A caller must pass BOTH checks:
 *   1. Business membership / tenant scoping (access.ts)
 *   2. Role/capability authorization (this file)
 *
 * This is intentionally a small, flat capability set, not a general-purpose
 * permissions matrix. It exists to classify the handful of CURRENTLY
 * IMPLEMENTED server actions/mutations across the three MembershipRole
 * values (OWNER/ADMIN/MEMBER). Add capabilities only when a new mutation is
 * added; do not pre-build capabilities for unbuilt features.
 */
import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";

/**
 * Thrown when a member's role does not permit an action. Deliberately a
 * plain thrown Error (same shape/behavior as `access.assertOwned()`'s
 * failure mode) so unauthorized requests fail the same safe, generic way
 * tenant-isolation violations already do: no leaked detail about what the
 * caller isn't allowed to do, or why.
 */
export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Ordinary, currently-implemented business-management capabilities.
 * OWNER has every capability implicitly (see ROLE_CAPABILITIES below).
 *
 * There is deliberately no OWNER-only capability yet: every mutation that
 * exists today is ordinary business operation (customers, properties,
 * requests, catalog, estimates, jobs, invoices) that ADMIN is explicitly
 * chartered to perform. Sensitive future capabilities (banking, payroll
 * funding, ownership transfer, billing, security, full business
 * export/deletion) are NOT implemented yet; when they are built, add a
 * dedicated capability for them and grant it to OWNER only.
 */
export const CAPABILITIES = {
  /** Create/edit customers and their properties (service addresses). */
  MANAGE_CUSTOMERS: "MANAGE_CUSTOMERS",
  /** Create/edit the service catalog, including pricing. */
  MANAGE_CATALOG: "MANAGE_CATALOG",
  /**
   * Create/edit estimates and their line items, and drive the estimate
   * status lifecycle (send / return to draft / re-email). Also covers
   * converting an intake ServiceRequest into an estimate.
   */
  MANAGE_ESTIMATES: "MANAGE_ESTIMATES",
  /** Create invoices and drive their status lifecycle (sent / paid). */
  MANAGE_INVOICES: "MANAGE_INVOICES",
  /** Create jobs from approved estimates and schedule/dispatch them. */
  MANAGE_JOBS: "MANAGE_JOBS",
  /**
   * Hands-on job fieldwork: start/complete a job, add/remove job photos.
   *
   * FUTURE BOUNDARY: this is the seam where employee-specific access will
   * attach. Once a Job carries an assignment (e.g. an `assignedToUserId` or
   * a join table), MEMBER should be granted this capability SCOPED to jobs
   * they are assigned to. That assignment model does not exist yet in the
   * schema, so today OPERATE_JOBS is OWNER/ADMIN-only -- granting MEMBER
   * access now would mean every MEMBER can operate on every job in the
   * business, which this step deliberately avoids. Do not fake
   * assigned-job enforcement; add it when the assignment model exists.
   */
  OPERATE_JOBS: "OPERATE_JOBS",
  /** Business-wide configuration (e.g. labor minimum settings). */
  MANAGE_SETTINGS: "MANAGE_SETTINGS",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

const ALL_CAPABILITIES = Object.values(CAPABILITIES) as Capability[];

/**
 * OWNER: ultimate authority, all capabilities.
 * ADMIN: owner-delegated administrative role; every ordinary
 *   business-management capability that exists today.
 * MEMBER: ordinary employee/worker foundation; no general management
 *   capability. Do not add capabilities here just to make the role "useful"
 *   -- future employee-specific (e.g. assigned-job-scoped) permissions
 *   build on top of this foundation deliberately, one at a time.
 */
const ROLE_CAPABILITIES: Record<MembershipRole, ReadonlySet<Capability>> = {
  OWNER: new Set(ALL_CAPABILITIES),
  ADMIN: new Set(ALL_CAPABILITIES),
  MEMBER: new Set(),
};

export function roleHasCapability(
  role: MembershipRole,
  capability: Capability,
): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

/**
 * Role-floor gate for the rare case a capability name would be overkill
 * (e.g. a future OWNER-only action). Prefer `requireBusinessCapability` for
 * everything classified in the Step 2 action audit.
 */
export function requireBusinessRole(
  access: BusinessAccess,
  allowed: MembershipRole | readonly MembershipRole[],
): void {
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  if (!roles.includes(access.workspace.role)) {
    throw new ForbiddenError();
  }
}

/**
 * The primary authorization gate for server actions/mutations. Call this
 * AFTER `requireBusinessAccess()` (tenant scoping) and before touching any
 * data, so an unauthorized member never causes a partial read/write.
 */
export function requireBusinessCapability(
  access: BusinessAccess,
  capability: Capability,
): void {
  if (!roleHasCapability(access.workspace.role, capability)) {
    throw new ForbiddenError();
  }
}

/**
 * Coarse, temporary READ gate for the entire authenticated management
 * console (Dashboard, Requests, Customers, Estimates, Jobs, Invoices,
 * Services, Settings).
 *
 * Every one of those pages exists to browse or mutate business-wide
 * management data, and MEMBER has no capability over any of it today (see
 * CAPABILITIES above) -- so until a dedicated, assigned-job-scoped
 * employee/field UI is built, MEMBER must not be able to READ any of it
 * either, not just be blocked from mutating it. Hiding sidebar links is
 * not sufficient: this must be enforced wherever these pages render.
 *
 * Applied once, at `src/app/(app)/layout.tsx`, which every one of those
 * pages renders through -- so a MEMBER hitting any management URL directly
 * (not just via the sidebar) is still safely denied.
 *
 * FUTURE: replace this single console-wide gate with per-page/read
 * capabilities (or drop it) once employee-specific, assigned-job-scoped
 * field pages exist and MEMBER has something real to land on.
 */
export function canAccessManagementConsole(role: MembershipRole): boolean {
  return role !== "MEMBER";
}
