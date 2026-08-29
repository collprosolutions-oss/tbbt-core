import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MemberAccessRestricted } from "@/components/member-access-restricted";
import { canAccessManagementConsole } from "@/lib/authorization";
import { requireWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Access restricted",
};

/**
 * Safe landing page for a MEMBER whose account has no management-console
 * read access yet. Deliberately OUTSIDE the `(app)` route group/layout, and
 * only ever fetches the current user's own name/email + business name
 * (never any business-wide customer/estimate/job/invoice/catalog data), so
 * there is nothing sensitive to leak here even if a MEMBER lands on it
 * directly.
 *
 * `(app)/layout.tsx` (and every page under it, via
 * `requireManagementPageAccess()` in src/lib/access.ts) redirects a MEMBER
 * here. OWNER/ADMIN are bounced onward to /dashboard if they somehow land
 * here directly (e.g. a stale bookmark from before a promotion).
 */
export default async function AccessRestrictedPage() {
  const workspace = await requireWorkspace();

  if (canAccessManagementConsole(workspace.role)) {
    redirect("/dashboard");
  }

  return (
    <MemberAccessRestricted
      businessName={workspace.business.name}
      userName={workspace.user.name}
      userEmail={workspace.user.email}
    />
  );
}
