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
 * Ordinary business-management capabilities are granted to OWNER and
 * ADMIN. Sensitive money-movement authorization is OWNER-only
 * (AUTHORIZE_PAYROLL). Banking, provider funding, ownership transfer,
 * billing, security, and full business export/deletion remain unbuilt.
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
   * Hands-on job fieldwork on ANY job in the business: start/complete a
   * job, add/remove job photos, resolve field problem reports.
   * OWNER/ADMIN-only, unchanged by Phase 3 / Step 4.
   *
   * MEMBER's hands-on fieldwork is authorized through a SEPARATE,
   * narrower boundary instead of this capability: `findAssignedJob()` /
   * `requireAssignedJobPageAccess()` in src/lib/field-access.ts, which
   * grant a MEMBER field access to exactly the one Job assigned to them
   * (Job.assignedMembershipId -- see prisma/schema.prisma), never to every
   * job in the business the way this capability does. Do not grant MEMBER
   * this capability -- that would mean every MEMBER can operate on every
   * job, which the assigned-job-scoped boundary exists specifically to
   * avoid.
   */
  OPERATE_JOBS: "OPERATE_JOBS",
  /** Business-wide configuration (e.g. labor minimum settings). */
  MANAGE_SETTINGS: "MANAGE_SETTINGS",
  /**
   * Create/edit/send/cancel Change Orders (post-approval scope/pricing
   * changes on a Job) and act on customer Additional Work Requests
   * (create a Change Order from one, or dismiss it). Deliberately separate
   * from MANAGE_JOBS/MANAGE_ESTIMATES: a Change Order is a distinct,
   * separately-approved commercial record, not an edit to either.
   */
  MANAGE_CHANGE_ORDERS: "MANAGE_CHANGE_ORDERS",
  /**
   * Add a field team member (MEMBER) to this business, and
   * remove/deactivate an existing MEMBER Membership. Deliberately narrow --
   * this is onboarding a Membership row for the existing User/auth model,
   * NOT the future Team & Permissions module (no role changes beyond
   * OWNER/ADMIN creating a MEMBER, no invite management UI, no
   * payroll/HR). See src/app/actions/team.ts.
   */
  MANAGE_MEMBERS: "MANAGE_MEMBERS",
  /**
   * Owner/admin Time Cards management: browse every worker's entries,
   * enter/correct time, set membership hourly wage, approve/reopen a
   * week. MEMBER field clocking is a SEPARATE, self-scoped boundary
   * (clockInTime / clockOutTime when membershipId === the caller's own
   * Membership) and must never be granted this capability.
   */
  MANAGE_TIME_CARDS: "MANAGE_TIME_CARDS",
  /**
   * Prepare and review a payroll run: assemble a pay period from
   * APPROVED TimesheetWeek records, inspect readiness, mark reviewed.
   * Does NOT authorize money movement. MEMBER must never receive this.
   */
  MANAGE_PAYROLL: "MANAGE_PAYROLL",
  /**
   * OWNER-only final authorization of a payroll run, plus recording an
   * external provider/manual processed result and cancelling/reopening
   * an already-authorized run. ADMIN may prepare/review via
   * MANAGE_PAYROLL but must not silently inherit this.
   */
  AUTHORIZE_PAYROLL: "AUTHORIZE_PAYROLL",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

const ALL_CAPABILITIES = Object.values(CAPABILITIES) as Capability[];
const OWNER_ONLY_CAPABILITIES = new Set<Capability>([CAPABILITIES.AUTHORIZE_PAYROLL]);

/**
 * OWNER: ultimate authority, all capabilities including payroll
 *   authorization.
 * ADMIN: owner-delegated administrative role; every ordinary
 *   business-management capability, including payroll prepare/review.
 *   Does not receive OWNER-only money-authorization capabilities.
 * MEMBER: ordinary employee/worker foundation; no general management
 *   capability. Do not add capabilities here just to make the role "useful"
 *   -- future employee-specific (e.g. assigned-job-scoped) permissions
 *   build on top of this foundation deliberately, one at a time.
 */
const ROLE_CAPABILITIES: Record<MembershipRole, ReadonlySet<Capability>> = {
  OWNER: new Set(ALL_CAPABILITIES),
  ADMIN: new Set(ALL_CAPABILITIES.filter((capability) => !OWNER_ONLY_CAPABILITIES.has(capability))),
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
 * Services, Time Cards, Payroll, Settings).
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
