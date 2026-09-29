import type { Metadata } from "next";
import Link from "next/link";
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
  NAME_IS_NOT_IDENTITY_MESSAGE,
  OWNER_ONLY_MERGE_MESSAGE,
  pairHref,
} from "@/lib/customer-merge";
import { loadDuplicateReview } from "@/lib/customer-merge-ops";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Possible duplicate customers",
};

function countsLabel(counts: {
  jobs: number;
  estimates: number;
  invoices: number;
  properties: number;
  communications: number;
}) {
  return `${counts.jobs} jobs · ${counts.estimates} estimates · ${counts.invoices} invoices · ${counts.properties} properties · ${counts.communications} messages`;
}

export default async function CustomerDuplicatesPage() {
  const access = await requireManagementPageAccess();
  const isOwner = access.workspace.role === "OWNER";
  const review = isOwner ? await loadDuplicateReview(prisma, access) : { pairs: [] };

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Possible duplicate customers"
        description="Review same-business records that share a recorded email or phone. Merge only after you confirm they are the same customer."
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/customers">Back to customers</Link>
        </Button>
      </PageHeader>

      {!isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Owner review required</CardTitle>
            <CardDescription>{OWNER_ONLY_MERGE_MESSAGE}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Same-business email or phone matches</CardTitle>
            <CardDescription>{NAME_IS_NOT_IDENTITY_MESSAGE}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {review.pairs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No same-business email or phone matches need review.
              </p>
            ) : (
              review.pairs.map((pair) => (
                <div
                  key={`${pair.left.id}:${pair.right.id}`}
                  className="rounded-lg border border-border/70 p-3"
                >
                  <p className="text-sm font-medium text-foreground">
                    {pair.left.name} · {pair.right.name}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Shared {pair.reasons.join(" and ")}
                    {pair.sharedEmail ? ` · ${pair.sharedEmail}` : ""}
                    {pair.sharedPhone ? ` · ${pair.sharedPhone}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pair.left.name}: {countsLabel(pair.leftCounts)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {pair.right.name}: {countsLabel(pair.rightCounts)}
                  </p>
                  <div className="mt-3">
                    <Button asChild size="sm" variant="outline">
                      <Link href={pairHref(pair.left.id, pair.right.id)}>Review this pair</Link>
                    </Button>
                  </div>
                </div>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              This page does not merge automatically. Open a pair, choose which record to keep,
              and confirm. Route: {CUSTOMER_MERGE_ROUTE}
            </p>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
