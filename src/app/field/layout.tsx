import { redirect } from "next/navigation";
import { FieldShell } from "@/components/field/field-shell";
import { SaasOperatingProvider } from "@/components/saas/saas-operating-context";
import { SaasEntitlementBanner } from "@/components/settings/saas-entitlement-banner";
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
import { requireWorkspace } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";

/**
 * Employee Field Workflow layout. Any authenticated member of a business
 * may render this shell -- it is scoped by ASSIGNMENT (per Job), not by
 * role, so OWNER/ADMIN may also open it to preview a Field Job they have
 * assigned to themselves (see the OWNER / ADMIN FIELD ACCESS section of the
 * spec). This is the seam that keeps MEMBER out of the OWNER/ADMIN
 * management console: it never imports or renders <AppShell>, and every
 * page under it fetches only field-safe, assignment-scoped data.
 */
export default async function FieldLayout({
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

  const entitlement = await loadSaasEntitlement(prisma, workspace.business);
  const operating = saasOperatingUiState(entitlement, workspace.role);

  return (
    <SaasOperatingProvider value={operating}>
    <FieldShell
      businessName={workspace.business.name}
      userName={workspace.user.name}
      banner={
        entitlement.requiresSubscription ? (
          <SaasEntitlementBanner entitlement={entitlement} role={workspace.role} />
        ) : null
      }
    >
      {children}
    </FieldShell>
    </SaasOperatingProvider>
  );
}
