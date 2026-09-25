/**
 * AI Chief of Staff Growth specialist proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-growth-specialist.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const {
  GROWTH_CONTEXT_CAPS,
  GROWTH_OWNED_RECOMMENDATION_KEYS,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  getGrowthSpecialistInterpretationCount,
  getLastGrowthProjection,
  growthProjectionHasForbiddenFields,
  interpretGrowthSpecialist,
  loadCanonicalRecommendationCatalog,
  loadSpecialistContext,
  planSpecialists,
  resetGrowthSpecialistCounters,
  resetLastGrowthProjection,
  runChiefOfStaffCoach,
  synthesizeCoachAnswer,
} = await import("@/lib/chief-of-staff");
const { getSpecialistEntry } = await import("@/lib/chief-of-staff/registry");
const { setInjectedGrowthLoadFailure } = await import("@/lib/chief-of-staff/growth-snapshot");
const { getGrowthSourceLoadCount, resetGrowthSourceLoadCount } = await import("@/lib/growth-data");
const { REACTIVATION_AFTER_DAYS } = await import("@/lib/growth");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");
const { grantProductCapability } = await import("@/lib/product-entitlements");
const { buildBsosHealthMetrics } = await import("@/lib/bsos");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_growth_specialist_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: "owner@example.com", name: "Owner" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function entitleFounder(businessId) {
  await prisma.businessSaasSubscription.create({
    data: {
      businessId,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
}

async function createOwnerWorkspace(name) {
  const user = await prisma.user.create({
    data: { name: `${name} Owner`, email: `${name}-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER" },
  });
  return {
    user,
    business,
    membership,
    access: makeAccess(business.id, "OWNER", membership.id, user.id),
  };
}

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

function resetLoads() {
  resetGrowthSourceLoadCount();
  resetGrowthSpecialistCounters();
  resetLastGrowthProjection();
}

async function seedWithheldGrowthSignals(businessId) {
  const customer = await prisma.customer.create({
    data: { businessId, name: "Withheld Recovery", smsConsentStatus: "UNKNOWN" },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId,
      customerId: customer.id,
      summary: "Withheld never estimated",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
      createdAt: daysAgo(21),
      updatedAt: daysAgo(21),
    },
  });
  const prior = await prisma.customer.create({
    data: {
      businessId,
      name: "Withheld Prior",
      email: `withheld-${randomUUID()}@example.com`,
      smsConsentStatus: "GRANTED",
      createdAt: daysAgo(200),
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId,
      customerId: prior.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      updatedAt: daysAgo(REACTIVATION_AFTER_DAYS + 10),
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: job.id,
      occurredAt: daysAgo(REACTIVATION_AFTER_DAYS + 10),
      idempotencyKey: `JOB_COMPLETED:${job.id}`,
    },
  });
}

function assertGrowthFactsWithheld(label, catalog) {
  const attention = loadSpecialistContext("ATTENTION", catalog, "What should I focus on this week?");
  const metrics = buildBsosHealthMetrics(catalog.facts);
  check(`${label}: catalog.growth.entitled === false`, catalog.growth.entitled === false);
  check(`${label}: catalog.growth.source === null`, catalog.growth.source == null);
  check(`${label}: facts.growthRecoveryOpen === undefined`, catalog.facts.growthRecoveryOpen === undefined);
  check(`${label}: facts.growthReactivationEligible === undefined`, catalog.facts.growthReactivationEligible === undefined);
  check(
    `${label}: no growth-lost-lead-recovery recommendation`,
    catalog.recommendations.every((row) => row.key !== "growth-lost-lead-recovery") &&
      catalog.activeRecommendations.every((row) => row.key !== "growth-lost-lead-recovery"),
  );
  check(
    `${label}: no growth-reactivate-customers recommendation`,
    catalog.recommendations.every((row) => row.key !== "growth-reactivate-customers") &&
      catalog.activeRecommendations.every((row) => row.key !== "growth-reactivate-customers"),
  );
  check(`${label}: ATTENTION has no growth-recovery fact value`, attention.facts["growth-recovery"] == null);
  check(`${label}: ATTENTION has no growth-reactivation fact value`, attention.facts["growth-reactivation"] == null);
  check(
    `${label}: Business Health does not display a fabricated Growth zero`,
    !metrics.some((row) => row.key === "growth-recovery"),
  );
}

try {
  const growthSrc = readFileSync(new URL("../src/lib/chief-of-staff/growth-specialist.ts", import.meta.url), "utf8");
  const snapshotSrc = readFileSync(new URL("../src/lib/chief-of-staff/growth-snapshot.ts", import.meta.url), "utf8");
  const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
  const opsSrc = readFileSync(new URL("../src/lib/growth-ops.ts", import.meta.url), "utf8");
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  console.log("\nSTATIC — Growth specialist is read/explain only");
  const entry = getSpecialistEntry("GROWTH");
  check("GROWTH remains the existing specialist identity", entry.id === "GROWTH" && entry.enabled === true);
  check("Role floor stays VIEW_REPORTS", entry.requiredRoleCapability === CAPABILITIES.VIEW_REPORTS);
  check("Registry product field stays MARKETING_TOOLS", entry.requiredProductCapability === "MARKETING_TOOLS");
  check("Approval class is READ_EXPLAIN", entry.approvalClass === "READ_EXPLAIN");
  check("Growth specialist performs no LLM call", !growthSrc.includes("runAiTask") && !growthSrc.includes("resolveAiProvider"));
  check("Growth specialist does not load GrowthSource itself", !growthSrc.includes("loadGrowthSource("));
  check("Growth specialist does not load a Growth workspace", !growthSrc.includes("loadGrowthWorkspace("));
  check(
    "Growth specialist has no domain writes",
    !growthSrc.includes("createGrowthActionRequest") &&
      !growthSrc.includes("approveReactivation") &&
      !growthSrc.includes("growthActionRequest.create") &&
      !growthSrc.includes("marketingCampaign.create") &&
      !growthSrc.includes("reviewRequest.create") &&
      !growthSrc.includes("customerCommunication") &&
      !growthSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal"),
  );
  check("Growth specialist does not import write ops", !growthSrc.includes("growth-ops"));
  check(
    "Canonical Growth recommendation keys are reused, not invented",
    GROWTH_OWNED_RECOMMENDATION_KEYS.join(",") ===
      "growth-lost-lead-recovery,growth-reactivate-customers,repeat-customer-follow-up,request-reviews,market-completed-jobs,outside-area-leads",
  );
  check("Write ops remain outside the specialist", opsSrc.includes("createGrowthActionRequest"));
  check("No Prisma schema change is required for Growth specialist", schemaSrc.includes("model GrowthActionRequest"));
  check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
  check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);

  const recoverPlan = planSpecialists({
    question: "Which lost leads can I recover from the lead funnel?",
    activeRecommendationKeys: [],
  });
  const reactivatePlan = planSpecialists({
    question: "Which prior customers can I reactivate for repeat business?",
    activeRecommendationKeys: [],
  });
  const campaignPlan = planSpecialists({
    question: "How are my campaigns, attribution, and lead sources converting?",
    activeRecommendationKeys: [],
  });
  const reviewPlan = planSpecialists({
    question: "What review, referral, and local marketing opportunities do I have?",
    activeRecommendationKeys: [],
  });
  const genericFocus = planSpecialists({
    question: "What should I focus on this week?",
    activeRecommendationKeys: [],
  });
  const recPlan = planSpecialists({
    question: "What should I focus on this week?",
    activeRecommendationKeys: ["growth-lost-lead-recovery"],
  });
  const financialPlan = planSpecialists({
    question: "How is my profit and outstanding invoices this month?",
    activeRecommendationKeys: [],
  });
  const workforcePlan = planSpecialists({
    question: "Which worker should I assign to tomorrow's schedule?",
    activeRecommendationKeys: [],
  });
  check("8. Planner selects Growth for recovery / lead funnel", recoverPlan.selectedIds.includes("GROWTH"));
  check("8. Planner selects Growth for reactivation", reactivatePlan.selectedIds.includes("GROWTH"));
  check("8. Planner selects Growth for campaigns / attribution", campaignPlan.selectedIds.includes("GROWTH"));
  check("8. Planner selects Growth for reviews / referrals / local marketing", reviewPlan.selectedIds.includes("GROWTH"));
  check("10. Generic focus does not select Growth without evidence", !genericFocus.selectedIds.includes("GROWTH"));
  check("9. Active canonical Growth recommendation selects Growth", recPlan.selectedIds.includes("GROWTH"));
  const explicitReactivate = planSpecialists({
    question: "Should I reactivate prior customers?",
    activeRecommendationKeys: [],
  });
  const explicitLostLeads = planSpecialists({
    question: "What should I do about lost leads?",
    activeRecommendationKeys: [],
  });
  const explicitAttribution = planSpecialists({
    question: "Should I review my marketing attribution?",
    activeRecommendationKeys: [],
  });
  const kitchenFocus = planSpecialists({
    question: "What should I focus on this week for invoices, staff, materials, vault, growth, and knowledge?",
    activeRecommendationKeys: ["collect-unpaid-invoices", "workforce-unassigned-job"],
  });
  check("C. Explicit reactivation question selects Growth without a recommendation", explicitReactivate.selectedIds.includes("GROWTH"));
  check("D. Explicit lost-lead question selects Growth", explicitLostLeads.selectedIds.includes("GROWTH"));
  check("E. Explicit marketing attribution question selects Growth", explicitAttribution.selectedIds.includes("GROWTH"));
  check(
    "F. Kitchen-sink generic focus does not load every department",
    kitchenFocus.selectedIds.every((id) => id === "ATTENTION" || id === "WORKFORCE" || id === "FINANCIAL") &&
      !kitchenFocus.selectedIds.includes("GROWTH") &&
      kitchenFocus.fanout <= 4,
  );
  check("7. Unrelated Financial question does not select Growth", !financialPlan.selectedIds.includes("GROWTH"));
  check("Financial selection remains unchanged", financialPlan.selectedIds.includes("FINANCIAL"));
  check("Workforce selection remains unchanged", workforcePlan.selectedIds.includes("WORKFORCE") && !workforcePlan.selectedIds.includes("GROWTH"));
  check("24. Fan-out stays at or under 4", recoverPlan.fanout <= 4 && recPlan.fanout <= 4);
  check("25. Recursion depth stays 1", recoverPlan.recursionDepth === 1 && recPlan.recursionDepth === 1);

  const tenantA = await createOwnerWorkspace("Alpha Growth");
  const tenantB = await createOwnerWorkspace("Beta Growth");
  const starter = await createOwnerWorkspace("Starter Growth");
  const memberUser = await prisma.user.create({
    data: { name: "Member", email: `member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(tenantA.business.id, "MEMBER", memberMem.id, memberUser.id);

  await entitleFounder(tenantA.business.id);
  await entitleFounder(tenantB.business.id);
  await prisma.businessSaasSubscription.create({
    data: { businessId: starter.business.id, status: "active", planCode: "STARTER" },
  });

  console.log("\nAUTH — tenant isolation, MEMBER, entitlement");
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
    check("2. MEMBER remains blocked from VIEW_REPORTS", false);
  } catch (error) {
    check("2. MEMBER remains blocked from VIEW_REPORTS", error instanceof ForbiddenError);
  }
  try {
    await runChiefOfStaffCoach(prisma, memberAccess, {
      question: "Which leads should I recover?",
      attemptId: randomUUID(),
    });
    check("2. MEMBER remains blocked from Coach", false);
  } catch (error) {
    check(
      "2. MEMBER remains blocked from Coach",
      error instanceof ForbiddenError,
    );
  }

  const campaigns = [];
  for (let i = 0; i < 6; i += 1) {
    campaigns.push(
      await prisma.marketingCampaign.create({
        data: {
          businessId: tenantA.business.id,
          name: `Alpha campaign ${i + 1}`,
          sourceKey: "OTHER",
          status: "ACTIVE",
          recordedCost: i === 0 ? 40 : undefined,
        },
      }),
    );
  }
  await prisma.marketingCampaign.create({
    data: { businessId: tenantB.business.id, name: "Beta Secret Ads 9999", status: "ACTIVE" },
  });

  const customerA = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Ada Homeowner",
      email: "ada-secret@example.com",
      phone: "555-0100",
      smsConsentStatus: "GRANTED",
    },
  });
  const unknownConsent = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Unknown Consent",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: tenantB.business.id, name: "Beta Secret Customer", smsConsentStatus: "GRANTED" },
  });

  const leadSources = ["WEBSITE", "GOOGLE", "REFERRAL", "MANUAL", "CAMPAIGN", null];
  for (let i = 0; i < 10; i += 1) {
    await prisma.serviceRequest.create({
      data: {
        businessId: tenantA.business.id,
        customerId: customerA.id,
        summary: `Never quoted ${i + 1}`,
        leadSource: leadSources[i % leadSources.length],
        campaignId: campaigns[i % campaigns.length].id,
        originalLeadSource: leadSources[i % leadSources.length],
        originalCampaignId: campaigns[i % campaigns.length].id,
        createdAt: daysAgo(20),
        updatedAt: daysAgo(20),
      },
    });
  }
  await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: unknownConsent.id,
      summary: "Unknown consent lead",
      leadSource: null,
      createdAt: daysAgo(18),
      updatedAt: daysAgo(18),
    },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: tenantB.business.id,
      customerId: customerB.id,
      summary: "Beta secret recovery",
      leadSource: "GOOGLE",
      createdAt: daysAgo(20),
      updatedAt: daysAgo(20),
    },
  });

  for (let i = 0; i < 10; i += 1) {
    const prior = await prisma.customer.create({
      data: {
        businessId: tenantA.business.id,
        name: `Prior Customer ${i + 1}`,
        email: `prior-${i}@example.com`,
        smsConsentStatus: "GRANTED",
        createdAt: daysAgo(200),
      },
    });
    const job = await prisma.job.create({
      data: {
        businessId: tenantA.business.id,
        customerId: prior.id,
        status: "COMPLETED",
        projectToken: randomUUID(),
        updatedAt: daysAgo(REACTIVATION_AFTER_DAYS + 5 + i),
      },
    });
    await prisma.businessEvent.create({
      data: {
        businessId: tenantA.business.id,
        type: "JOB_COMPLETED",
        subjectType: "JOB",
        subjectId: job.id,
        occurredAt: daysAgo(REACTIVATION_AFTER_DAYS + 5 + i),
        idempotencyKey: `JOB_COMPLETED:${job.id}`,
      },
    });
  }

  const completedForReview = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: tenantA.business.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: completedForReview.id,
      occurredAt: daysAgo(10),
      idempotencyKey: `JOB_COMPLETED:${completedForReview.id}`,
    },
  });

  resetLoads();
  const catalogA = await loadCanonicalRecommendationCatalog(prisma, tenantA.business.id);
  const catalogB = await loadCanonicalRecommendationCatalog(prisma, tenantB.business.id);
  const catalogStarter = await loadCanonicalRecommendationCatalog(prisma, starter.business.id);
  check("1. Tenant A catalog does not include Beta secret campaign", !JSON.stringify(catalogA.growth).includes("9999"));
  check("1. Tenant B catalog is scoped to B", JSON.stringify(catalogB.growth.source?.campaigns ?? []).includes("9999"));
  check("3/4. Starter Growth snapshot is not entitled", catalogStarter.growth.entitled === false);
  check("3/4. Starter has no deep Growth source", catalogStarter.growth.source == null);
  check(
    "3/4. Starter missing both required capabilities",
    catalogStarter.growth.missingCapabilities.includes(PRODUCT_CAPABILITIES.MARKETING_TOOLS) &&
      catalogStarter.growth.missingCapabilities.includes(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS),
  );
  check(
    "3/4. Starter omits Growth count facts instead of fabricating zeros",
    catalogStarter.facts.growthRecoveryOpen === undefined &&
      catalogStarter.facts.growthReactivationEligible === undefined,
  );
  check("5. Founder catalog attaches the entitled Growth source", catalogA.growth.entitled === true && catalogA.growth.source != null);

  const starterResult = interpretGrowthSpecialist(catalogStarter, "Which leads should I recover?");
  check("3/4. Missing both capabilities → SKIPPED", starterResult.status === "SKIPPED");
  check("3/4. Skip names Marketing Tools and Reporting Insights", /Marketing Tools/i.test(starterResult.limitation ?? "") && /Reporting/i.test(starterResult.limitation ?? ""));
  check("3/4. Skip does not invent zero opportunities", !/0 opportunities|zero recovery/i.test(starterResult.limitation ?? ""));
  check("3/4. Skip has no deep projection", getLastGrowthProjection() == null && starterResult.findings.length === 0);

  resetLastGrowthProjection();
  const denyMarketing = interpretGrowthSpecialist(
    catalogA,
    "Which leads should I recover?",
    undefined,
    [PRODUCT_CAPABILITIES.MARKETING_TOOLS],
  );
  check("3. Missing MARKETING_TOOLS → SKIPPED", denyMarketing.status === "SKIPPED");
  check("3. MARKETING_TOOLS skip names Marketing Tools", /Marketing Tools/i.test(denyMarketing.limitation ?? ""));
  check("3. Denied MARKETING_TOOLS has no deep projection", getLastGrowthProjection() == null);

  resetLastGrowthProjection();
  const denyReporting = interpretGrowthSpecialist(
    catalogA,
    "Which leads should I recover?",
    undefined,
    [PRODUCT_CAPABILITIES.REPORTING_INSIGHTS],
  );
  check("4. Missing REPORTING_INSIGHTS → SKIPPED", denyReporting.status === "SKIPPED");
  check("4. REPORTING_INSIGHTS skip names Reporting Insights", /Reporting/i.test(denyReporting.limitation ?? ""));
  check("4. Denied REPORTING_INSIGHTS has no deep projection", getLastGrowthProjection() == null);

  resetLastGrowthProjection();
  const okResult = interpretGrowthSpecialist(catalogA, "Explain my lead funnel, recovery, and campaigns.");
  const projection = getLastGrowthProjection();
  check("5. Both capabilities → Growth OK", okResult.status === "OK");
  check("5. OK result uses the existing specialist id", okResult.specialistId === "GROWTH");
  check("11. Recovery is bounded to 8", Boolean(projection) && projection.recovery.length <= GROWTH_CONTEXT_CAPS.recovery);
  check("12. Reactivation is bounded to 8", Boolean(projection) && projection.reactivation.length <= GROWTH_CONTEXT_CAPS.reactivation);
  check("13. Campaigns are bounded to 5", Boolean(projection) && projection.campaigns.length <= GROWTH_CONTEXT_CAPS.campaigns);
  check("14. Sources are bounded to 5", Boolean(projection) && projection.sources.length <= GROWTH_CONTEXT_CAPS.sources);
  check("15. Projection excludes raw PII / secrets", !growthProjectionHasForbiddenFields(projection) && !JSON.stringify(projection).includes("ada-secret@example.com") && !JSON.stringify(projection).includes("555-0100"));
  check("16. Recovery candidates are not described as recovered", projection.recovery.every((row) => row.recovered === false) && okResult.findings.every((row) => !/\brecovered\b/i.test(row.summary)));
  check("17. Reactivation candidates are not described as contacted", projection.reactivation.every((row) => row.contacted === false) && okResult.findings.every((row) => !/\bcontacted\b/i.test(row.summary)));
  check(
    "18. Unknown attribution stays unknown",
    projection.sources.some((row) => row.source === "UNKNOWN" && row.attributed === false) &&
      okResult.findings.some((row) => /unknown|unattributed/i.test(row.summary)),
  );
  check(
    "Canonical recommendation keys stay dismissible catalog keys",
    okResult.recommendationKeys.every((key) => GROWTH_OWNED_RECOMMENDATION_KEYS.includes(key)),
  );
  check(
    "Transient findings are not persisted recommendation keys",
    okResult.findings
      .filter((row) => row.key.startsWith("growth-") && !GROWTH_OWNED_RECOMMENDATION_KEYS.includes(row.key))
      .every((row) => row.recommendationKeys.length === 0),
  );
  check("Consent UNKNOWN is not treated as granted", !JSON.stringify(okResult.findings).includes("granted consent"));
  check(
    "Owner facts use full totals when detail is capped",
    Boolean(projection?.totals) &&
      okResult.factKeys.includes("growth-recovery") &&
      projection.totals.recovery >= projection.recovery.length &&
      projection.totals.reactivationEligible >= projection.reactivation.filter((row) => row.outreachEligible).length,
  );
  check(
    "C. Entitled workspace keeps actual Growth counts",
    catalogA.facts.growthRecoveryOpen != null &&
      catalogA.facts.growthRecoveryOpen.count > 0 &&
      catalogA.facts.growthReactivationEligible != null &&
      catalogA.facts.growthReactivationEligible.count > 0,
  );
  check(
    "C. Canonical Growth recommendations still work when entitled",
    catalogA.activeRecommendations.some((row) => row.key === "growth-lost-lead-recovery") &&
      catalogA.activeRecommendations.some((row) => row.key === "growth-reactivate-customers"),
  );
  check(
    "C. Business Health may display the real recovery count",
    buildBsosHealthMetrics(catalogA.facts).some(
      (row) => row.key === "growth-recovery" && row.value === String(catalogA.facts.growthRecoveryOpen.count),
    ),
  );

  const providerGrowthFinding =
    okResult.findings.find((row) => row.key === "growth-recovery-open") ?? okResult.findings[0];
  const providerFinancialFinding = {
    key: "review-low-margin-jobs",
    title: "Review recorded low-margin work",
    summary: "One recorded job has a negative margin.",
    recommendationKeys: ["review-low-margin-jobs"],
    factKeys: ["low-margin"],
  };
  const providerSynthesis = synthesizeCoachAnswer({
    question: "Which lost leads can I recover and how are campaigns converting?",
    catalog: catalogA,
    specialistResults: [
      {
        specialistId: "FINANCIAL",
        status: "OK",
        findings: [providerFinancialFinding],
        factKeys: ["low-margin"],
        recommendationKeys: ["review-low-margin-jobs"],
      },
      okResult,
    ],
    conflicts: {
      items: [],
      uniqueRecommendationKeys: [...okResult.recommendationKeys, "review-low-margin-jobs"],
    },
    coachContext: {
      facts: catalogA.facts,
      recommendations: catalogA.activeRecommendations,
      metrics: [],
      goals: [],
      actionItems: [],
    },
  });
  const recordedFindings = providerSynthesis.payload.recordedFindings ?? [];
  const providerPayload = JSON.stringify(providerSynthesis.payload);
  check(
    "Provider recordedFindings includes the bounded Growth finding",
    Array.isArray(recordedFindings) &&
      recordedFindings.some(
        (row) => row.key === providerGrowthFinding.key && row.title === providerGrowthFinding.title && row.summary === providerGrowthFinding.summary,
      ),
  );
  check(
    "Provider payload contains the Growth finding title and summary",
    providerPayload.includes(providerGrowthFinding.title) && providerPayload.includes(providerGrowthFinding.summary),
  );
  check(
    "Provider payload keeps Financial recorded findings",
    recordedFindings.some((row) => row.key === "review-low-margin-jobs" && row.title === providerFinancialFinding.title),
  );
  check(
    "Provider payload does not include a full GrowthSource",
    !providerPayload.includes("reviewRequests") &&
      !providerPayload.includes("localPageDrafts") &&
      !providerPayload.includes("publishedLocalPages") &&
      !providerPayload.includes("\"requests\""),
  );
  check(
    "Provider payload has no forbidden Growth PII",
    !growthProjectionHasForbiddenFields(providerSynthesis.payload) &&
      !providerPayload.includes("ada-secret@example.com") &&
      !providerPayload.includes("555-0100"),
  );
  check("Provider payload does not name a Growth specialist", !/Growth specialist/i.test(providerPayload) && !/Growth Agent/i.test(providerSynthesis.output.text));
  check(
    "Fallback still includes Growth finding summaries",
    providerSynthesis.output.text.includes(providerGrowthFinding.summary),
  );

  console.log("\nENTITLEMENT — Growth facts stay absent unless both capabilities load");
  const missingMarketing = await createOwnerWorkspace("Missing Marketing Growth");
  await prisma.businessSaasSubscription.create({
    data: { businessId: missingMarketing.business.id, status: "active", planCode: "STARTER" },
  });
  await grantProductCapability(prisma, {
    businessId: missingMarketing.business.id,
    capability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    source: "SUPPORT",
    note: "Reporting only",
  });
  await seedWithheldGrowthSignals(missingMarketing.business.id);
  const catalogMissingMarketing = await loadCanonicalRecommendationCatalog(prisma, missingMarketing.business.id);
  assertGrowthFactsWithheld("A. Missing MARKETING_TOOLS", catalogMissingMarketing);
  check(
    "A. Missing MARKETING_TOOLS is named on the snapshot",
    catalogMissingMarketing.growth.missingCapabilities.includes(PRODUCT_CAPABILITIES.MARKETING_TOOLS),
  );
  const missingMarketingPlan = planSpecialists({
    question: "Which lost leads can I recover?",
    activeRecommendationKeys: [],
  });
  const missingMarketingResult = interpretGrowthSpecialist(catalogMissingMarketing, "Which lost leads can I recover?");
  check("A. Explicit Growth question still selects GROWTH", missingMarketingPlan.selectedIds.includes("GROWTH"));
  check("A. Selected Growth SKIPS truthfully without a required capability", missingMarketingResult.status === "SKIPPED");

  const missingReporting = await createOwnerWorkspace("Missing Reporting Growth");
  await prisma.businessSaasSubscription.create({
    data: { businessId: missingReporting.business.id, status: "active", planCode: "STARTER" },
  });
  await grantProductCapability(prisma, {
    businessId: missingReporting.business.id,
    capability: PRODUCT_CAPABILITIES.MARKETING_TOOLS,
    source: "SUPPORT",
    note: "Marketing only",
  });
  await seedWithheldGrowthSignals(missingReporting.business.id);
  const catalogMissingReporting = await loadCanonicalRecommendationCatalog(prisma, missingReporting.business.id);
  assertGrowthFactsWithheld("B. Missing REPORTING_INSIGHTS", catalogMissingReporting);
  check(
    "B. Missing REPORTING_INSIGHTS is named on the snapshot",
    catalogMissingReporting.growth.missingCapabilities.includes(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS),
  );
  const missingReportingPlan = planSpecialists({
    question: "Should I reactivate prior customers?",
    activeRecommendationKeys: [],
  });
  const missingReportingResult = interpretGrowthSpecialist(catalogMissingReporting, "Should I reactivate prior customers?");
  check("B. Explicit Growth question still selects GROWTH", missingReportingPlan.selectedIds.includes("GROWTH"));
  check("B. Selected Growth SKIPS truthfully without Reporting Insights", missingReportingResult.status === "SKIPPED");

  setInjectedGrowthLoadFailure(true);
  const failedCatalog = await loadCanonicalRecommendationCatalog(prisma, tenantA.business.id);
  setInjectedGrowthLoadFailure(false);
  const failedAttention = loadSpecialistContext("ATTENTION", failedCatalog, "What should I focus on this week?");
  check("D. Entitled workspace + load failure marks the snapshot failed", failedCatalog.growth.failed === true && failedCatalog.growth.source == null);
  check("D. Failed load does not expose Growth count facts", failedCatalog.facts.growthRecoveryOpen === undefined && failedCatalog.facts.growthReactivationEligible === undefined);
  check(
    "D. Failed load does not invent Growth recovery/reactivation recommendations",
    failedCatalog.recommendations.every((row) => row.key !== "growth-lost-lead-recovery" && row.key !== "growth-reactivate-customers"),
  );
  check(
    "D. Failed load does not fabricate a zero Growth metric",
    !buildBsosHealthMetrics(failedCatalog.facts).some((row) => row.key === "growth-recovery"),
  );
  check("D. ATTENTION survives without Growth fact values", failedAttention.specialistId === "ATTENTION" && failedAttention.facts["growth-recovery"] == null);

  console.log("\nCAPS — full totals stay truthful when detail is bounded");
  const overCap = await createOwnerWorkspace("Over Cap Growth");
  await entitleFounder(overCap.business.id);
  const overCampaigns = [];
  for (let i = 0; i < 7; i += 1) {
    overCampaigns.push(
      await prisma.marketingCampaign.create({
        data: {
          businessId: overCap.business.id,
          name: `Over campaign ${i + 1}`,
          sourceKey: "OTHER",
          status: "ACTIVE",
        },
      }),
    );
  }
  const attributedSources = ["WEBSITE", "GOOGLE", "REFERRAL", "MANUAL", "CAMPAIGN", "FACEBOOK"];
  for (const [index, source] of attributedSources.entries()) {
    const customer = await prisma.customer.create({
      data: {
        businessId: overCap.business.id,
        name: `Attributed ${source}`,
        smsConsentStatus: "UNKNOWN",
      },
    });
    for (let n = 0; n < 3; n += 1) {
      await prisma.serviceRequest.create({
        data: {
          businessId: overCap.business.id,
          customerId: customer.id,
          summary: `${source} lead ${n + 1}`,
          leadSource: source,
          originalLeadSource: source,
          campaignId: overCampaigns[index % overCampaigns.length].id,
          originalCampaignId: overCampaigns[index % overCampaigns.length].id,
          createdAt: daysAgo(20),
          updatedAt: daysAgo(20),
        },
      });
    }
  }
  const unknownCustomer = await prisma.customer.create({
    data: {
      businessId: overCap.business.id,
      name: "Unattributed Lead",
      smsConsentStatus: "UNKNOWN",
    },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: overCap.business.id,
      customerId: unknownCustomer.id,
      summary: "Unknown source only",
      leadSource: null,
      originalLeadSource: null,
      createdAt: daysAgo(18),
      updatedAt: daysAgo(18),
    },
  });
  for (let i = 0; i < 12; i += 1) {
    const customer = await prisma.customer.create({
      data: {
        businessId: overCap.business.id,
        name: `Recovery ${i + 1}`,
        smsConsentStatus: "UNKNOWN",
      },
    });
    const campaign = overCampaigns[i % overCampaigns.length];
    await prisma.serviceRequest.create({
      data: {
        businessId: overCap.business.id,
        customerId: customer.id,
        summary: `Over recovery ${i + 1}`,
        leadSource: "WEBSITE",
        originalLeadSource: "WEBSITE",
        campaignId: campaign.id,
        originalCampaignId: campaign.id,
        createdAt: daysAgo(21),
        updatedAt: daysAgo(21),
      },
    });
  }
  for (let i = 0; i < 10; i += 1) {
    const eligible = i >= 8;
    const prior = await prisma.customer.create({
      data: {
        businessId: overCap.business.id,
        name: eligible ? `Eligible Prior ${i + 1}` : `Ineligible Prior ${i + 1}`,
        email: eligible ? `eligible-${i}@example.com` : null,
        smsConsentStatus: eligible ? "GRANTED" : "REVOKED",
        createdAt: daysAgo(200),
      },
    });
    const completedAt = daysAgo(eligible ? REACTIVATION_AFTER_DAYS + 5 : REACTIVATION_AFTER_DAYS + 40 + i);
    const job = await prisma.job.create({
      data: {
        businessId: overCap.business.id,
        customerId: prior.id,
        status: "COMPLETED",
        projectToken: randomUUID(),
        updatedAt: completedAt,
      },
    });
    await prisma.businessEvent.create({
      data: {
        businessId: overCap.business.id,
        type: "JOB_COMPLETED",
        subjectType: "JOB",
        subjectId: job.id,
        occurredAt: completedAt,
        idempotencyKey: `JOB_COMPLETED:${job.id}`,
      },
    });
  }

  resetLastGrowthProjection();
  const overCatalog = await loadCanonicalRecommendationCatalog(prisma, overCap.business.id);
  const overResult = interpretGrowthSpecialist(overCatalog, "Explain recovery, reactivation, campaigns, and attribution.");
  const overProjection = getLastGrowthProjection();
  const recoveryFinding = overResult.findings.find((row) => row.key === "growth-recovery-open");
  const reactivationFinding = overResult.findings.find((row) => row.key === "growth-reactivation-eligible");
  const campaignFinding = overResult.findings.find((row) => row.key === "growth-campaigns-review");
  const attributionFinding = overResult.findings.find((row) => row.key === "growth-attribution-unknown");
  check("Over-cap recovery detail is <= 8", Boolean(overProjection) && overProjection.recovery.length <= 8);
  check(
    "Over-cap recovery fact/finding uses the full total",
    Boolean(overProjection) &&
      overProjection.totals.recovery >= 12 &&
      overProjection.totals.recovery > overProjection.recovery.length &&
      overResult.factKeys.includes("growth-recovery") &&
      new RegExp(`\\b${overProjection.totals.recovery}\\b`).test(recoveryFinding?.summary ?? ""),
  );
  check("Over-cap reactivation detail is <= 8", Boolean(overProjection) && overProjection.reactivation.length <= 8);
  check(
    "Over-cap eligible reactivation total survives outside the first 8 detail rows",
    Boolean(overProjection) &&
      overProjection.totals.reactivationCandidates >= 10 &&
      overProjection.totals.reactivationEligible === 2 &&
      overProjection.reactivation.filter((row) => row.outreachEligible).length === 0 &&
      overResult.factKeys.includes("growth-reactivation") &&
      new RegExp(`\\b${overProjection.totals.reactivationEligible}\\b`).test(reactivationFinding?.summary ?? ""),
  );
  check("Over-cap campaign detail is <= 5", Boolean(overProjection) && overProjection.campaigns.length <= 5);
  check(
    "Over-cap campaign totals stay full recorded truth",
    Boolean(overProjection) &&
      overProjection.totals.campaigns >= 7 &&
      overProjection.totals.campaigns > overProjection.campaigns.length &&
      overProjection.totals.campaignsNeedingReview >= 7 &&
      overResult.factKeys.includes("growth-campaigns") &&
      new RegExp(`\\b${overProjection.totals.campaignsNeedingReview}\\b`).test(campaignFinding?.summary ?? ""),
  );
  check("Over-cap source detail is <= 5", Boolean(overProjection) && overProjection.sources.length <= 5);
  check(
    "UNKNOWN source outside top 5 still appears in unattributed totals",
    Boolean(overProjection) &&
      overProjection.totals.sources >= 7 &&
      !overProjection.sources.some((row) => row.source === "UNKNOWN") &&
      overProjection.totals.unattributedSources >= 1 &&
      overProjection.totals.unattributedLeads >= 1 &&
      overResult.factKeys.includes("growth-unattributed-sources") &&
      /unknown|unattributed/i.test(attributionFinding?.summary ?? ""),
  );
  check(
    "Entity IDs stay bounded from capped rows",
    (recoveryFinding?.entityIds?.length ?? 0) <= GROWTH_CONTEXT_CAPS.entityIds &&
      (reactivationFinding?.entityIds?.length ?? 0) <= GROWTH_CONTEXT_CAPS.entityIds,
  );
  check(
    "No full GrowthSource enters specialist context",
    !JSON.stringify(overProjection).includes("reviewRequests") &&
      !JSON.stringify(overProjection).includes("localPageDrafts") &&
      !JSON.stringify(overProjection).includes("publishedLocalPages") &&
      !JSON.stringify(overResult).includes("\"requests\"") &&
      !growthProjectionHasForbiddenFields(overProjection),
  );

  console.log("\nRUNTIME — orchestration, one-load, failure, writes");
  resetLoads();
  const selected = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads can I recover and how are my campaigns converting?",
    attemptId: randomUUID(),
    browserBusinessId: tenantB.business.id,
  });
  check("1. Coach answer for A omits Beta secret 9999", Boolean(selected.text) && !selected.text.includes("9999"));
  check("21. Disconnected provider still explains recorded Growth facts", /recover|campaign|lead|Growth workspace|opportunit/i.test(selected.text ?? ""));
  check("21. Disconnected answer does not invent ROI or contact", !/\bcontacted\b|\brecovered\b|\blaunched\b/i.test(selected.text ?? ""));
  check("6. Exactly one Growth source load when selected", getGrowthSourceLoadCount() === 1);
  check("6. Growth specialist interprets once and does not reload", getGrowthSpecialistInterpretationCount() === 1);
  check("21. Orchestration can complete while the provider is disconnected", selected.orchestrationStatus === "COMPLETED");
  const liveProjection = getLastGrowthProjection();
  check("11-14. Live projection stays bounded", Boolean(liveProjection) && liveProjection.recovery.length <= 8 && liveProjection.reactivation.length <= 8 && liveProjection.campaigns.length <= 5 && liveProjection.sources.length <= 5);
  check("15. Live projection excludes message bodies and consent secrets", !growthProjectionHasForbiddenFields(liveProjection));

  const financialOnly = await createOwnerWorkspace("Financial Only Growth");
  await entitleFounder(financialOnly.business.id);
  resetLoads();
  const unselected = await runChiefOfStaffCoach(prisma, financialOnly.access, {
    question: "How is my profit and outstanding invoices this month?",
    attemptId: randomUUID(),
  });
  check("7. Unrelated Financial question orchestration does not interpret Growth", getGrowthSpecialistInterpretationCount() === 0);
  check("7. Financial question still completes", unselected.orchestrationStatus === "COMPLETED");
  check("6. Unselected Growth still used the catalog's one source load", getGrowthSourceLoadCount() === 1);

  const emptyFocus = await createOwnerWorkspace("Focus Only Growth");
  await entitleFounder(emptyFocus.business.id);
  resetLoads();
  const focusOnly = await runChiefOfStaffCoach(prisma, emptyFocus.access, {
    question: "What should I focus on this week?",
    attemptId: randomUUID(),
  });
  const focusOrch = await prisma.aiOrchestrationRun.findUnique({ where: { id: focusOnly.orchestrationId } });
  check("10. Generic focus does not fan out to Growth without Growth evidence", !(focusOrch?.specialistIds ?? []).includes("GROWTH"));
  check("10. Generic focus does not interpret Growth", getGrowthSpecialistInterpretationCount() === 0);

  resetLoads();
  const recAsk = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What should I focus on this week?",
    attemptId: randomUUID(),
  });
  const recOrch = await prisma.aiOrchestrationRun.findUnique({ where: { id: recAsk.orchestrationId } });
  const hasGrowthRec = catalogA.activeRecommendations.some((row) => GROWTH_OWNED_RECOMMENDATION_KEYS.includes(row.key));
  check("9. Tenant A has an active canonical Growth recommendation", hasGrowthRec);
  check(
    "9. Active canonical Growth recommendation selects Growth on focus",
    (recOrch?.specialistIds ?? []).includes("GROWTH"),
  );

  resetLoads();
  const starterAsk = await runChiefOfStaffCoach(prisma, starter.access, {
    question: "Which lost leads can I recover?",
    attemptId: randomUUID(),
  });
  check("3/4. Starter Growth skip does not invent opportunities", /Marketing Tools|Reporting/i.test(starterAsk.text ?? ""));
  check("3/4. Starter skip still loads catalog Growth once for BSOS counts only", getGrowthSourceLoadCount() === 1);
  check("3/4. Selected-but-skipped Growth still interprets once", getGrowthSpecialistInterpretationCount() === 1);
  check("3/4. Starter skip has no deep Growth projection", getLastGrowthProjection() == null);
  check("Starter skip is not FAILED", starterAsk.orchestrationStatus === "COMPLETED");

  resetLoads();
  const denyMarketingAsk = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads can I recover?",
    attemptId: randomUUID(),
    test: { denyProductCapabilities: [PRODUCT_CAPABILITIES.MARKETING_TOOLS] },
  });
  check("3. Runtime missing MARKETING_TOOLS → SKIPPED, not FAILED", denyMarketingAsk.orchestrationStatus === "COMPLETED" && /Marketing Tools/i.test(denyMarketingAsk.text ?? ""));
  check("3. Denied MARKETING_TOOLS has no deep projection", getLastGrowthProjection() == null);

  resetLoads();
  const denyReportingAsk = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads can I recover?",
    attemptId: randomUUID(),
    test: { denyProductCapabilities: [PRODUCT_CAPABILITIES.REPORTING_INSIGHTS] },
  });
  check("4. Runtime missing REPORTING_INSIGHTS → SKIPPED, not FAILED", denyReportingAsk.orchestrationStatus === "COMPLETED" && /Reporting/i.test(denyReportingAsk.text ?? ""));

  const otherSurvives = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads should I recover and what unpaid invoices need attention?",
    attemptId: randomUUID(),
    test: { denyProductCapabilities: [PRODUCT_CAPABILITIES.MARKETING_TOOLS] },
  });
  check("ATTENTION / Financial can still complete when Growth is skipped", otherSurvives.orchestrationStatus === "COMPLETED");

  const partial = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads can I recover?",
    attemptId: randomUUID(),
    test: { failGrowthLoad: true },
  });
  check("20. Growth loader failure is PARTIAL", partial.orchestrationStatus === "PARTIAL");
  check("20. ATTENTION survives loader failure", /surviving facts|could not be loaded|unavailable/i.test(partial.text ?? ""));
  check("20. Failure does not invent an empty pipeline", !/zero recover|0 recovery opportunities|empty pipeline/i.test(partial.text ?? ""));

  const failSpecialist = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads can I recover?",
    attemptId: randomUUID(),
    test: { failSpecialistId: "GROWTH" },
  });
  check("20. Injected Growth specialist failure is PARTIAL", failSpecialist.orchestrationStatus === "PARTIAL");

  const before = {
    actions: await prisma.growthActionRequest.count({ where: { businessId: tenantA.business.id } }),
    campaigns: await prisma.marketingCampaign.count({ where: { businessId: tenantA.business.id } }),
    comms: await prisma.customerCommunication.count({ where: { businessId: tenantA.business.id } }),
    reviews: await prisma.reviewRequest.count({ where: { businessId: tenantA.business.id } }),
    referrals: await prisma.referralRequest.count({ where: { businessId: tenantA.business.id } }),
    customers: await prisma.customer.count({ where: { businessId: tenantA.business.id } }),
    consent: await prisma.customer.count({
      where: { businessId: tenantA.business.id, smsConsentStatus: "GRANTED" },
    }),
    recs: await prisma.bsosRecommendationState.count({ where: { businessId: tenantA.business.id } }),
  };
  await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Recover those leads, reactivate customers, launch campaigns, and request reviews.",
    attemptId: randomUUID(),
  });
  const after = {
    actions: await prisma.growthActionRequest.count({ where: { businessId: tenantA.business.id } }),
    campaigns: await prisma.marketingCampaign.count({ where: { businessId: tenantA.business.id } }),
    comms: await prisma.customerCommunication.count({ where: { businessId: tenantA.business.id } }),
    reviews: await prisma.reviewRequest.count({ where: { businessId: tenantA.business.id } }),
    referrals: await prisma.referralRequest.count({ where: { businessId: tenantA.business.id } }),
    customers: await prisma.customer.count({ where: { businessId: tenantA.business.id } }),
    consent: await prisma.customer.count({
      where: { businessId: tenantA.business.id, smsConsentStatus: "GRANTED" },
    }),
    recs: await prisma.bsosRecommendationState.count({ where: { businessId: tenantA.business.id } }),
  };
  check("19. No GrowthActionRequest writes", before.actions === after.actions);
  check("19. No campaign writes", before.campaigns === after.campaigns);
  check("19. No communications sent", before.comms === after.comms);
  check("19. No review request writes", before.reviews === after.reviews);
  check("19. No referral request writes", before.referrals === after.referrals);
  check("19. No customer or consent writes", before.customers === after.customers && before.consent === after.consent);
  check("19. No recommendation-state writes", before.recs === after.recs);

  const kitchen = planSpecialists({
    question: "What should I focus on this week for invoices, staff, materials, vault, growth, and knowledge?",
    activeRecommendationKeys: ["collect-unpaid-invoices", "workforce-unassigned-job"],
  });
  check("24. Kitchen-sink focus never exceeds fan-out 4", kitchen.selectedIds.length <= 4 && kitchen.fanout <= 4);
  check("10. Kitchen-sink focus does not auto-load Growth without a Growth rec", !kitchen.selectedIds.includes("GROWTH"));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nGrowth specialist checks failed: ${failures}`);
  process.exit(1);
}
console.log("\nGrowth specialist checks passed.");
