import type { Metadata } from "next";
import Link from "next/link";
import { ImportCatalogForm } from "@/components/catalog/import-catalog-form";
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
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
} from "@/lib/service-catalog-import";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";
import { SAAS_BILLING_SETTINGS_HREF } from "@/lib/saas-billing/config";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Import catalog",
};

export default async function ImportCatalogPage() {
  const access = await requireManagementPageAccess();
  const entitlement = await loadSaasEntitlement(prisma, access.workspace.business);
  const operating = saasOperatingUiState(entitlement, access.workspace.role);
  const isOwner = access.workspace.role === "OWNER";

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Import catalog"
        description="Preview an owner-uploaded CSV, review validation errors and duplicate-name matches, then confirm before this business's catalog is written."
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/services">Back to Services</Link>
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
            <CardDescription>{OWNER_ONLY_CATALOG_IMPORT_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Owner-uploaded CSV</CardTitle>
            <CardDescription>
              {CATALOG_IMPORT_NO_HOURLY_MESSAGE} {CATALOG_IMPORT_NAME_MATCH_MESSAGE}{" "}
              {CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ImportCatalogForm />
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
