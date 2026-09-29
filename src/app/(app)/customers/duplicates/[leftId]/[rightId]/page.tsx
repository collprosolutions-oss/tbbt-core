import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MergeCustomersForm } from "@/components/customers/merge-customers-form";
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
  CUSTOMER_MERGE_ROUTE,
  CustomerMergeError,
  NAME_IS_NOT_IDENTITY_MESSAGE,
  NO_SHARED_IDENTIFIER_MESSAGE,
  OWNER_ONLY_MERGE_MESSAGE,
} from "@/lib/customer-merge";
import { loadOwnedMergePair } from "@/lib/customer-merge-ops";
import { resolveStoredSmsConsent } from "@/lib/customer-messaging/consent";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Confirm customer merge",
};

function recordSummary(customer: {
  name: string;
  email: string | null;
  phone: string | null;
  smsConsentStatus: string;
}) {
  return `${customer.email || "No email"} · ${customer.phone || "No phone"} · SMS ${resolveStoredSmsConsent(customer.smsConsentStatus)}`;
}

export default async function ConfirmCustomerMergePage({
  params,
}: {
  params: Promise<{ leftId: string; rightId: string }>;
}) {
  const { leftId, rightId } = await params;
  const access = await requireManagementPageAccess();
  const isOwner = access.workspace.role === "OWNER";

  let pair: Awaited<ReturnType<typeof loadOwnedMergePair>> | null = null;
  let loadError: string | null = null;
  if (isOwner) {
    try {
      pair = await loadOwnedMergePair(prisma, access, leftId, rightId);
    } catch (error) {
      if (error instanceof CustomerMergeError) {
        loadError = error.message;
      } else {
        throw error;
      }
    }
  }

  if (isOwner && !pair && !loadError) {
    notFound();
  }

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Confirm customer merge"
        description="Choose which record to keep. The other record is removed only after every job, estimate, invoice, property, and message moves."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={CUSTOMER_MERGE_ROUTE}>Back to possible duplicates</Link>
        </Button>
      </PageHeader>

      {!isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Owner review required</CardTitle>
            <CardDescription>{OWNER_ONLY_MERGE_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : loadError || !pair ? (
        <Card>
          <CardHeader>
            <CardTitle>These records cannot be merged</CardTitle>
            <CardDescription>{loadError ?? NAME_IS_NOT_IDENTITY_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : pair.reasons.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No shared email or phone</CardTitle>
            <CardDescription>{NO_SHARED_IDENTIFIER_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {pair.left.name} and {pair.right.name}
            </CardTitle>
            <CardDescription>
              Shared {pair.reasons.join(" and ")}. {NAME_IS_NOT_IDENTITY_MESSAGE}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border/70 p-3 text-sm">
                <p className="font-medium text-foreground">{pair.left.name}</p>
                <p className="mt-1 text-muted-foreground">{recordSummary(pair.left)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {pair.leftCounts.jobs} jobs · {pair.leftCounts.estimates} estimates ·{" "}
                  {pair.leftCounts.invoices} invoices · {pair.leftCounts.properties} properties ·{" "}
                  {pair.leftCounts.communications} messages
                </p>
              </div>
              <div className="rounded-lg border border-border/70 p-3 text-sm">
                <p className="font-medium text-foreground">{pair.right.name}</p>
                <p className="mt-1 text-muted-foreground">{recordSummary(pair.right)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {pair.rightCounts.jobs} jobs · {pair.rightCounts.estimates} estimates ·{" "}
                  {pair.rightCounts.invoices} invoices · {pair.rightCounts.properties} properties ·{" "}
                  {pair.rightCounts.communications} messages
                </p>
              </div>
            </div>
            <MergeCustomersForm
              leftId={pair.left.id}
              rightId={pair.right.id}
              leftName={pair.left.name}
              rightName={pair.right.name}
            />
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
