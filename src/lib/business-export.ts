/**
 * Tenant-scoped business data export. Browser business IDs never authorize
 * this — callers must pass access.businessId from requireBusinessAccess().
 * Password hashes, session tokens, TOTP secrets, and setup/reset tokens
 * are never included.
 */
import type { PrismaClient } from "@prisma/client";
import { buildZipStore, toCsv } from "@/lib/zip-store";

const SECRET_KEY_PATTERN =
  /(password|tokenhash|totpsecret|totppending|secret|apikey|credential)/i;

export function isExportableField(key: string): boolean {
  return !SECRET_KEY_PATTERN.test(key);
}

export async function buildBusinessExportZip(
  prisma: PrismaClient,
  businessId: string,
): Promise<{ filename: string; bytes: Buffer }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      slug: true,
      tradeCode: true,
      publicPhone: true,
      publicEmail: true,
      publicWebsite: true,
      publicServiceAreaLabel: true,
      timezone: true,
      laborMinimumEnabled: true,
      laborMinimumAmount: true,
      firstRunSetupCompletedAt: true,
      starterServicesSetupCompletedAt: true,
      websiteSetupCompletedAt: true,
      offboardingRequestedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!business) {
    throw new Error("Business not found.");
  }

  const [
    customers,
    properties,
    requests,
    estimates,
    jobs,
    invoices,
    payments,
    expenses,
    timeEntries,
    reviews,
    reviewRequests,
    campaigns,
    serviceAreas,
    settings,
    members,
    followUps,
    referralRequests,
    marketingContents,
    settingsAudit,
    websitePublishes,
    websiteGallery,
    websiteLocalDrafts,
  ] = await Promise.all([
    prisma.customer.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        smsConsentStatus: true,
        firstLeadSource: true,
        firstCampaignId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.property.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        label: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        propertyId: true,
        status: true,
        summary: true,
        leadSource: true,
        campaignId: true,
        matchedServiceAreaId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.estimate.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        propertyId: true,
        serviceRequestId: true,
        status: true,
        campaignId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.job.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        estimateId: true,
        status: true,
        scheduledAt: true,
        assignedMembershipId: true,
        campaignId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invoice.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        total: true,
        paidAt: true,
        paymentMethod: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.payment.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        invoiceId: true,
        purpose: true,
        amount: true,
        method: true,
        receivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.expense.findMany({
      where: { businessId },
      select: {
        id: true,
        vendor: true,
        description: true,
        amount: true,
        category: true,
        occurredOn: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.timeEntry.findMany({
      where: { businessId },
      select: {
        id: true,
        membershipId: true,
        jobId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.review.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        rating: true,
        platform: true,
        reviewText: true,
        websiteSelected: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.reviewRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.marketingCampaign.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        sourceKey: true,
        status: true,
        notes: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceArea.findMany({
      where: { businessId },
      select: {
        id: true,
        kind: true,
        label: true,
        city: true,
        region: true,
        postalCode: true,
        enabled: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.businessSettings.findUnique({
      where: { businessId },
    }),
    prisma.membership.findMany({
      where: { businessId },
      select: {
        id: true,
        role: true,
        active: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customerFollowUp.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        sentAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.referralRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.marketingContent.findMany({
      where: { businessId },
      select: {
        id: true,
        campaignId: true,
        title: true,
        status: true,
        channelIntent: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.settingsAuditLog.findMany({
      where: { businessId },
      select: {
        id: true,
        settingArea: true,
        settingKey: true,
        previousValue: true,
        newValue: true,
        changedAt: true,
      },
      orderBy: { changedAt: "asc" },
    }),
    prisma.websitePublish.findMany({
      where: { businessId },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        schemaVersion: true,
        snapshotJson: true,
        summary: true,
        publishedAt: true,
        sourcePublishId: true,
      },
      orderBy: { versionNumber: "asc" },
    }),
    prisma.websiteGalleryItem.findMany({
      where: { businessId },
      select: {
        id: true,
        storedAssetId: true,
        title: true,
        caption: true,
        sortOrder: true,
        catalogItemId: true,
        createdAt: true,
      },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.websiteLocalPageDraft.findMany({
      where: { businessId },
      select: {
        id: true,
        serviceAreaId: true,
        catalogItemId: true,
        draftCopy: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const safeSettings = settings
    ? Object.fromEntries(
        Object.entries(settings).filter(([key]) => isExportableField(key)),
      )
    : {};

  const date = new Date().toISOString().slice(0, 10);
  const files = [
    {
      name: "manifest.json",
      data: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          businessId: business.id,
          businessName: business.name,
          slug: business.slug,
          note:
            "Tenant-scoped export. Password hashes, session tokens, TOTP secrets, and setup/reset tokens are omitted.",
        },
        null,
        2,
      ),
    },
    { name: "business.csv", data: toCsv(Object.keys(business), [business]) },
    {
      name: "members.csv",
      data: toCsv(
        ["id", "name", "email", "role", "active", "createdAt"],
        members.map((member) => ({
          id: member.id,
          name: member.user.name,
          email: member.user.email,
          role: member.role,
          active: member.active,
          createdAt: member.createdAt,
        })),
      ),
    },
    { name: "customers.csv", data: toCsv(headersOf(customers), customers) },
    { name: "properties.csv", data: toCsv(headersOf(properties), properties) },
    { name: "requests.csv", data: toCsv(headersOf(requests), requests) },
    { name: "estimates.csv", data: toCsv(headersOf(estimates), estimates) },
    { name: "jobs.csv", data: toCsv(headersOf(jobs), jobs) },
    { name: "invoices.csv", data: toCsv(headersOf(invoices), invoices) },
    { name: "payments.csv", data: toCsv(headersOf(payments), payments) },
    { name: "expenses.csv", data: toCsv(headersOf(expenses), expenses) },
    { name: "time-entries.csv", data: toCsv(headersOf(timeEntries), timeEntries) },
    { name: "reviews.csv", data: toCsv(headersOf(reviews), reviews) },
    { name: "review-requests.csv", data: toCsv(headersOf(reviewRequests), reviewRequests) },
    { name: "campaigns.csv", data: toCsv(headersOf(campaigns), campaigns) },
    { name: "marketing-content.csv", data: toCsv(headersOf(marketingContents), marketingContents) },
    { name: "service-areas.csv", data: toCsv(headersOf(serviceAreas), serviceAreas) },
    { name: "follow-ups.csv", data: toCsv(headersOf(followUps), followUps) },
    { name: "referral-requests.csv", data: toCsv(headersOf(referralRequests), referralRequests) },
    {
      name: "settings.csv",
      data: toCsv(Object.keys(safeSettings), [safeSettings]),
    },
    { name: "settings-audit.csv", data: toCsv(headersOf(settingsAudit), settingsAudit) },
    {
      name: "website-publishes.json",
      data: JSON.stringify(
        websitePublishes.map((row) => ({
          id: row.id,
          versionNumber: row.versionNumber,
          status: row.status,
          schemaVersion: row.schemaVersion,
          summary: row.summary,
          publishedAt: row.publishedAt,
          sourcePublishId: row.sourcePublishId,
          snapshot: JSON.parse(row.snapshotJson),
        })),
        null,
        2,
      ),
    },
    { name: "website-gallery.csv", data: toCsv(headersOf(websiteGallery), websiteGallery) },
    {
      name: "website-local-drafts.csv",
      data: toCsv(headersOf(websiteLocalDrafts), websiteLocalDrafts),
    },
  ];

  return {
    filename: `tbbt-export-${business.slug}-${date}.zip`,
    bytes: buildZipStore(files),
  };
}

function headersOf(rows: Array<Record<string, unknown>>): string[] {
  return rows[0] ? Object.keys(rows[0]) : ["id"];
}
