/**
 * Growth Department domain + isolation verification.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-growth-department.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for growth department checks.");
  process.exit(generateEarly.status ?? 1);
}

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  COST_ROI_UNAVAILABLE_MESSAGE,
  SOCIAL_DISCONNECTED_MESSAGE,
  RANKING_UNAVAILABLE_MESSAGE,
  OWNER_APPROVAL_REQUIRED_MESSAGE,
  parseGrowthArea,
  REACTIVATION_AFTER_DAYS,
} = await import("@/lib/growth");
const { resolveCollectedCash, collectedForJob } = await import("@/lib/collected-cash");
const {
  buildCampaignPerformance,
  buildGrowthFunnel,
  buildReactivationCandidates,
  buildRecoveryQueue,
  buildReferralAttribution,
  buildReviewConversion,
  campaignRoi,
  classifyAttribution,
  outreachEligibility,
  preserveOriginalSource,
  shouldPreserveCustomerFirstTouch,
} = await import("@/lib/growth-engine");
const { loadGrowthWorkspace } = await import("@/lib/growth-data");
const {
  approveReactivationCandidates,
  correctLeadAttribution,
  createGrowthActionRequest,
  GrowthError,
} = await import("@/lib/growth-ops");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");
const { ProductCapabilityRequiredError } = await import("@/lib/product-entitlements/errors");
const { requireProductCapability } = await import("@/lib/product-entitlements");
const { CHANNELS_DISCONNECTED_MESSAGE } = await import("@/lib/marketing");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_growth_department_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for growth department test database.");
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

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

try {
  console.log("\nSTATIC — Growth domain helpers");
  check("Invalid area falls back to overview", parseGrowthArea("ads") === "overview");
  check(
    "ROI is unavailable without recorded cost",
    campaignRoi({ recordedCost: null, collectedRevenue: 400 }).message === COST_ROI_UNAVAILABLE_MESSAGE &&
      campaignRoi({ recordedCost: null, collectedRevenue: 400 }).roi === null,
  );
  check(
    "ROI uses recorded cost only",
    campaignRoi({ recordedCost: 100, collectedRevenue: 400 }).roi === 3 &&
      campaignRoi({ recordedCost: 100, collectedRevenue: 400 }).costAvailable === true,
  );
  check(
    "$1,000 SENT invoice + $400 Payment collects $400",
    resolveCollectedCash({
      invoices: [{ id: "inv-sent", status: "SENT", total: 1000 }],
      payments: [{ id: "pay-partial", amount: 400, invoiceId: "inv-sent" }],
    }).totalCollected === 400,
  );
  check(
    "Legacy PAID invoice with no Payment may use the full total",
    resolveCollectedCash({
      invoices: [{ id: "inv-legacy", status: "PAID", total: 1000 }],
      payments: [],
    }).totalCollected === 1000,
  );
  check(
    "One Payment is not double-counted across invoice and job",
    collectedForJob({
      jobId: "job-1",
      invoices: [{ id: "inv-paid", status: "PAID", total: 1000, jobId: "job-1" }],
      payments: [{ id: "pay-once", amount: 400, invoiceId: "inv-paid", jobId: "job-1" }],
    }).collected === 400,
  );
  check(
    "SENT invoice total is never collected without Payment rows",
    resolveCollectedCash({
      invoices: [{ id: "inv-sent-only", status: "SENT", total: 1000 }],
      payments: [],
    }).totalCollected === 0,
  );
  check(
    "Original source is preserved when a later campaign arrives",
    JSON.stringify(
      preserveOriginalSource(
        { originalLeadSource: "WEBSITE", originalCampaignId: "c1", leadSource: "WEBSITE", campaignId: "c1" },
        { leadSource: "CAMPAIGN", campaignId: "c2" },
      ),
    ) ===
      JSON.stringify({
        originalLeadSource: "WEBSITE",
        originalCampaignId: "c1",
        leadSource: "WEBSITE",
        campaignId: "c1",
      }),
  );
  check(
    "Customer first-touch is kept once recorded",
    shouldPreserveCustomerFirstTouch({ firstLeadSource: "WEBSITE", firstCampaignId: "c1" }) === true,
  );
  const classified = classifyAttribution({
    leadSource: "WEBSITE",
    campaignId: "c1",
    landingPagePath: "/hire/demo/in/reno/handyman",
    isReferral: false,
    isRepeatCustomer: false,
  });
  check("Campaign kind wins over generic source when a campaign is recorded", classified.kind === "CAMPAIGN");
  check("Landing page flag is recorded without inventing rankings", classified.flags.landingPage === true);
  const emptyFunnel = buildGrowthFunnel({
    now: new Date(),
    requests: [],
    estimates: [],
    jobs: [],
    invoices: [],
    pipeline: [],
    customers: [],
    campaigns: [],
    reviews: [],
    reviewRequests: [],
    referrals: [],
    referralRequests: [],
    followUps: [],
    serviceAreas: [],
    localPageDrafts: [],
    publishedLocalPages: [],
    payments: [],
    jobCompletions: [],
  });
  check("Empty records do not fabricate funnel stages", emptyFunnel.stages.length === 0);
  const socialSrc = readFileSync(new URL("../src/lib/growth.ts", import.meta.url), "utf8");
  const workspaceSrc = readFileSync(new URL("../src/components/growth/growth-workspace.tsx", import.meta.url), "utf8");
  check("Growth copy states social is disconnected", socialSrc.includes(SOCIAL_DISCONNECTED_MESSAGE));
  check("Growth UI does not claim PUBLISHED social posts", !workspaceSrc.includes("PUBLISHED"));
  check("Growth copy refuses fake rankings", socialSrc.includes(RANKING_UNAVAILABLE_MESSAGE));
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Growth nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/growth"));
  check("Growth nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/growth"));
  check("MEMBER does not have MANAGE_MARKETING", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MARKETING));
  check("MEMBER does not have MANAGE_REVIEWS", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_REVIEWS));
  check("MEMBER does not have MANAGE_PIPELINE", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_PIPELINE));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Growth", slug: `alpha-growth-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Growth", slug: `beta-growth-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const starterBiz = await prisma.business.create({
    data: { name: "Starter Growth", slug: `starter-growth-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-growth-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-growth-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-growth-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-growth-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const starterOwner = await prisma.user.create({
    data: { name: "Sam Starter", email: `starter-growth-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const starterMem = await prisma.membership.create({
    data: { userId: starterOwner.id, businessId: starterBiz.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);
  const starterAccess = makeAccess(starterBiz.id, "OWNER", starterMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_MARKETING);
    check("MEMBER MANAGE_MARKETING is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_MARKETING is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.MANAGE_MARKETING);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_PIPELINE);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_REVIEWS);
  check("OWNER and ADMIN pass growth role gates", true);

  await prisma.businessSaasSubscription.create({
    data: { businessId: starterBiz.id, status: "active", planCode: "STARTER" },
  });
  try {
    await requireProductCapability(prisma, starterBiz.id, PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    check("Starter plan does not include MARKETING_TOOLS", false);
  } catch (error) {
    check("Starter plan does not include MARKETING_TOOLS", error instanceof ProductCapabilityRequiredError);
  }
  try {
    await requireProductCapability(prisma, starterBiz.id, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
    check("Starter plan does not include REPORTING_INSIGHTS", false);
  } catch (error) {
    check("Starter plan does not include REPORTING_INSIGHTS", error instanceof ProductCapabilityRequiredError);
  }

  const campaignPaid = await prisma.marketingCampaign.create({
    data: {
      businessId: businessA.id,
      name: "Spring mailer",
      sourceKey: "OTHER",
      status: "ACTIVE",
      recordedCost: 50,
    },
  });
  const campaignFree = await prisma.marketingCampaign.create({
    data: {
      businessId: businessA.id,
      name: "No-spend flyer",
      sourceKey: "WEBSITE",
      status: "ACTIVE",
    },
  });
  const betaCampaign = await prisma.marketingCampaign.create({
    data: { businessId: businessB.id, name: "Beta secret ads", status: "ACTIVE" },
  });

  const customer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Ada Homeowner",
      email: "ada@example.com",
      smsConsentStatus: "GRANTED",
      firstLeadSource: "WEBSITE",
      firstCampaignId: campaignPaid.id,
    },
  });
  const repeatCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Prior Customer",
      email: "prior@example.com",
      smsConsentStatus: "GRANTED",
      firstLeadSource: "REFERRAL",
      createdAt: daysAgo(200),
    },
  });
  const revokedCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Revoked Customer",
      smsConsentStatus: "REVOKED",
      firstLeadSource: "MANUAL",
      createdAt: daysAgo(200),
    },
  });
  const emailAfterSmsRevoke = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Email After SMS Revoke",
      email: "still-emailable@example.com",
      smsConsentStatus: "REVOKED",
      firstLeadSource: "MANUAL",
      createdAt: daysAgo(200),
    },
  });
  const staleCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Stale Consent Customer",
      email: "stale@example.com",
      smsConsentStatus: "GRANTED",
      firstLeadSource: "MANUAL",
      createdAt: daysAgo(200),
    },
  });
  const referrer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Rita Referrer", smsConsentStatus: "GRANTED" },
  });
  const referred = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Ned Neighbor",
      firstLeadSource: "REFERRAL",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret", firstLeadSource: "GOOGLE" },
  });

  const neverEstimated = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Never quoted",
      leadSource: "WEBSITE",
      campaignId: campaignPaid.id,
      originalLeadSource: "WEBSITE",
      originalCampaignId: campaignPaid.id,
      landingPagePath: "/hire/alpha/in/reno/handyman",
      localPageSlug: "reno/handyman",
      createdAt: daysAgo(20),
      updatedAt: daysAgo(20),
    },
  });
  const sentRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Sent no response",
      status: "CONVERTED",
      leadSource: "WEBSITE",
      campaignId: campaignPaid.id,
      originalLeadSource: "WEBSITE",
      originalCampaignId: campaignPaid.id,
    },
  });
  const sentEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceRequestId: sentRequest.id,
      status: "SENT",
      total: 900,
      leadSource: "WEBSITE",
      campaignId: campaignPaid.id,
      publicToken: randomUUID(),
      updatedAt: daysAgo(5),
    },
  });
  const lostRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Lost bid",
      leadSource: "CAMPAIGN",
      campaignId: campaignFree.id,
      originalLeadSource: "CAMPAIGN",
      originalCampaignId: campaignFree.id,
    },
  });
  const lostEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceRequestId: lostRequest.id,
      status: "SENT",
      total: 300,
      leadSource: "CAMPAIGN",
      campaignId: campaignFree.id,
      publicToken: randomUUID(),
    },
  });
  await prisma.pipelineOpportunity.create({
    data: {
      businessId: businessA.id,
      serviceRequestId: lostRequest.id,
      ownerStage: "LOST",
      lossReason: "PRICE",
    },
  });
  const wonRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      summary: "Won referral",
      status: "CONVERTED",
      leadSource: "REFERRAL",
      originalLeadSource: "REFERRAL",
    },
  });
  const wonEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      serviceRequestId: wonRequest.id,
      status: "APPROVED",
      total: 400,
      leadSource: "REFERRAL",
      publicToken: randomUUID(),
    },
  });
  const wonJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      estimateId: wonEstimate.id,
      status: "COMPLETED",
      leadSource: "REFERRAL",
      projectToken: randomUUID(),
      updatedAt: daysAgo(2),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      jobId: wonJob.id,
      status: "SENT",
      total: 400,
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      jobId: wonJob.id,
      status: "PAID",
      total: 250,
      paidAt: new Date(),
    },
  });
  const reviewRequest = await prisma.reviewRequest.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      jobId: wonJob.id,
      status: "SENT",
      createdByMembershipId: ownerMem.id,
    },
  });
  await prisma.review.create({
    data: {
      businessId: businessA.id,
      customerId: referred.id,
      jobId: wonJob.id,
      reviewRequestId: reviewRequest.id,
      platform: "GOOGLE",
      websiteSelected: true,
      responseStatus: "APPROVED",
      recordedByMembershipId: ownerMem.id,
    },
  });
  await prisma.referral.create({
    data: {
      businessId: businessA.id,
      sourceCustomerId: referrer.id,
      referredCustomerId: referred.id,
      status: "CONVERTED",
    },
  });

  const oldJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: repeatCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      updatedAt: daysAgo(REACTIVATION_AFTER_DAYS + 5),
    },
  });
  const revokedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: revokedCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      updatedAt: daysAgo(REACTIVATION_AFTER_DAYS + 10),
    },
  });
  const emailRevokeJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: emailAfterSmsRevoke.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      updatedAt: daysAgo(REACTIVATION_AFTER_DAYS + 8),
    },
  });
  const staleJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: staleCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      updatedAt: daysAgo(REACTIVATION_AFTER_DAYS + 6),
    },
  });
  async function recordJobCompleted(jobId, at) {
    await prisma.businessEvent.create({
      data: {
        businessId: businessA.id,
        type: "JOB_COMPLETED",
        subjectType: "JOB",
        subjectId: jobId,
        occurredAt: at,
        idempotencyKey: `JOB_COMPLETED:${jobId}`,
      },
    });
  }
  await recordJobCompleted(oldJob.id, daysAgo(REACTIVATION_AFTER_DAYS + 5));
  await recordJobCompleted(revokedJob.id, daysAgo(REACTIVATION_AFTER_DAYS + 10));
  await recordJobCompleted(emailRevokeJob.id, daysAgo(REACTIVATION_AFTER_DAYS + 8));
  await recordJobCompleted(staleJob.id, daysAgo(REACTIVATION_AFTER_DAYS + 6));
  await prisma.job.update({
    where: { id: oldJob.id },
    data: { leadSource: "MANUAL" },
  });

  const missedRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Missed follow-up",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
    },
  });
  await prisma.pipelineOpportunity.create({
    data: {
      businessId: businessA.id,
      serviceRequestId: missedRequest.id,
      ownerStage: "FOLLOW_UP",
      followUpOn: daysAgo(2),
    },
  });

  const area = await prisma.serviceArea.create({
    data: {
      businessId: businessA.id,
      kind: "CITY",
      label: "Reno",
      city: "Reno",
      enabled: true,
    },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "In-area lead",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
      matchedServiceAreaId: area.id,
      serviceAreaQualification: "IN_AREA",
    },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Outside",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
      serviceAreaQualification: "OUTSIDE_PREFERRED",
    },
  });

  await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      summary: "Beta only",
      leadSource: "GOOGLE",
      campaignId: betaCampaign.id,
      originalLeadSource: "GOOGLE",
      originalCampaignId: betaCampaign.id,
    },
  });

  const workspace = await loadGrowthWorkspace(prisma, businessA.id);
  const betaWorkspace = await loadGrowthWorkspace(prisma, businessB.id);

  check("Funnel includes recorded lead and estimate stages", workspace.funnel.stages.some((row) => row.key === "lead") && workspace.funnel.stages.some((row) => row.key === "estimate"));
  check("Funnel includes collected only when PAID invoices exist", workspace.funnel.stages.some((row) => row.key === "collected"));
  check("Tenant isolation: Beta workspace does not include Alpha leads", betaWorkspace.totals.leads === 1 && !betaWorkspace.attributions.some((row) => row.requestId === neverEstimated.id));
  check("Legacy PAID invoice with no Payment uses the invoice total", workspace.totals.collected === 250 && workspace.totals.invoiced === 650);
  check("Social stays disconnected", workspace.social.connected === false && workspace.social.message === SOCIAL_DISCONNECTED_MESSAGE);
  check("Marketing channel honesty is reused", workspace.social.channelsMessage === CHANNELS_DISCONNECTED_MESSAGE);
  check("Local growth refuses ranking data", workspace.localHonesty === RANKING_UNAVAILABLE_MESSAGE);

  const paidPerf = workspace.campaigns.find((row) => row.campaignId === campaignPaid.id);
  const freePerf = workspace.campaigns.find((row) => row.campaignId === campaignFree.id);
  check("Campaign with cost calculates ROI from recorded cost", Boolean(paidPerf?.costAvailable && paidPerf.roi != null));
  check("Campaign without cost says ROI unavailable", Boolean(freePerf && freePerf.costAvailable === false && freePerf.roiMessage === COST_ROI_UNAVAILABLE_MESSAGE));

  const recoveryQueues = new Set(workspace.recovery.map((row) => row.queue));
  check("Recovery includes never estimated", recoveryQueues.has("NEVER_ESTIMATED"));
  check("Recovery includes sent/no response", recoveryQueues.has("ESTIMATE_NO_RESPONSE"));
  check("Recovery includes lost", recoveryQueues.has("ESTIMATE_LOST"));
  check("Recovery includes missed follow-up", recoveryQueues.has("MISSED_FOLLOW_UP"));
  check("Review conversion uses sent requests", workspace.reviews.requestsSent === 1 && workspace.reviews.reviewsReceived === 1 && workspace.reviews.requestConversion === 1);
  check("Referral revenue is counted once", workspace.referrals.length === 1 && workspace.referrals[0].collectedRevenue === 250 && workspace.referrals[0].invoicedRevenue === 650);

  const eligible = workspace.reactivation.filter((row) => row.customerId === repeatCustomer.id);
  const revoked = workspace.reactivation.filter((row) => row.customerId === revokedCustomer.id);
  const emailOnly = workspace.reactivation.filter((row) => row.customerId === emailAfterSmsRevoke.id);
  check(
    "Reactivation includes prior completed customer",
    eligible.length === 1 &&
      eligible[0].anyOutreachEligible === true &&
      eligible[0].completionSource === "JOB_COMPLETED",
  );
  check(
    "Unrelated completed-job edit does not restart the reactivation clock",
    eligible[0].daysSinceCompleted >= REACTIVATION_AFTER_DAYS,
  );
  check(
    "SMS revoked without email is not outreach-eligible",
    revoked.length === 1 && revoked[0].smsEligible === false && revoked[0].emailEligible === false && revoked[0].anyOutreachEligible === false,
  );
  check(
    "SMS revoked with a usable email remains email-eligible and SMS blocked",
    emailOnly.length === 1 &&
      emailOnly[0].emailEligible === true &&
      emailOnly[0].smsEligible === false &&
      emailOnly[0].anyOutreachEligible === true,
  );
  const outreachRevokedEmail = outreachEligibility({ smsConsentStatus: "REVOKED", email: "still-emailable@example.com" });
  check("Channel helper keeps email open after SMS revoke", outreachRevokedEmail.emailEligible && !outreachRevokedEmail.smsEligible);

  const corrected = await correctLeadAttribution(prisma, ownerA, {
    requestId: neverEstimated.id,
    leadSource: "GOOGLE",
    reason: "Owner confirmed Google",
  });
  check("Working source can be corrected", corrected.leadSource === "GOOGLE");
  check("Original source survives correction", corrected.originalLeadSource === "WEBSITE" && corrected.originalCampaignId === campaignPaid.id);
  const customerAfter = await prisma.customer.findUnique({ where: { id: customer.id } });
  check("Customer first-touch is not overwritten by correction", customerAfter.firstLeadSource === "WEBSITE" && customerAfter.firstCampaignId === campaignPaid.id);
  const audit = await prisma.leadAttributionCorrection.findMany({
    where: { businessId: businessA.id, recordId: neverEstimated.id },
  });
  check("Attribution correction writes an audit row", audit.length === 1 && audit[0].previousLeadSource === "WEBSITE" && audit[0].newLeadSource === "GOOGLE");

  try {
    await correctLeadAttribution(prisma, memberA, {
      requestId: neverEstimated.id,
      leadSource: "FACEBOOK",
    });
    check("MEMBER cannot correct attribution", false);
  } catch (error) {
    check("MEMBER cannot correct attribution", error instanceof ForbiddenError);
  }

  try {
    await correctLeadAttribution(prisma, ownerB, {
      requestId: neverEstimated.id,
      leadSource: "FACEBOOK",
    });
    check("Cross-tenant attribution correction is rejected", false);
  } catch {
    check("Cross-tenant attribution correction is rejected", true);
  }

  const action = await createGrowthActionRequest(prisma, ownerA, {
    kind: "RECOVERY",
    queue: "NEVER_ESTIMATED",
    serviceRequestId: neverEstimated.id,
  });
  check("Recovery action is durable and does not send", action.status === "OPEN" && action.kind === "RECOVERY");
  const event = await prisma.businessEvent.findFirst({
    where: { businessId: businessA.id, type: "GROWTH_RECOVERY_QUEUED", subjectId: action.id },
  });
  check("Recovery emits an action-suggestion event", Boolean(event) && event.payload?.autoMessage === false);

  try {
    await approveReactivationCandidates(prisma, ownerA, { customerIds: [revokedCustomer.id] });
    check("Revoked customer cannot be approved for reactivation", false);
  } catch (error) {
    check("Revoked customer cannot be approved for reactivation", error instanceof GrowthError);
  }
  try {
    await approveReactivationCandidates(prisma, adminA, { customerIds: [emailAfterSmsRevoke.id] });
    check("ADMIN cannot approve reactivation", false);
  } catch (error) {
    check(
      "ADMIN cannot approve reactivation",
      error instanceof GrowthError && error.message === OWNER_APPROVAL_REQUIRED_MESSAGE,
    );
  }
  const prepared = await createGrowthActionRequest(prisma, adminA, {
    kind: "REACTIVATION",
    queue: "REACTIVATION",
    customerId: emailAfterSmsRevoke.id,
  });
  check("ADMIN may prepare an open reactivation action", prepared.status === "OPEN");

  await prisma.customer.update({
    where: { id: staleCustomer.id },
    data: { email: null, smsConsentStatus: "REVOKED" },
  });
  try {
    await approveReactivationCandidates(prisma, ownerA, { customerIds: [staleCustomer.id] });
    check("Stale consent is rechecked on approval", false);
  } catch (error) {
    check("Stale consent is rechecked on approval", error instanceof GrowthError);
  }

  const neverCompleted = await prisma.customer.create({
    data: { businessId: businessA.id, name: "No Work Customer", smsConsentStatus: "GRANTED", email: "nowork@example.com" },
  });
  try {
    await approveReactivationCandidates(prisma, ownerA, { customerIds: [neverCompleted.id] });
    check("Approval revalidates completed-work facts", false);
  } catch (error) {
    check("Approval revalidates completed-work facts", error instanceof GrowthError);
  }

  try {
    await createGrowthActionRequest(prisma, ownerA, {
      kind: "RECOVERY",
      queue: "NEVER_ESTIMATED",
      customerId: referred.id,
      serviceRequestId: neverEstimated.id,
    });
    check("Same-tenant wrong-customer related IDs are rejected", false);
  } catch (error) {
    check(
      "Same-tenant wrong-customer related IDs are rejected",
      error instanceof GrowthError && /same customer/.test(error.message),
    );
  }

  const approved = await approveReactivationCandidates(prisma, ownerA, { customerIds: [repeatCustomer.id] });
  const approvedAgain = await approveReactivationCandidates(prisma, ownerA, { customerIds: [repeatCustomer.id] });
  check("Owner can approve an outreach-eligible reactivation", approved.length === 1 && approved[0].status === "APPROVED");
  check("Double-click/retry creates one logical reactivation action", approvedAgain[0].id === approved[0].id);
  const reactivationCount = await prisma.growthActionRequest.count({
    where: { businessId: businessA.id, kind: "REACTIVATION", customerId: repeatCustomer.id },
  });
  check("One reactivation row exists after retry", reactivationCount === 1);

  const recoveryAgain = await createGrowthActionRequest(prisma, ownerA, {
    kind: "RECOVERY",
    queue: "NEVER_ESTIMATED",
    serviceRequestId: neverEstimated.id,
  });
  check("Double-click/retry creates one logical recovery action", recoveryAgain.id === action.id);

  try {
    await createGrowthActionRequest(prisma, starterAccess, {
      kind: "RECOVERY",
      queue: "NEVER_ESTIMATED",
    });
    check("Starter plan cannot write Growth actions", false);
  } catch (error) {
    check(
      "Starter plan cannot write Growth actions",
      error instanceof ProductCapabilityRequiredError || error.name === "ProductCapabilityRequiredError",
    );
  }

  const local = workspace.local;
  check("Local growth surfaces a recorded service area", local.some((row) => row.label === "Reno" && row.requestCount >= 1));
  check("Missing coverage is called out without rankings", local.some((row) => row.strength === "missing"));
  check("Recommendations include evidence", workspace.recommendations.every((row) => row.evidence.length > 0 && row.why.length > 0));

  const betaActions = await prisma.growthActionRequest.count({ where: { businessId: businessB.id } });
  check("Growth actions stay tenant-scoped", betaActions === 0);

  const cashJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const cashInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: cashJob.id,
      status: "SENT",
      total: 1000,
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      invoiceId: cashInvoice.id,
      jobId: cashJob.id,
      purpose: "INVOICE_BALANCE",
      amount: 400,
      method: "CASH",
    },
  });
  const cashWorkspace = await loadGrowthWorkspace(prisma, businessA.id);
  check(
    "Workspace collected adds $400 Payment, not the $1,000 SENT total",
    cashWorkspace.totals.collected === 650,
  );
  const cashCampaignJob = cashWorkspace.funnel.stages.find((row) => row.key === "collected");
  check("Funnel collected amount uses Payment truth", cashCampaignJob?.amount === 650);
  const referralAfter = cashWorkspace.referrals[0];
  check(
    "Referral collected stays on the referred customer's own cash",
    referralAfter.collectedRevenue === 250,
  );

  console.log("\nGrowth department check complete.");
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} growth department check(s) failed.`);
  process.exit(1);
}
console.log("\nAll growth department checks passed.");
