import type { Metadata } from "next";
import Link from "next/link";
import { ImportBankCsvForm } from "@/components/reconciliation/import-bank-csv-form";
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
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import {
  BANK_NO_LIVE_FEED_MESSAGE,
  BANK_NOT_A_BALANCE_MESSAGE,
  BANK_NOT_A_PAYMENT_MESSAGE,
  BANK_RECONCILIATION_ROUTE,
  OWNER_ONLY_BANK_RECONCILIATION_MESSAGE,
} from "@/lib/bank-reconciliation";
import { listOwnedBankReconciliations } from "@/lib/bank-reconciliation-ops";
import { formatDate, formatTime } from "@/lib/format";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";
import { SAAS_BILLING_SETTINGS_HREF } from "@/lib/saas-billing/config";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Bank CSV review",
};

export default async function BankReconciliationPage() {
  const access = await requireManagementPageAccess();
  const entitlement = await loadSaasEntitlement(prisma, access.workspace.business);
  const operating = saasOperatingUiState(entitlement, access.workspace.role);
  const isOwner = roleHasCapability(access.workspace.role, CAPABILITIES.REVIEW_BANK_RECONCILIATION);
  const imports = isOwner ? await listOwnedBankReconciliations(prisma, access) : [];

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Bank CSV review"
        description={`${BANK_NO_LIVE_FEED_MESSAGE} ${BANK_NOT_A_PAYMENT_MESSAGE} ${BANK_NOT_A_BALANCE_MESSAGE}`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/settings?section=banking">Back to banking settings</Link>
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
            <CardDescription>{OWNER_ONLY_BANK_RECONCILIATION_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Owner-uploaded bank CSV</CardTitle>
              <CardDescription>
                The source file is stored privately on this business. Suggested matches are
                for review only.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ImportBankCsvForm />
            </CardContent>
          </Card>

          {imports.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent workspaces</CardTitle>
                <CardDescription>Same-file uploads reopen the existing workspace.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {imports.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{item.sourceLabel}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(item.capturedAt)} {formatTime(item.capturedAt)} · {item.rowCount}{" "}
                          rows · {item.candidateMatchCount} candidates · {item.unmatchedCount} unmatched
                        </p>
                      </div>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`${BANK_RECONCILIATION_ROUTE}/${item.id}`}>Open</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
