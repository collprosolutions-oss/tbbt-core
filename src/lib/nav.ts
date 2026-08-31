import type { MembershipRole } from "@prisma/client";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";

type NavItem = {
  href: string;
  label: string;
  /**
   * Capability required to see this nav destination. Omit for pages every
   * role may view. This only controls sidebar visibility for clarity --
   * server-side checks in the corresponding actions are the real
   * authorization boundary (see src/lib/authorization.ts).
   */
  capability?: Capability;
};

export const APP_NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/requests", label: "Requests" },
  { href: "/customers", label: "Customers" },
  { href: "/estimates", label: "Estimates", capability: CAPABILITIES.MANAGE_ESTIMATES },
  { href: "/jobs", label: "Schedule / Jobs" },
  { href: "/time-cards", label: "Time Cards", capability: CAPABILITIES.MANAGE_TIME_CARDS },
  { href: "/payroll", label: "Payroll", capability: CAPABILITIES.MANAGE_PAYROLL },
  { href: "/invoices", label: "Invoices", capability: CAPABILITIES.MANAGE_INVOICES },
  { href: "/expenses", label: "Expenses", capability: CAPABILITIES.MANAGE_EXPENSES },
  { href: "/services", label: "Services", capability: CAPABILITIES.MANAGE_CATALOG },
  { href: "/team", label: "Team", capability: CAPABILITIES.MANAGE_MEMBERS },
  { href: "/settings", label: "Business Settings", capability: CAPABILITIES.MANAGE_SETTINGS },
] as const;

/**
 * Smallest safe sidebar change for Step 2: filter out nav destinations a
 * role has no allowed action on today, without restructuring AppShell.
 * Page-level control hiding (e.g. individual edit buttons on pages every
 * role can still view, like Customers or Jobs) is intentionally out of
 * scope here -- server-side authorization is the enforced boundary, and
 * those actions already fail safely for MEMBER.
 */
export function visibleAppNav(role: MembershipRole): readonly NavItem[] {
  return APP_NAV.filter(
    (item) => !item.capability || roleHasCapability(role, item.capability),
  );
}
