import type { Metadata } from "next";
import Link from "next/link";
import { ImportLeadsForm } from "@/components/requests/import-leads-form";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import {
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  OWNER_ONLY_IMPORT_MESSAGE,
} from "@/lib/external-lead-import";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";
import { SAAS_BILLING_SETTINGS_HREF } from "@/lib/saas-billing/config";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Import leads",
};

export default async function ImportLeadsPage() {
  const access = await requireManagementPageAccess();
  const entitlement = await loadSaasEntitlement(prisma, access.workspace.business);
  const operating = saasOperatingUiState(entitlement, access.workspace.role);
  const isOwner = access.workspace.role === "OWNER";

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Import leads"
        description="Preview an owner-uploaded CSV, then confirm before any leads are created."
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/requests">Back to requests</Link>
        </Button>
      </PageHeader>

      {!operating.canOperate ? (
        <Card>
          <CardHeader>
            <CardTitle>Subscription required</CardTitle>
            <CardDescription>{operating.blockedMessage}</CardDescription>
          </CardHeader>
          <CardContent>
            {operating.role === "OWNER" ? (
              <Button asChild>
                <Link href={SAAS_BILLING_SETTINGS_HREF}>Open TBBT Billing</Link>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ask the business owner to subscribe from TBBT Billing.
              </p>
            )}
          </CardContent>
        </Card>
      ) : !isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Owner review required</CardTitle>
            <CardDescription>{OWNER_ONLY_IMPORT_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Owner-uploaded CSV</CardTitle>
            <CardDescription>
              {IMPORT_NO_SCRAPE_MESSAGE} {IMPORT_NO_SCORE_MESSAGE} {IMPORT_NO_OUTREACH_MESSAGE}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ImportLeadsForm />
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
