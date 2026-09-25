import type { Metadata } from "next";
import Link from "next/link";
import { LogLeadForm } from "@/components/requests/log-lead-form";
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
import { formatAddress } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";
import { SAAS_BILLING_SETTINGS_HREF } from "@/lib/saas-billing/config";

export const metadata: Metadata = {
  title: "Log lead",
};

export default async function LogLeadPage() {
  const access = await requireManagementPageAccess();
  const entitlement = await loadSaasEntitlement(prisma, access.workspace.business);
  const operating = saasOperatingUiState(entitlement, access.workspace.role);
  const [customers, catalogItems] = await Promise.all([
    prisma.customer.findMany({
      where: access.scope,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        properties: {
          select: {
            id: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.serviceCatalogItem.findMany({
      where: { ...access.scope, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Log lead"
        description="Capture a phone, text, walk-in, or referral lead as a real request. Create the estimate from that request when you are ready."
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
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Lead</CardTitle>
            <CardDescription>
              Name plus a short scope is enough. Matching email or phone reuses
              the existing customer. This creates a ServiceRequest, not an
              estimate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LogLeadForm
              customers={customers.map((customer) => ({
                id: customer.id,
                name: customer.name,
                phone: customer.phone,
                email: customer.email,
                properties: customer.properties.map((property) => ({
                  id: property.id,
                  label: formatAddress(property),
                })),
              }))}
              catalogItems={catalogItems}
            />
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
