import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { canAccessManagementConsole } from "@/lib/authorization";
import {
  FIRST_RUN_SETUP_PATH,
  ownerNeedsFirstRunSetup,
} from "@/lib/first-run-setup";
import {
  ownerNeedsStarterServicesSetup,
  STARTER_SERVICES_SETUP_PATH,
} from "@/lib/starter-services-setup";
import {
  ownerNeedsWebsiteSetup,
  WEBSITE_SETUP_PATH,
} from "@/lib/website-setup";
import { getTrade } from "@/lib/trades";
import { requireWorkspace } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";
import { SaasEntitlementBanner } from "@/components/settings/saas-entitlement-banner";
import { SaasOperatingProvider } from "@/components/saas/saas-operating-context";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspace = await requireWorkspace();

  if (ownerNeedsFirstRunSetup(workspace)) {
    redirect(FIRST_RUN_SETUP_PATH);
  }
  if (ownerNeedsStarterServicesSetup(workspace)) {
    redirect(STARTER_SERVICES_SETUP_PATH);
  }
  if (ownerNeedsWebsiteSetup(workspace)) {
    redirect(WEBSITE_SETUP_PATH);
  }

  // Server-side READ gate for the whole management console: every page
  // under this layout (Dashboard, Requests, Customers, Estimates, Jobs,
  // Invoices, Reports, Marketing, Reviews, Pipeline, Knowledge, Services, Time Cards, Payroll, Expenses, Settings) browses or mutates business-wide data
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
  const businessLogoSrc = getBusinessLogoSrc(workspace.business.slug);
  const entitlement = await loadSaasEntitlement(prisma, workspace.business);
  const operating = saasOperatingUiState(entitlement, workspace.role);

  return (
    <SaasOperatingProvider value={operating}>
    <AppShell
      businessName={workspace.business.name}
      businessLogoSrc={businessLogoSrc}
      tradeLabel={trade?.name ?? "Handyman"}
      userName={workspace.user.name}
      userEmail={workspace.user.email}
      role={workspace.role}
      banner={
        <SaasEntitlementBanner entitlement={entitlement} role={workspace.role} />
      }
    >
      {children}
    </AppShell>
    </SaasOperatingProvider>
  );
}
