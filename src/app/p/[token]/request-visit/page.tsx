import type { Metadata } from "next";
import Link from "next/link";
import "@/components/public/public-site.css";
import { MultiServiceRequestFlow } from "@/components/public/request-flow";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { submitCleaningRepeatVisitRequest } from "@/app/actions/cleaning-repeat-visit";
import { loadCleaningRepeatVisitPublicView } from "@/lib/cleaning-repeat-visit-data";
import {
  CLEANING_REPEAT_VISIT_RECEIVED_MESSAGE,
  CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE,
} from "@/lib/cleaning-repeat-visit";
import { resolveBusinessServiceArea } from "@/lib/business-service-area";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import { currentIntakeSchema, publicIntakeSchemaProjection } from "@/lib/intake-schema";
import { PUBLIC_INTAKE_REFRESH_FORM } from "@/lib/intake-snapshot";
import { prisma } from "@/lib/prisma";
import { groupPublicCatalog } from "@/lib/public-site";
import { tradeLabel } from "@/lib/trades";
import {
  loadPublicWebsiteIntakeOverlays,
  loadPublicWebsiteView,
  snapshotIntakeSchemasByTrade,
} from "@/lib/website-engine/public";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Request another visit",
};

function Unavailable() {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Project unavailable</CardTitle>
          <CardDescription>{CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE}</CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

export default async function CleaningRepeatVisitPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await loadCleaningRepeatVisitPublicView(prisma, token);
  if (view.status !== "ready") {
    return <Unavailable />;
  }

  const website = await loadPublicWebsiteView(view.slug, prisma);
  if (!website || website.site.business.id !== view.businessId) {
    return <Unavailable />;
  }

  const cleaningItems = website.site.items.filter((item) => item.tradeCode === "CLEANING");
  const cleaningGroups = groupPublicCatalog(cleaningItems);
  const tradeCodes = ["CLEANING"];
  const intakeSchemasByTrade = website.snapshot
    ? Object.fromEntries(
        Object.entries(snapshotIntakeSchemasByTrade(website.snapshot)).filter(
          ([code]) => code === "CLEANING",
        ),
      )
    : { CLEANING: publicIntakeSchemaProjection(currentIntakeSchema("CLEANING")) };
  const publishedIntake = await loadPublicWebsiteIntakeOverlays(
    prisma,
    website,
    view.businessId,
    tradeCodes,
  );
  const initialSelected = {
    ...view.initialSelected,
    catalogIds: view.initialSelected.catalogIds.filter((id) =>
      cleaningItems.some((item) => item.id === id),
    ),
  };
  if (initialSelected.catalogIds.length === 0 && !initialSelected.includeOther) {
    initialSelected.includeOther = true;
    initialSelected.otherDescription = initialSelected.otherDescription || "Another cleaning visit";
  }

  return (
    <PublicSiteShell business={website.site.business} groups={cleaningGroups}>
      <main>
        <section className="bg-[var(--public-paper)]">
          <div className="public-container py-12">
            <div className="public-form-card">
              <p className="text-sm font-bold tracking-[0.16em] text-[var(--public-blue)] uppercase">
                Existing customer
              </p>
              <h1 className="mb-3 mt-3 text-2xl font-extrabold uppercase">Request another visit</h1>
              <p className="mb-6 text-sm text-[var(--public-ink)]">
                Submit this form for owner review. It does not schedule a job, take payment, or send
                a message.
              </p>
              <p className="mb-6 text-sm">
                <Link href={`/p/${token}`} className="underline underline-offset-4">
                  Back to your project
                </Link>
              </p>
              {view.alreadyRequested ? (
                <p className="text-sm text-[var(--public-ink)]">
                  {CLEANING_REPEAT_VISIT_RECEIVED_MESSAGE}
                </p>
              ) : publishedIntake.ok ? (
                <MultiServiceRequestFlow
                  slug={view.slug}
                  businessName={view.businessName}
                  items={cleaningItems}
                  groups={cleaningGroups}
                  initialSelected={initialSelected}
                  photosEnabled={isBusinessStorageConfigured()}
                  serviceArea={resolveBusinessServiceArea(website.site.business)}
                  intakeSchemasByTrade={intakeSchemasByTrade}
                  publishedIntakeByTrade={publishedIntake.overlays}
                  activeTrades={[{ code: "CLEANING", label: tradeLabel("CLEANING") }]}
                  projectToken={token}
                  submitAction={submitCleaningRepeatVisitRequest}
                  draftNamespace={`cleaning-repeat-visit:${token}`}
                  lockedTradeCode="CLEANING"
                  initialContact={view.contact}
                  successCopy={{
                    title: "Thank you. Your request was received.",
                    body: CLEANING_REPEAT_VISIT_RECEIVED_MESSAGE,
                    href: `/p/${token}`,
                    label: "Back to your project",
                  }}
                />
              ) : (
                <p className="text-sm text-[var(--public-ink)]">{PUBLIC_INTAKE_REFRESH_FORM}</p>
              )}
            </div>
          </div>
        </section>
      </main>
    </PublicSiteShell>
  );
}
