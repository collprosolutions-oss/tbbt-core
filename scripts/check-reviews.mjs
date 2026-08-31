/**
 * Reviews workspace domain + isolation verification.
 *
 * Imports the REAL production helpers from src/lib/reviews.ts,
 * src/lib/reviews-ops.ts, and src/lib/reviews-data.ts.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-reviews.mjs
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
  PLATFORMS_DISCONNECTED_MESSAGE,
  PERFORMANCE_INTERNAL_MESSAGE,
  REQUEST_SEND_DISCLAIMER,
  RESPONSE_PUBLISH_DISCLAIMER,
  isReminderDue,
  nextRequestStatus,
  nextResponseStatus,
  parseReviewArea,
  recommendedOpportunityAction,
  reviewAiAssistAvailable,
  reviewNeedsAttention,
  suggestedRequestText,
} = await import("@/lib/reviews");
const {
  advanceReviewRequestStatus,
  advanceReviewResponseStatus,
  cancelReviewRequest,
  createReviewRequest,
  recordReceivedReview,
  ReviewsError,
  updateReviewRequest,
  upsertReviewResponse,
} = await import("@/lib/reviews-ops");
const { loadReviewsSource } = await import("@/lib/reviews-data");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_reviews_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for reviews test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
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
  console.log("\nSTATIC — Reviews domain helpers");
  check("Invalid area falls back to overview", parseReviewArea("pipeline") === "overview");
  check("DRAFT advances to READY", nextRequestStatus("DRAFT") === "READY");
  check("READY advances to SENT", nextRequestStatus("READY") === "SENT");
  check("SENT has no fake external-send next step", nextRequestStatus("SENT") === null);
  check("DRAFT response advances to READY_FOR_REVIEW", nextResponseStatus("DRAFT") === "READY_FOR_REVIEW");
  check("READY_FOR_REVIEW advances to APPROVED", nextResponseStatus("READY_FOR_REVIEW") === "APPROVED");
  check("APPROVED has no publish next step", nextResponseStatus("APPROVED") === null);
  check("AI assist is not enabled in this step", reviewAiAssistAvailable() === false);
  check("Rating 3 flags attention", reviewNeedsAttention({ rating: 3 }) === true);
  check("Rating 4 does not flag attention", reviewNeedsAttention({ rating: 4 }) === false);
  check("Suggested request text asks for an honest review", /honest review/.test(suggestedRequestText({ customerName: "Ada", businessName: "CollPro" })));
  check("Suggested request text does not ask for 5 stars", !/5-star|five star|positive review/i.test(suggestedRequestText({ customerName: "Ada", businessName: "CollPro" })));
  check("FOUNDER_PAGE_KEYS includes reviews", FOUNDER_PAGE_KEYS.includes("reviews"));
  check("Reviews has 5 KPI cards", KPI_CARD_COUNTS.reviews === 5);
  check(
    "Reviews founder regions match the implemented boxes",
    FOUNDER_REGIONS.reviews.map((region) => region.id).join(",") ===
      "summary,nav,opportunities,requests,reviews,rail,page",
  );
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Reviews nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/reviews"));
  check("Reviews nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/reviews"));
  check("Reviews nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/reviews"));
  check("MEMBER does not have MANAGE_REVIEWS", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_REVIEWS));
  check("Send disclaimer does not claim an external send", /did not send/i.test(REQUEST_SEND_DISCLAIMER));
  check("Response disclaimer does not claim publishing", /does not publish/i.test(RESPONSE_PUBLISH_DISCLAIMER));
  check(
    "Completed job with no request recommends prepare",
    recommendedOpportunityAction({ requestStatus: null, reminderDue: false, hasReview: false }) === "prepare_request",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Reviews", slug: `alpha-rev-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Reviews", slug: `beta-rev-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-rev-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-rev-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-rev-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-rev-${randomUUID()}@example.com`, passwordHash: "x" },
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
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_REVIEWS);
    check("MEMBER MANAGE_REVIEWS is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_REVIEWS is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.MANAGE_REVIEWS);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_REVIEWS);
  check("OWNER and ADMIN pass MANAGE_REVIEWS", true);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
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
  const secondJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: job.id,
      status: "PAID",
      total: 180,
      paidAt: new Date("2026-08-20T12:00:00Z"),
      paymentMethod: "CASH",
    },
  });

  console.log("\nTEST — Completed job creates a review opportunity");
  const before = await loadReviewsSource(prisma, businessA.id);
  check("Completed job appears as an opportunity", before.openOpportunities.some((row) => row.jobId === job.id));
  check("Second completed job is also an opportunity", before.openOpportunities.some((row) => row.jobId === secondJob.id));
  check("In-progress job is not a review opportunity", !before.opportunities.some((row) => row.jobId === openJob.id));
  check("Opportunity includes invoice/payment context", before.opportunities.find((row) => row.jobId === job.id)?.invoice?.status === "PAID");
  check("No Google rating is fabricated", before.platforms.connected === false && before.platforms.message === PLATFORMS_DISCONNECTED_MESSAGE);
  check("Business A does not see Beta's completed job", before.opportunities.every((row) => row.jobId !== betaJob.id));

  await expectError(
    "In-progress job cannot become a review request",
    () =>
      createReviewRequest(prisma, ownerA, {
        customerId: customer.id,
        jobId: openJob.id,
      }),
    (error) => error instanceof ReviewsError && /completed job/.test(error.message),
  );

  await expectError(
    "MEMBER cannot prepare a review request",
    () =>
      createReviewRequest(prisma, memberA, {
        customerId: customer.id,
        jobId: job.id,
      }),
    (error) => error instanceof ForbiddenError,
  );

  const draft = await createReviewRequest(prisma, adminA, {
    customerId: customer.id,
    jobId: job.id,
    intendedPlatform: "GOOGLE",
    reminderAt: "2026-08-15",
  });
  check("Request is created as DRAFT", draft.status === "DRAFT");
  check("Request text asks for an honest review", /honest review/.test(draft.requestText));
  check("Reminder date persists on create", draft.reminderAt instanceof Date && draft.reminderAt.getFullYear() === 2026);
  check("Created request is scoped to business A", draft.businessId === businessA.id);

  await expectError(
    "Duplicate request for the same completed job is blocked",
    () =>
      createReviewRequest(prisma, ownerA, {
        customerId: customer.id,
        jobId: job.id,
      }),
    (error) => error instanceof ReviewsError && /already exists/.test(error.message),
  );

  const afterCreate = await loadReviewsSource(prisma, businessA.id);
  check(
    "Job with an active request is no longer an open opportunity",
    !afterCreate.openOpportunities.some((row) => row.jobId === job.id),
  );
  check(
    "Job still appears in the opportunity list with request-exists state",
    afterCreate.opportunities.find((row) => row.jobId === job.id)?.requestStatus === "DRAFT",
  );

  console.log("\nTEST — Review request lifecycle DRAFT → READY → SENT");
  const ready = await advanceReviewRequestStatus(prisma, ownerA, { requestId: draft.id });
  check("DRAFT → READY", ready.status === "READY");
  const sent = await advanceReviewRequestStatus(prisma, ownerA, { requestId: draft.id });
  check("READY → SENT", sent.status === "SENT");
  check("SENT records requestedAt", sent.requestedAt instanceof Date);

  await expectError(
    "SENT has no fake external-send next step",
    () => advanceReviewRequestStatus(prisma, ownerA, { requestId: draft.id }),
    (error) => error instanceof ReviewsError && /did not send/.test(error.message),
  );

  const reminderUpdated = await updateReviewRequest(prisma, ownerA, {
    requestId: draft.id,
    reminderAt: "2026-08-01",
  });
  check(
    "Reminder date can be updated after send",
    reminderUpdated.reminderAt instanceof Date &&
      reminderUpdated.reminderAt.getFullYear() === 2026 &&
      reminderUpdated.reminderAt.getMonth() === 7 &&
      reminderUpdated.reminderAt.getDate() === 1,
  );
  check(
    "Follow-up is due when reminder date is in the past",
    isReminderDue({
      status: "SENT",
      reminderAt: reminderUpdated.reminderAt,
      hasReview: false,
      now: new Date("2026-08-31T12:00:00Z"),
    }) === true,
  );

  console.log("\nTEST — Record received review and negative attention");
  const review = await recordReceivedReview(prisma, ownerA, {
    customerId: customer.id,
    jobId: job.id,
    reviewRequestId: draft.id,
    platform: "GOOGLE",
    rating: "2",
    reviewText: "The work took longer than expected.",
    externalReviewDate: "2026-08-25",
  });
  check("Review is recorded against the request", review.reviewRequestId === draft.id);
  check("Low rating flags needsAttention", review.needsAttention === true);
  check("Marketing text is not auto-copied / auto-eligible", review.marketingEligible === false);
  const completedRequest = await prisma.reviewRequest.findFirst({ where: { id: draft.id } });
  check("Linked request becomes COMPLETED", completedRequest?.status === "COMPLETED");

  const sourceAfterReview = await loadReviewsSource(prisma, businessA.id);
  check("Reviews recorded count is 1", sourceAfterReview.counts.received === 1);
  check("Attention list includes the low rating", sourceAfterReview.attention.some((row) => row.id === review.id));
  check("Performance is labeled internal", sourceAfterReview.performance.message === PERFORMANCE_INTERNAL_MESSAGE);
  check("Performance does not invent a Google average", sourceAfterReview.platforms.connected === false);

  await expectError(
    "MEMBER cannot record a review",
    () =>
      recordReceivedReview(prisma, memberA, {
        customerId: customer.id,
        platform: "GOOGLE",
        reviewText: "Should fail",
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nTEST — Response draft lifecycle DRAFT → READY_FOR_REVIEW → APPROVED");
  const response = await upsertReviewResponse(prisma, adminA, {
    reviewId: review.id,
    body: "Thank you for taking the time to share your experience. We appreciate your feedback.",
  });
  check("Response starts as DRAFT", response.status === "DRAFT");
  const readyResponse = await advanceReviewResponseStatus(prisma, ownerA, { responseId: response.id });
  check("DRAFT → READY_FOR_REVIEW", readyResponse.status === "READY_FOR_REVIEW");
  const approvedResponse = await advanceReviewResponseStatus(prisma, ownerA, { responseId: response.id });
  check("READY_FOR_REVIEW → APPROVED", approvedResponse.status === "APPROVED");
  check("Approval records reviewer", approvedResponse.reviewedByMembershipId === ownerMem.id);

  await expectError(
    "APPROVED has no fake PUBLISHED next step",
    () => advanceReviewResponseStatus(prisma, ownerA, { responseId: response.id }),
    (error) => error instanceof ReviewsError && /not available/.test(error.message),
  );

  const sourceFinal = await loadReviewsSource(prisma, businessA.id);
  check(
    "Review response status is APPROVED on the recorded review",
    sourceFinal.reviews.find((row) => row.id === review.id)?.responseStatus === "APPROVED",
  );
  check("Customer history can see the request", sourceFinal.requests.some((row) => row.customerId === customer.id));
  check("Customer history can see the review", sourceFinal.reviews.some((row) => row.customerId === customer.id));

  console.log("\nTEST — Tenant isolation and cancel-then-recreate");
  await expectError(
    "Business B cannot create a request on A's job",
    () =>
      createReviewRequest(prisma, ownerB, {
        customerId: customer.id,
        jobId: job.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business B cannot record a review on A's customer",
    () =>
      recordReceivedReview(prisma, ownerB, {
        customerId: customer.id,
        platform: "GOOGLE",
        reviewText: "Should fail",
      }),
    (error) => error instanceof Error,
  );

  const sourceB = await loadReviewsSource(prisma, businessB.id);
  check("Business B does not see Ada or A's reviews", sourceB.reviews.length === 0 && sourceB.requests.length === 0);
  check("Business B completed job is only its own", sourceB.opportunities.some((row) => row.jobId === betaJob.id));

  const extra = await createReviewRequest(prisma, ownerA, {
    customerId: customer.id,
    jobId: secondJob.id,
  });
  await cancelReviewRequest(prisma, ownerA, { requestId: extra.id });
  const replacement = await createReviewRequest(prisma, ownerA, {
    customerId: customer.id,
    jobId: secondJob.id,
  });
  check("Cancelled request allows a new request for the same job", replacement.status === "DRAFT" && replacement.jobId === secondJob.id);

  console.log(
    failures === 0 ? "\nAll reviews checks passed." : `\n${failures} reviews check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
