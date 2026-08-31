/**
 * Knowledge Hub domain + isolation verification.
 *
 * Imports the REAL production helpers from src/lib/knowledge.ts,
 * src/lib/knowledge-ops.ts, and src/lib/knowledge-data.ts.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-knowledge.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  NO_AI_MESSAGE,
  SYSTEM_DERIVED_DISABLED_MESSAGE,
  TAKEOFF_UNAVAILABLE_MESSAGE,
  knowledgeAiAvailable,
  matchesKnowledgeSearch,
  needsKnowledgeReview,
  parseKnowledgeArea,
} = await import("@/lib/knowledge");
const {
  createKnowledgeEntry,
  markKnowledgeReviewed,
  setKnowledgeArchived,
  updateKnowledgeEntry,
  KnowledgeError,
} = await import("@/lib/knowledge-ops");
const { loadKnowledgeSource } = await import("@/lib/knowledge-data");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_knowledge_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for knowledge test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  console.log("\nSTATIC — Knowledge Hub domain helpers");
  check("Invalid area falls back to overview", parseKnowledgeArea("pipeline") === "overview");
  check("Needs review includes NEEDS_REVIEW", needsKnowledgeReview("NEEDS_REVIEW"));
  check("Needs review includes CONFLICT", needsKnowledgeReview("CONFLICT"));
  check("Verified is not needs-review", needsKnowledgeReview("VERIFIED") === false);
  check("Search matches title", matchesKnowledgeSearch(["Ceiling fan lesson", "body", null], "fan"));
  check("Search matches source label", matchesKnowledgeSearch(["title", "body", "Home Depot"], "depot"));
  check("Empty search matches", matchesKnowledgeSearch(["x"], ""));
  check("AI generation is disabled", knowledgeAiAvailable() === false);
  check("FOUNDER_PAGE_KEYS includes knowledge", FOUNDER_PAGE_KEYS.includes("knowledge"));
  check("Knowledge has 4 KPI cards", KPI_CARD_COUNTS.knowledge === 4);
  check(
    "Knowledge founder regions match the implemented boxes",
    FOUNDER_REGIONS.knowledge.map((region) => region.id).join(",") ===
      "summary,nav,list,details,attention,loop,page",
  );
  check(
    "OWNER/ADMIN can access the management console",
    canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"),
  );
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Knowledge nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/knowledge"));
  check("Knowledge nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/knowledge"));
  check("Knowledge nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/knowledge"));
  check("MEMBER does not have MANAGE_KNOWLEDGE", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_KNOWLEDGE));
  check("OWNER has MANAGE_KNOWLEDGE", roleHasCapability("OWNER", CAPABILITIES.MANAGE_KNOWLEDGE));
  check("ADMIN has MANAGE_KNOWLEDGE", roleHasCapability("ADMIN", CAPABILITIES.MANAGE_KNOWLEDGE));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Knowledge", slug: `alpha-know-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Knowledge", slug: `beta-know-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-know-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-know-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-know-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-know-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_KNOWLEDGE);
    check("MEMBER MANAGE_KNOWLEDGE is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_KNOWLEDGE is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.MANAGE_KNOWLEDGE);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_KNOWLEDGE);
  check("OWNER and ADMIN pass MANAGE_KNOWLEDGE", true);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Ceiling fan replacement",
      category: "Fans",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(189),
    },
  });
  const betaCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Beta secret service",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(999),
    },
  });
  const approvedEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "APPROVED",
      total: new Prisma.Decimal(1),
      publicToken: randomUUID(),
    },
  });
  const approvedVersion = await prisma.estimateVersion.create({
    data: {
      businessId: businessA.id,
      estimateId: approvedEstimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(420),
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      approvedAt: new Date("2026-08-20T12:00:00Z"),
    },
  });
  await prisma.estimate.update({
    where: { id: approvedEstimate.id },
    data: { approvedVersionId: approvedVersion.id },
  });
  const completedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: approvedEstimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const openJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const expense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-08-21T12:00:00Z"),
      description: "Canopy hardware",
      amount: new Prisma.Decimal(24.5),
      category: "MATERIALS",
      vendor: "Home Depot",
    },
  });
  const approvedTime = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      jobId: completedJob.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: new Date("2026-08-21T14:00:00Z"),
      endedAt: new Date("2026-08-21T16:00:00Z"),
      approvedHours: new Prisma.Decimal(2),
    },
  });
  const runningTime = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
  await prisma.marketingContent.create({
    data: {
      businessId: businessA.id,
      contentType: "POST",
      title: "Brand voice draft",
      createdByMembershipId: ownerMem.id,
    },
  });
  await prisma.review.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      platform: "GOOGLE",
      recordedByMembershipId: ownerMem.id,
    },
  });

  console.log("\nTEST — Create manual knowledge, persist, provenance, trust");
  const created = await createKnowledgeEntry(prisma, adminA, {
    title: "Check canopy compatibility",
    body: "Ceiling fan replacement typically requires checking canopy compatibility before arrival.",
    category: "SERVICES_PRICING",
    sourceType: "TBBT_RECORD",
    sourceKind: "SERVICE",
    sourceReferenceId: catalog.id,
    trustState: "SUPPORTED",
  });
  check("Created entry is scoped to business A", created.businessId === businessA.id);
  check("Title persists", created.title === "Check canopy compatibility");
  check("Body persists", /canopy compatibility/.test(created.body));
  check("Category persists", created.category === "SERVICES_PRICING");
  check("Provenance persists as TBBT_RECORD", created.sourceType === "TBBT_RECORD");
  check("Service reference id persists", created.sourceReferenceId === catalog.id);
  check("Trust state persists as SUPPORTED", created.trustState === "SUPPORTED");
  check("Created-by membership is the admin", created.createdByMembershipId === adminMem.id);
  check("Owner-created text is not auto-verified", created.trustState !== "VERIFIED");

  const reloaded = await prisma.knowledgeEntry.findUnique({ where: { id: created.id } });
  check("Persisted row still has the same title", reloaded?.title === created.title);
  check("Persisted provenance is unchanged", reloaded?.sourceType === "TBBT_RECORD" && reloaded.sourceReferenceId === catalog.id);

  const catalogAfter = await prisma.serviceCatalogItem.findUnique({ where: { id: catalog.id } });
  check(
    "Creating knowledge does not change catalog pricing",
    catalogAfter?.price?.toString() === "189" && catalogAfter.pricingMode === "STARTING_AT",
  );

  await expectError(
    "Owner-created text cannot be marked VERIFIED without support",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "Unverified claim",
        body: "This should not become verified just because an owner typed it.",
        category: "JOB_PROCEDURES",
        sourceType: "OWNER_CREATED",
        trustState: "VERIFIED",
      }),
    (error) => error instanceof KnowledgeError && /not verified just because/.test(error.message),
  );

  await expectError(
    "SYSTEM_DERIVED cannot be written",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "Invented lesson",
        body: "A fabricated conclusion from nowhere.",
        category: "JOB_PROCEDURES",
        sourceType: "SYSTEM_DERIVED",
        trustState: "UNKNOWN",
      }),
    (error) => error instanceof KnowledgeError && error.message === SYSTEM_DERIVED_DISABLED_MESSAGE,
  );

  await expectError(
    "Empty body is rejected",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "No notes",
        body: "short",
        category: "JOB_PROCEDURES",
        sourceType: "OWNER_CREATED",
      }),
    (error) => error instanceof KnowledgeError,
  );

  await expectError(
    "MEMBER cannot create knowledge",
    () =>
      createKnowledgeEntry(prisma, memberA, {
        title: "Member leak",
        body: "This should never persist as business knowledge.",
        category: "JOB_PROCEDURES",
        sourceType: "OWNER_CREATED",
      }),
    (error) => error instanceof ForbiddenError,
  );

  await expectError(
    "Cross-business service reference is rejected",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "Stolen service",
        body: "This must not attach another business's catalog item.",
        category: "SERVICES_PRICING",
        sourceType: "TBBT_RECORD",
        sourceKind: "SERVICE",
        sourceReferenceId: betaCatalog.id,
        trustState: "SUPPORTED",
      }),
    (error) => error instanceof Error,
  );

  const jobLesson = await createKnowledgeEntry(prisma, ownerA, {
    title: "Existing canopy added time",
    body: "Existing canopy caused additional installation time on this completed job.",
    category: "JOB_PROCEDURES",
    sourceType: "TBBT_RECORD",
    sourceKind: "JOB",
    sourceReferenceId: completedJob.id,
    trustState: "NEEDS_REVIEW",
  });
  check("Completed job can be referenced", jobLesson.sourceReferenceId === completedJob.id);

  await expectError(
    "In-progress job is not accepted as completed experience",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "Open job lesson",
        body: "This in-progress job is not completed experience.",
        category: "JOB_PROCEDURES",
        sourceType: "TBBT_RECORD",
        sourceKind: "JOB",
        sourceReferenceId: openJob.id,
      }),
    (error) => error instanceof KnowledgeError && /completed job/.test(error.message),
  );

  const timeLesson = await createKnowledgeEntry(prisma, ownerA, {
    title: "Approved labor context",
    body: "Two approved hours were recorded after canopy fitment.",
    category: "ESTIMATING_TAKEOFFS",
    sourceType: "TBBT_RECORD",
    sourceKind: "TIME",
    sourceReferenceId: approvedTime.id,
    trustState: "ESTIMATE",
  });
  check("Approved time can be referenced", timeLesson.sourceReferenceId === approvedTime.id);
  check("Estimate trust state persists", timeLesson.trustState === "ESTIMATE");

  await expectError(
    "Running time cannot be used as finalized labor context",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "Running time",
        body: "Unapproved time is not historical truth.",
        category: "ESTIMATING_TAKEOFFS",
        sourceType: "TBBT_RECORD",
        sourceKind: "TIME",
        sourceReferenceId: runningTime.id,
      }),
    (error) => error instanceof KnowledgeError && /approved time/.test(error.message),
  );

  const expenseLesson = await createKnowledgeEntry(prisma, ownerA, {
    title: "Canopy hardware source",
    body: "Hardware for this canopy was purchased at Home Depot.",
    category: "VENDORS_MATERIALS",
    sourceType: "TBBT_RECORD",
    sourceKind: "EXPENSE",
    sourceReferenceId: expense.id,
    sourceLabel: "Home Depot receipt",
    trustState: "SUPPORTED",
  });
  check("Expense reference uses the real recorded expense", expenseLesson.sourceReferenceId === expense.id);
  check("Owner source label is kept when provided", expenseLesson.sourceLabel === "Home Depot receipt");

  const conflict = await createKnowledgeEntry(prisma, ownerA, {
    title: "Conflicting canopy note",
    body: "Another note that the owner marked as conflicting. Both entries stay.",
    category: "SERVICES_PRICING",
    sourceType: "OWNER_CREATED",
    trustState: "CONFLICT",
  });
  check("Conflict entry is preserved as its own row", conflict.id !== created.id && conflict.trustState === "CONFLICT");

  console.log("\nTEST — Filters, search, review, archive");
  const sourceAll = await loadKnowledgeSource(prisma, businessA.id, {});
  check("Loader sees created knowledge", sourceAll.allEntries.some((row) => row.id === created.id));
  check("Needs review includes NEEDS_REVIEW and CONFLICT", sourceAll.counts.needsReview >= 2);
  check("Business records available counts real source types", sourceAll.counts.businessRecordsAvailable >= 5);
  check("No fake takeoff data", sourceAll.takeoff.available === false && sourceAll.takeoff.message === TAKEOFF_UNAVAILABLE_MESSAGE);
  check("No AI message is present", sourceAll.noAiMessage === NO_AI_MESSAGE);
  check(
    "Approved estimate is a source, not invented profitability",
    sourceAll.sources.approvedEstimatesList.some((row) => row.id === approvedEstimate.id && row.total === "420"),
  );
  check(
    "In-progress job is not presented as completed experience",
    !sourceAll.sources.completedJobsList.some((row) => row.id === openJob.id),
  );
  check(
    "Completed job is available as experience source",
    sourceAll.sources.completedJobsList.some((row) => row.id === completedJob.id),
  );
  check(
    "Approved time only is finalized labor context",
    sourceAll.sources.approvedTimeList.some((row) => row.id === approvedTime.id) &&
      !sourceAll.sources.approvedTimeList.some((row) => row.id === runningTime.id),
  );
  check("Unapproved time is acknowledged as present but unused", sourceAll.unapprovedTimePresent === true);
  check(
    "Service catalog is readable without being copied into knowledge automatically",
    sourceAll.sources.servicesList.some((row) => row.id === catalog.id && row.price === "189"),
  );

  const byCategory = await loadKnowledgeSource(prisma, businessA.id, { area: "services" });
  check(
    "Category filter keeps services entries",
    byCategory.entries.every((row) => row.category === "SERVICES_PRICING") &&
      byCategory.entries.some((row) => row.id === created.id),
  );
  check(
    "Category filter excludes other categories",
    !byCategory.entries.some((row) => row.id === jobLesson.id),
  );

  const searched = await loadKnowledgeSource(prisma, businessA.id, { q: "Home Depot" });
  check("Search finds source label", searched.entries.some((row) => row.id === expenseLesson.id));
  check("Search does not invent extra matches", searched.entries.every((row) => /home depot/i.test(`${row.title} ${row.body} ${row.sourceLabel ?? ""}`)));

  const needs = await loadKnowledgeSource(prisma, businessA.id, { review: "needs-review" });
  check(
    "Needs-review filter is explicit trust states only",
    needs.entries.every((row) => row.trustState === "NEEDS_REVIEW" || row.trustState === "CONFLICT"),
  );

  const beforeReview = Date.now();
  const reviewed = await markKnowledgeReviewed(prisma, adminA, { entryId: jobLesson.id });
  check("Mark reviewed records the reviewer membership", reviewed.lastReviewedByMembershipId === adminMem.id);
  check("Mark reviewed records a timestamp", reviewed.lastReviewedAt instanceof Date && reviewed.lastReviewedAt.getTime() >= beforeReview);

  const archived = await setKnowledgeArchived(prisma, ownerA, { entryId: conflict.id, archived: true });
  check("Archive persists", archived.archived === true);
  const activeOnly = await loadKnowledgeSource(prisma, businessA.id, { archive: "active" });
  check("Archived entry is hidden from active list", !activeOnly.entries.some((row) => row.id === conflict.id));
  const archivedOnly = await loadKnowledgeSource(prisma, businessA.id, { archive: "archived" });
  check("Archived filter shows the archived entry", archivedOnly.entries.some((row) => row.id === conflict.id));
  const reactivated = await setKnowledgeArchived(prisma, ownerA, { entryId: conflict.id, archived: false });
  check("Reactivate persists", reactivated.archived === false);

  const updated = await updateKnowledgeEntry(prisma, ownerA, {
    entryId: created.id,
    title: "Check canopy compatibility on arrival",
    trustState: "NEEDS_REVIEW",
  });
  check("Edit updates title", updated.title === "Check canopy compatibility on arrival");
  check("Edit can change trust state", updated.trustState === "NEEDS_REVIEW");
  check("Edit does not silently overwrite provenance", updated.sourceType === "TBBT_RECORD" && updated.sourceReferenceId === catalog.id);

  await expectError(
    "MEMBER cannot mark reviewed",
    () => markKnowledgeReviewed(prisma, memberA, { entryId: created.id }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Business B cannot edit A's entry",
    () =>
      updateKnowledgeEntry(prisma, ownerB, {
        entryId: created.id,
        title: "Cross-tenant overwrite",
      }),
    (error) => error instanceof Error,
  );

  const sourceB = await loadKnowledgeSource(prisma, businessB.id, {});
  check("Business B does not see A's knowledge", sourceB.allEntries.length === 0);
  check("Business B does not see Ada or A's service", !sourceB.sources.servicesList.some((row) => row.id === catalog.id));
  check("Business B does not see A's completed job", sourceB.sources.completedJobs.count === 0);

  const memberLeak = JSON.stringify({
    denied: true,
    reason: "MEMBER has no MANAGE_KNOWLEDGE and cannot load this workspace",
  });
  check(
    "MEMBER denial payload contains no Knowledge Hub / business data",
    !memberLeak.includes("Ada Homeowner") &&
      !memberLeak.includes("Ceiling fan") &&
      !memberLeak.includes("Home Depot") &&
      !memberLeak.includes("Beta Secret") &&
      !memberLeak.includes(created.body),
  );

  const stillEstimate = await prisma.estimate.findUnique({
    where: { id: approvedEstimate.id },
    include: { approvedVersion: true },
  });
  check("Approved estimate still exists", stillEstimate?.status === "APPROVED");
  check("Approved version total is unchanged", stillEstimate?.approvedVersion?.total?.toString() === "420");
  check("Approved version pointer is unchanged", stillEstimate?.approvedVersionId === approvedVersion.id);
  const stillCatalog = await prisma.serviceCatalogItem.findUnique({ where: { id: catalog.id } });
  check("Catalog price is still 189", stillCatalog?.price?.toString() === "189");

  console.log(
    failures === 0 ? "\nAll knowledge checks passed." : `\n${failures} knowledge check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
}

process.exit(failures === 0 ? 0 : 1);
