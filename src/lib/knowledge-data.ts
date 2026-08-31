/**
 * Tenant-scoped Knowledge Hub loader. Every query is keyed by the
 * authenticated workspace businessId -- never a client-supplied id.
 *
 * Reads existing operational records as reference sources. Never invents
 * takeoff data, vendor ratings, AI lessons, or profitability conclusions.
 */

import type { PrismaClient } from "@prisma/client";
import {
  AREA_TO_CATEGORY,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_SOURCE_KIND_LABELS,
  KNOWLEDGE_SOURCE_TYPE_LABELS,
  KNOWLEDGE_TRUST_LABELS,
  LEARNING_LOOP_STEPS,
  NO_AI_MESSAGE,
  TAKEOFF_UNAVAILABLE_MESSAGE,
  isKnowledgeCategory,
  isKnowledgeSourceKind,
  isKnowledgeSourceType,
  isKnowledgeTrustState,
  isRecentlyUpdated,
  matchesKnowledgeSearch,
  needsKnowledgeReview,
  parseKnowledgeArchiveFilter,
  parseKnowledgeArea,
  parseKnowledgeReviewFilter,
  parseKnowledgeTrustFilter,
  sourceRecordHref,
  type KnowledgeArea,
  type KnowledgeCategory,
  type KnowledgeSourceKind,
  type KnowledgeSourceType,
  type KnowledgeTrustState,
} from "@/lib/knowledge";

export type KnowledgeQuery = {
  area: KnowledgeArea;
  q: string;
  trust: KnowledgeTrustState | "all";
  review: "needs-review" | "all";
  archive: "active" | "archived" | "all";
  selected: string;
};

export type KnowledgeReferencedRecord = {
  kind: KnowledgeSourceKind;
  label: string;
  href: string | null;
  detail: string;
};

export type KnowledgeEntryView = {
  id: string;
  title: string;
  category: KnowledgeCategory;
  categoryLabel: string;
  body: string;
  sourceType: KnowledgeSourceType;
  sourceTypeLabel: string;
  sourceKind: KnowledgeSourceKind | null;
  sourceKindLabel: string | null;
  sourceReferenceId: string | null;
  sourceLabel: string | null;
  sourceHref: string | null;
  trustState: KnowledgeTrustState;
  trustLabel: string;
  needsReview: boolean;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastReviewedAt: Date | null;
  createdByName: string | null;
  lastReviewedByName: string | null;
  referencedRecord: KnowledgeReferencedRecord | null;
};

function asSourceType(value: string): KnowledgeSourceType {
  return isKnowledgeSourceType(value) ? value : "OWNER_CREATED";
}

function asTrustState(value: string): KnowledgeTrustState {
  return isKnowledgeTrustState(value) ? value : "UNKNOWN";
}

function asCategory(value: string): KnowledgeCategory {
  return isKnowledgeCategory(value) ? value : "JOB_PROCEDURES";
}

function asSourceKind(value: string | null | undefined): KnowledgeSourceKind | null {
  return isKnowledgeSourceKind(value ?? undefined) ? (value as KnowledgeSourceKind) : null;
}

function money(value: { toString(): string } | null | undefined) {
  if (value == null) return null;
  return value.toString();
}

export async function loadKnowledgeSource(
  prisma: PrismaClient,
  businessId: string,
  rawQuery: {
    area?: string;
    q?: string;
    trust?: string;
    review?: string;
    archive?: string;
    selected?: string;
  } = {},
) {
  const scope = { businessId } as const;
  const query: KnowledgeQuery = {
    area: parseKnowledgeArea(rawQuery.area),
    q: rawQuery.q?.trim() ?? "",
    trust: parseKnowledgeTrustFilter(rawQuery.trust),
    review: parseKnowledgeReviewFilter(rawQuery.review),
    archive: parseKnowledgeArchiveFilter(rawQuery.archive),
    selected: rawQuery.selected?.trim() ?? "",
  };

  const [
    business,
    entries,
    services,
    completedJobs,
    inProgressJobs,
    approvedEstimates,
    expenses,
    approvedTime,
    unapprovedTime,
    marketing,
    reviews,
  ] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true },
    }),
    prisma.knowledgeEntry.findMany({
      where: scope,
      include: {
        createdBy: { select: { user: { select: { name: true } } } },
        reviewedBy: { select: { user: { select: { name: true } } } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.serviceCatalogItem.findMany({
      where: scope,
      select: {
        id: true,
        name: true,
        category: true,
        pricingMode: true,
        price: true,
        active: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.job.findMany({
      where: { ...scope, status: "COMPLETED" },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        customer: { select: { name: true } },
        estimate: {
          select: {
            id: true,
            status: true,
            lineItems: { select: { description: true }, take: 1 },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 40,
    }),
    prisma.job.count({
      where: { ...scope, status: { in: ["UNSCHEDULED", "SCHEDULED", "IN_PROGRESS"] } },
    }),
    prisma.estimate.findMany({
      where: { ...scope, status: "APPROVED" },
      select: {
        id: true,
        status: true,
        total: true,
        updatedAt: true,
        approvedVersion: { select: { total: true, approvedAt: true } },
        customer: { select: { name: true } },
        jobs: { select: { id: true, status: true }, take: 1 },
        lineItems: { select: { description: true }, take: 1 },
        serviceRequest: {
          select: {
            summary: true,
            serviceCatalogItem: { select: { name: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 40,
    }),
    prisma.expense.findMany({
      where: scope,
      select: {
        id: true,
        description: true,
        vendor: true,
        amount: true,
        occurredOn: true,
        category: true,
      },
      orderBy: { occurredOn: "desc" },
      take: 40,
    }),
    prisma.timeEntry.findMany({
      where: { ...scope, status: "APPROVED" },
      select: {
        id: true,
        status: true,
        activityType: true,
        startedAt: true,
        approvedHours: true,
        jobId: true,
      },
      orderBy: { startedAt: "desc" },
      take: 40,
    }),
    prisma.timeEntry.count({
      where: { ...scope, status: { in: ["RUNNING", "READY", "NEEDS_REVIEW"] } },
    }),
    prisma.marketingContent.findMany({
      where: scope,
      select: { id: true, title: true, status: true, contentType: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 40,
    }),
    prisma.review.findMany({
      where: scope,
      select: {
        id: true,
        platform: true,
        rating: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  const serviceById = new Map(services.map((row) => [row.id, row]));
  const estimateById = new Map(approvedEstimates.map((row) => [row.id, row]));
  const jobById = new Map(completedJobs.map((row) => [row.id, row]));
  const expenseById = new Map(expenses.map((row) => [row.id, row]));
  const timeById = new Map(approvedTime.map((row) => [row.id, row]));
  const marketingById = new Map(marketing.map((row) => [row.id, row]));
  const reviewById = new Map(reviews.map((row) => [row.id, row]));

  function referencedRecord(
    kind: KnowledgeSourceKind | null,
    id: string | null,
  ): KnowledgeReferencedRecord | null {
    if (!kind || !id) return null;
    const href = sourceRecordHref(kind, id);
    if (kind === "SERVICE") {
      const row = serviceById.get(id);
      if (!row) return { kind, label: "Service (not currently listed)", href, detail: "Referenced service is no longer in the catalog list." };
      const price = money(row.price);
      const priceLabel =
        row.pricingMode === "CUSTOM_QUOTE" || !price
          ? "Custom quote"
          : row.pricingMode === "FIXED"
            ? `Fixed ${price}`
            : `Starting at ${price}`;
      return {
        kind,
        label: row.name,
        href,
        detail: `${row.category} · ${priceLabel}`,
      };
    }
    if (kind === "ESTIMATE") {
      const row = estimateById.get(id);
      if (!row) return { kind, label: "Estimate", href, detail: "Referenced estimate." };
      const total = money(row.approvedVersion?.total ?? row.total);
      const scopeLabel =
        row.serviceRequest?.serviceCatalogItem?.name ??
        row.serviceRequest?.summary ??
        row.lineItems[0]?.description ??
        "Approved estimate";
      const job = row.jobs[0];
      return {
        kind,
        label: scopeLabel,
        href,
        detail: [
          row.status,
          total ? `Approved total ${total}` : null,
          job ? `Related job ${job.status}` : "No related job",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    if (kind === "JOB") {
      const row = jobById.get(id);
      if (!row) return { kind, label: "Completed job", href, detail: "Referenced job." };
      const work = row.estimate?.lineItems[0]?.description ?? "Completed job";
      return {
        kind,
        label: work,
        href,
        detail: `${row.status} · ${row.customer?.name ?? "Customer"}`,
      };
    }
    if (kind === "EXPENSE") {
      const row = expenseById.get(id);
      if (!row) return { kind, label: "Expense", href, detail: "Referenced expense." };
      return {
        kind,
        label: row.description,
        href,
        detail: [row.vendor, money(row.amount), row.category].filter(Boolean).join(" · "),
      };
    }
    if (kind === "TIME") {
      const row = timeById.get(id);
      if (!row) return { kind, label: "Approved time", href, detail: "Referenced approved time." };
      return {
        kind,
        label: "Approved time",
        href,
        detail: [row.activityType, row.approvedHours ? `${row.approvedHours.toString()} h` : null]
          .filter(Boolean)
          .join(" · "),
      };
    }
    if (kind === "MARKETING") {
      const row = marketingById.get(id);
      if (!row) return { kind, label: "Marketing content", href, detail: "Referenced marketing content." };
      return {
        kind,
        label: row.title,
        href,
        detail: `${row.contentType} · ${row.status}`,
      };
    }
    if (kind === "REVIEW") {
      const row = reviewById.get(id);
      if (!row) return { kind, label: "Review", href, detail: "Referenced review." };
      return {
        kind,
        label: row.customer?.name ?? "Recorded review",
        href,
        detail: [row.platform, row.rating ? `${row.rating}★` : "No rating"].join(" · "),
      };
    }
    return null;
  }

  const views: KnowledgeEntryView[] = entries.map((row) => {
    const category = asCategory(row.category);
    const sourceType = asSourceType(row.sourceType);
    const sourceKind = asSourceKind(row.sourceKind);
    const trustState = asTrustState(row.trustState);
    return {
      id: row.id,
      title: row.title,
      category,
      categoryLabel: KNOWLEDGE_CATEGORY_LABELS[category],
      body: row.body,
      sourceType,
      sourceTypeLabel: KNOWLEDGE_SOURCE_TYPE_LABELS[sourceType],
      sourceKind,
      sourceKindLabel: sourceKind ? KNOWLEDGE_SOURCE_KIND_LABELS[sourceKind] : null,
      sourceReferenceId: row.sourceReferenceId,
      sourceLabel: row.sourceLabel,
      sourceHref: sourceRecordHref(sourceKind, row.sourceReferenceId),
      trustState,
      trustLabel: KNOWLEDGE_TRUST_LABELS[trustState],
      needsReview: needsKnowledgeReview(trustState) && !row.archived,
      archived: row.archived,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastReviewedAt: row.lastReviewedAt,
      createdByName: row.createdBy.user.name,
      lastReviewedByName: row.reviewedBy?.user.name ?? null,
      referencedRecord: referencedRecord(sourceKind, row.sourceReferenceId),
    };
  });

  const categoryFilter =
    query.area === "overview" ? null : AREA_TO_CATEGORY[query.area];

  const filtered = views.filter((row) => {
    if (categoryFilter && row.category !== categoryFilter) return false;
    if (query.trust !== "all" && row.trustState !== query.trust) return false;
    if (query.review === "needs-review" && !needsKnowledgeReview(row.trustState)) return false;
    if (query.archive === "active" && row.archived) return false;
    if (query.archive === "archived" && !row.archived) return false;
    return matchesKnowledgeSearch([row.title, row.body, row.sourceLabel], query.q);
  });

  const selected =
    views.find((row) => row.id === query.selected) ??
    filtered[0] ??
    null;

  const active = views.filter((row) => !row.archived);
  const needsReview = active.filter((row) => row.needsReview);
  const recentlyUpdated = active.filter((row) => isRecentlyUpdated(row.updatedAt));

  const byCategory = KNOWLEDGE_CATEGORIES.map((category) => ({
    category,
    label: KNOWLEDGE_CATEGORY_LABELS[category],
    count: active.filter((row) => row.category === category).length,
  }));

  const sourceAvailability = {
    services: { available: services.length > 0, count: services.length },
    completedJobs: { available: completedJobs.length > 0, count: completedJobs.length },
    approvedEstimates: { available: approvedEstimates.length > 0, count: approvedEstimates.length },
    expenses: { available: expenses.length > 0, count: expenses.length },
    approvedTime: { available: approvedTime.length > 0, count: approvedTime.length },
    marketing: { available: marketing.length > 0, count: marketing.length },
    reviews: { available: reviews.length > 0, count: reviews.length },
  };

  const businessRecordsAvailable = Object.values(sourceAvailability).filter((row) => row.available).length;

  return {
    businessId,
    businessName: business?.name ?? "Business",
    query,
    entries: filtered,
    allEntries: views,
    selected,
    recent: active.slice(0, 8),
    needsReview,
    byCategory,
    noAiMessage: NO_AI_MESSAGE,
    takeoff: {
      available: false as const,
      message: TAKEOFF_UNAVAILABLE_MESSAGE,
    },
    incompleteJobsPresent: inProgressJobs > 0,
    unapprovedTimePresent: unapprovedTime > 0,
    sources: {
      ...sourceAvailability,
      servicesList: services.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        pricingMode: row.pricingMode,
        price: money(row.price),
        active: row.active,
      })),
      completedJobsList: completedJobs.map((row) => ({
        id: row.id,
        status: row.status,
        customerName: row.customer?.name ?? "Customer",
        work: row.estimate?.lineItems[0]?.description ?? "Completed job",
        completedAt: row.updatedAt,
      })),
      approvedEstimatesList: approvedEstimates.map((row) => ({
        id: row.id,
        status: row.status,
        total: money(row.approvedVersion?.total ?? row.total),
        date: row.approvedVersion?.approvedAt ?? row.updatedAt,
        scope:
          row.serviceRequest?.serviceCatalogItem?.name ??
          row.serviceRequest?.summary ??
          row.lineItems[0]?.description ??
          "Approved estimate",
        relatedJobId: row.jobs[0]?.id ?? null,
        relatedJobStatus: row.jobs[0]?.status ?? null,
      })),
      expensesList: expenses.map((row) => ({
        id: row.id,
        description: row.description,
        vendor: row.vendor,
        amount: money(row.amount),
        occurredOn: row.occurredOn,
        category: row.category,
      })),
      approvedTimeList: approvedTime.map((row) => ({
        id: row.id,
        status: row.status,
        activityType: row.activityType,
        startedAt: row.startedAt,
        approvedHours: money(row.approvedHours),
        jobId: row.jobId,
      })),
      marketingList: marketing.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        contentType: row.contentType,
        updatedAt: row.updatedAt,
      })),
      reviewsList: reviews.map((row) => ({
        id: row.id,
        platform: row.platform,
        rating: row.rating,
        customerName: row.customer?.name ?? "Customer",
        createdAt: row.createdAt,
      })),
    },
    counts: {
      entries: active.length,
      needsReview: needsReview.length,
      recentlyUpdated: recentlyUpdated.length,
      businessRecordsAvailable,
    },
    learningLoop: LEARNING_LOOP_STEPS,
  };
}

export type KnowledgeSource = Awaited<ReturnType<typeof loadKnowledgeSource>>;
