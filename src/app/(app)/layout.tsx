import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { canAccessManagementConsole } from "@/lib/authorization";
import { getTrade } from "@/lib/trades";
import { requireWorkspace } from "@/lib/workspace";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspace = await requireWorkspace();

  // Server-side READ gate for the whole management console: every page
  // under this layout (Dashboard, Requests, Customers, Estimates, Jobs,
  // Invoices, Services, Settings) browses or mutates business-wide data
  // that MEMBER has no access to yet.
  //
  // This MUST be a redirect() (which aborts rendering) and not a
  // conditional JSX branch: Next.js still renders/serializes a matched
  // page segment into the response's Flight payload even when a parent
  // layout's returned tree omits `{children}`, so simply not rendering
  // {children} here would NOT stop the page below from querying and
  // shipping business data to a MEMBER's browser. See
  // requireManagementPageAccess() in src/lib/access.ts, which every page
  // under this layout also calls directly (belt-and-suspenders: the
  // earliest of the two checks wins, and neither depends on the other).
  if (!canAccessManagementConsole(workspace.role)) {
    redirect("/access-restricted");
  }

  const trade = getTrade(workspace.business.tradeCode);

  return (
    <AppShell
      businessName={workspace.business.name}
      tradeLabel={trade?.name ?? "Handyman"}
      userName={workspace.user.name}
      userEmail={workspace.user.email}
      role={workspace.role}
    >
      {children}
    </AppShell>
  );
}
