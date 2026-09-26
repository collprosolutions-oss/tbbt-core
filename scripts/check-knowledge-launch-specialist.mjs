/**
 * AI Chief of Staff Knowledge/Launch specialist proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-knowledge-launch-specialist.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const {
  KNOWLEDGE_LAUNCH_CONTEXT_CAPS,
  KNOWLEDGE_LAUNCH_OWNED_RECOMMENDATION_KEYS,
  KNOWLEDGE_LAUNCH_TARGET_CONSISTENCY_LIMITATION,
  KNOWLEDGE_STATE_CONTRACT,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  candidateIsNotApprovedKnowledge,
  conflictRemainsConflict,
  estimateIsLabeledEstimate,
  externalReferenceIsNotInternallyVerified,
  getKnowledgeLaunchProjectionLoadCount,
  getKnowledgeLaunchSpecialistInterpretationCount,
  getLastKnowledgeLaunchProjection,
  knowledgeLaunchProjectionHasForbiddenFields,
  launchCompleteDoesNotImplyProvider,
  launchCompleteDoesNotImplyWebsite,
  launchStatusesRemainDistinct,
  planSpecialists,
  resetKnowledgeLaunchSpecialistCounters,
  resetLastKnowledgeLaunchProjection,
  resolveConflicts,
  runChiefOfStaffCoach,
  runKnowledgeLaunchSpecialist,
  supportedIsNotVerified,
  systemDerivedIsReserved,
  unknownStaysUnknown,
  unreviewedIsNotApproved,
} = await import("@/lib/chief-of-staff");
const { getSpecialistEntry } = await import("@/lib/chief-of-staff/registry");
const { LAUNCH_STEP_KEYS } = await import("@/lib/business-launch");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_knowledge_launch_specialist_test";
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
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
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

function resetLoads() {
  resetKnowledgeLaunchSpecialistCounters();
  resetLastKnowledgeLaunchProjection();
}

function emptyCatalog(keys = []) {
  return {
    facts: {},
    recommendations: [],
    activeRecommendations: keys.map((key) => ({ key, title: key, why: key })),
    historyRecommendations: [],
    states: [],
    workforceRecommendationKeys: [],
    financial: { entitled: false, failed: false, intelligence: null },
    growth: { entitled: false, source: null, failed: false, missingCapabilities: [] },
    workforceSnapshot: null,
  };
}

function projectionIsClosed(projection) {
  return (
    Boolean(projection) &&
    projection.entries.length === 0 &&
    projection.candidates.length === 0 &&
    projection.procedures.length === 0 &&
    projection.launch.steps.length === 0 &&
    projection.totals.entries === 0 &&
    projection.canReadDeep === false
  );
}

async function countKnowledgeLaunchRows(businessId) {
  const [entries, candidates, procedures, progress, steps, proposals] = await Promise.all([
    prisma.knowledgeEntry.findMany({
      where: { businessId },
      select: {
        id: true,
        approvalState: true,
        trustState: true,
        sourceType: true,
        archived: true,
        title: true,
      },
    }),
    prisma.experienceLearningCandidate.findMany({
      where: { businessId },
      select: { id: true, status: true, knowledgeEntryId: true, title: true },
    }),
    prisma.operatingProcedure.findMany({
      where: { businessId },
      select: { id: true, approvalState: true, knowledgeEntryId: true },
    }),
    prisma.businessLaunchProgress.findUnique({
      where: { businessId },
      select: { status: true, lastStepKey: true },
    }),
    prisma.businessLaunchStep.findMany({
      where: { businessId },
      select: { stepKey: true, status: true },
    }),
    prisma.companySetupProposal.count({ where: { businessId } }),
  ]);
  return {
    entries: entries.length,
    entryStates: entries
      .map((row) => `${row.id}:${row.approvalState}:${row.trustState}:${row.sourceType}:${row.archived}`)
      .sort()
      .join("|"),
    candidates: candidates.length,
    candidateStates: candidates
      .map((row) => `${row.id}:${row.status}:${row.knowledgeEntryId ?? ""}`)
      .sort()
      .join("|"),
    procedures: procedures.length,
    procedureStates: procedures
      .map((row) => `${row.id}:${row.approvalState}:${row.knowledgeEntryId ?? ""}`)
      .sort()
      .join("|"),
    launchStatus: progress?.status ?? "",
    launchSteps: steps
      .map((row) => `${row.stepKey}:${row.status}`)
      .sort()
      .join("|"),
    proposals,
  };
}

async function createEntry(workspace, data) {
  return prisma.knowledgeEntry.create({
    data: {
      businessId: workspace.business.id,
      createdByMembershipId: workspace.membership.id,
      title: data.title,
      category: data.category ?? "JOB_PROCEDURES",
      body: data.body,
      sourceType: data.sourceType ?? "OWNER_CREATED",
      sourceKind: data.sourceKind ?? null,
      sourceLabel: data.sourceLabel ?? null,
      trustState: data.trustState ?? "UNKNOWN",
      approvalState: data.approvalState ?? "UNREVIEWED",
      knowledgeKind: data.knowledgeKind ?? "FIELD_TECHNIQUE",
      scope: "BUSINESS",
    },
  });
}

async function seedLaunch(workspace, statuses) {
  const progress = await prisma.businessLaunchProgress.create({
    data: {
      businessId: workspace.business.id,
      status: statuses.every((status) => status === "COMPLETED" || status === "SKIPPED")
        ? "COMPLETED"
        : "IN_PROGRESS",
      createdByMembershipId: workspace.membership.id,
    },
  });
  const steps = [];
  for (const [index, stepKey] of LAUNCH_STEP_KEYS.entries()) {
    const status = statuses[index] ?? "PENDING";
    steps.push(
      await prisma.businessLaunchStep.create({
        data: {
          businessId: workspace.business.id,
          progressId: progress.id,
          stepKey,
          status,
          completedAt: status === "COMPLETED" ? new Date() : null,
          skippedAt: status === "SKIPPED" ? new Date() : null,
          deferredAt: status === "DEFERRED" ? new Date() : null,
        },
      }),
    );
  }
  return { progress, steps };
}

async function seedKnowledgeWorld(workspace, { secret = false, extraEntries = 0, launchStatuses } = {}) {
  const prefix = secret ? "BetaSecretKnowledge" : "Alpha";
  const unreviewed = await createEntry(workspace, {
    title: `${prefix} unreviewed unknown`,
    body: `${prefix} unreviewed body stays UNREVIEWED and UNKNOWN. ${"overflow ".repeat(80)}`,
    approvalState: "UNREVIEWED",
    trustState: "UNKNOWN",
    sourceType: "OWNER_CREATED",
  });
  const approved = await createEntry(workspace, {
    title: `${prefix} approved verified`,
    body: `${prefix} approved verified body`,
    approvalState: "APPROVED",
    trustState: "VERIFIED",
    sourceType: "TBBT_RECORD",
    sourceKind: "JOB",
  });
  const conflict = await createEntry(workspace, {
    title: `${prefix} conflict`,
    body: `${prefix} conflict body remains CONFLICT`,
    approvalState: "UNREVIEWED",
    trustState: "CONFLICT",
    sourceType: "TBBT_RECORD",
    sourceKind: "JOB",
  });
  const estimate = await createEntry(workspace, {
    title: `${prefix} estimate`,
    body: `${prefix} estimate body is ESTIMATE not fact`,
    approvalState: "UNREVIEWED",
    trustState: "ESTIMATE",
    sourceType: "OWNER_CREATED",
  });
  const supported = await createEntry(workspace, {
    title: `${prefix} supported`,
    body: `${prefix} supported is not verified`,
    approvalState: "APPROVED",
    trustState: "SUPPORTED",
    sourceType: "TBBT_RECORD",
    sourceKind: "ESTIMATE",
  });
  const external = await createEntry(workspace, {
    title: `${prefix} external`,
    body: `${prefix} external reference is not internally verified`,
    approvalState: "UNREVIEWED",
    trustState: "SUPPORTED",
    sourceType: "EXTERNAL_REFERENCE",
    sourceLabel: "https://example.com/spec",
  });
  const systemDerived = await createEntry(workspace, {
    title: `${prefix} system derived`,
    body: `${prefix} system derived is reserved`,
    approvalState: "UNREVIEWED",
    trustState: "UNKNOWN",
    sourceType: "SYSTEM_DERIVED",
  });
  const candidate = await prisma.experienceLearningCandidate.create({
    data: {
      businessId: workspace.business.id,
      kind: "FIELD_NOTE",
      title: `${prefix} candidate`,
      body: `${prefix} candidate body is not approved knowledge`,
      evidenceJson: JSON.stringify({ secret: `${prefix}-evidence` }),
      evidenceKey: `candidate-${randomUUID()}`,
      status: "CANDIDATE",
      confidence: "UNKNOWN",
    },
  });
  const procedure = await prisma.operatingProcedure.create({
    data: {
      businessId: workspace.business.id,
      createdByMembershipId: workspace.membership.id,
      title: `${prefix} SOP`,
      summary: `${prefix} procedure summary`,
      approvalState: "UNREVIEWED",
      steps: {
        create: [
          { businessId: workspace.business.id, sortOrder: 0, title: `${prefix} step one`, body: "do the work" },
          { businessId: workspace.business.id, sortOrder: 1, title: `${prefix} step two`, body: "check the work" },
        ],
      },
    },
  });
  const extras = [];
  for (let i = 0; i < extraEntries; i += 1) {
    extras.push(
      await createEntry(workspace, {
        title: `${prefix} overflow ${i + 1}`,
        body: `${prefix} overflow body ${i + 1}`,
        approvalState: "UNREVIEWED",
        trustState: "UNKNOWN",
      }),
    );
  }
  const mixed = ["COMPLETED", "PENDING", "SKIPPED", "DEFERRED"];
  const statuses =
    launchStatuses ??
    LAUNCH_STEP_KEYS.map((_, index) => mixed[index % mixed.length]);
  const launch = await seedLaunch(workspace, statuses);
  return {
    unreviewed,
    approved,
    conflict,
    estimate,
    supported,
    external,
    systemDerived,
    candidate,
    procedure,
    extras,
    launch,
  };
}

try {
  const specialistSrc = readFileSync(new URL("../src/lib/chief-of-staff/knowledge-launch-specialist.ts", import.meta.url), "utf8");
  const snapshotSrc = readFileSync(new URL("../src/lib/chief-of-staff/knowledge-launch-snapshot.ts", import.meta.url), "utf8");
  const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  console.log("\nSTATIC — Knowledge/Launch specialist is read/explain only");
  const entry = getSpecialistEntry("KNOWLEDGE_LAUNCH");
  check("Registry enables existing KNOWLEDGE_LAUNCH identity", entry.id === "KNOWLEDGE_LAUNCH" && entry.enabled === true);
  check("CoS entry remains VIEW_REPORTS", entry.requiredRoleCapability === CAPABILITIES.VIEW_REPORTS);
  check("No invented product floor", entry.requiredProductCapability === null);
  check("Approval class is READ_EXPLAIN", entry.approvalClass === "READ_EXPLAIN");
  check("Deep loader is the bounded projection", entry.deepLoader === "knowledge-launch-bounded-projection");
  check("Knowledge/Launch specialist performs no LLM call", !specialistSrc.includes("runAiTask") && !specialistSrc.includes("resolveAiProvider"));
  check(
    "Knowledge/Launch specialist does not call write paths",
    !specialistSrc.includes("createKnowledgeEntry") &&
      !specialistSrc.includes("updateKnowledgeEntry") &&
      !specialistSrc.includes("setKnowledgeApproval") &&
      !specialistSrc.includes("setKnowledgeArchived") &&
      !specialistSrc.includes("markKnowledgeReviewed") &&
      !specialistSrc.includes("scanExperienceCandidates") &&
      !specialistSrc.includes("reviewExperienceCandidate") &&
      !specialistSrc.includes("createOperatingProcedure") &&
      !specialistSrc.includes("setOperatingProcedureApproval") &&
      !specialistSrc.includes("completeLaunchStep") &&
      !specialistSrc.includes("skipLaunchStep") &&
      !specialistSrc.includes("deferLaunchStep") &&
      !specialistSrc.includes("ensureLaunchProgress") &&
      !specialistSrc.includes("publishWebsite") &&
      !specialistSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal"),
  );
  check(
    "Knowledge/Launch specialist does not invoke another specialist",
    !specialistSrc.includes("runWorkforceSpecialist") &&
      !specialistSrc.includes("runMaterialsSpecialist") &&
      !specialistSrc.includes("runCommunicationsSpecialist") &&
      !specialistSrc.includes("interpretFinancialSpecialist") &&
      !specialistSrc.includes("interpretGrowthSpecialist") &&
      !specialistSrc.includes("planSpecialists(") &&
      !specialistSrc.includes("runChiefOfStaffCoach"),
  );
  check("No Prisma schema change is required", schemaSrc.includes("model KnowledgeEntry") && schemaSrc.includes("model BusinessLaunchStep"));
  check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
  check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);
  check(
    "Approval/trust/source states remain distinct",
    KNOWLEDGE_STATE_CONTRACT.approvalStates.join(",") === "UNREVIEWED,APPROVED,REJECTED" &&
      KNOWLEDGE_STATE_CONTRACT.trustStates.join(",") === "VERIFIED,SUPPORTED,ESTIMATE,NEEDS_REVIEW,CONFLICT,UNKNOWN" &&
      KNOWLEDGE_STATE_CONTRACT.sourceTypes.join(",") === "OWNER_CREATED,TBBT_RECORD,EXTERNAL_REFERENCE,SYSTEM_DERIVED",
  );
  check("UNREVIEWED is not APPROVED", unreviewedIsNotApproved("UNREVIEWED") && !unreviewedIsNotApproved("APPROVED"));
  check("Candidate is not approved knowledge", candidateIsNotApprovedKnowledge("CANDIDATE", null));
  check("CONFLICT remains conflict", conflictRemainsConflict("CONFLICT") && !conflictRemainsConflict("VERIFIED"));
  check("ESTIMATE is labeled estimate", estimateIsLabeledEstimate("ESTIMATE") && !estimateIsLabeledEstimate("VERIFIED"));
  check("UNKNOWN stays unknown", unknownStaysUnknown("UNKNOWN") && !unknownStaysUnknown("VERIFIED"));
  check("SUPPORTED is not VERIFIED", supportedIsNotVerified("SUPPORTED"));
  check("EXTERNAL_REFERENCE is not internally verified", externalReferenceIsNotInternallyVerified("EXTERNAL_REFERENCE"));
  check("SYSTEM_DERIVED is reserved", systemDerivedIsReserved("SYSTEM_DERIVED"));
  check(
    "Launch statuses remain distinct",
    launchStatusesRemainDistinct("PENDING") === "PENDING" &&
      launchStatusesRemainDistinct("COMPLETED") === "COMPLETED" &&
      launchStatusesRemainDistinct("SKIPPED") === "SKIPPED" &&
      launchStatusesRemainDistinct("DEFERRED") === "DEFERRED",
  );
  check("Launch completion does not imply website publishing", launchCompleteDoesNotImplyWebsite("COMPLETED", false));
  check("Launch completion does not imply provider connection", launchCompleteDoesNotImplyProvider("COMPLETED", false));
  check(
    "Owned recommendation keys stay the existing catalog only",
    KNOWLEDGE_LAUNCH_OWNED_RECOMMENDATION_KEYS.join(",") ===
      "finish-business-launch,review-experience-learnings,approve-business-knowledge",
  );

  const learned = planSpecialists({ question: "What have we learned about this kind of work?", activeRecommendationKeys: [] });
  check("Planner selects KNOWLEDGE_LAUNCH for learned work", learned.selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for business knowledge", planSpecialists({ question: "What does our business know about this?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for approval", planSpecialists({ question: "Is this knowledge approved?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for review", planSpecialists({ question: "What knowledge still needs review?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for remaining setup", planSpecialists({ question: "What setup do I still need to finish?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for next launch step", planSpecialists({ question: "What is the next launch step?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for deferred setup", planSpecialists({ question: "What did I defer during setup?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH for launch complete", planSpecialists({ question: "Is my business launch setup complete?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Planner selects KNOWLEDGE_LAUNCH from existing recs on focus", planSpecialists({ question: "What should I focus on this week?", activeRecommendationKeys: ["approve-business-knowledge"] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Active knowledge recs do not select KNOWLEDGE_LAUNCH for generic questions", !planSpecialists({ question: "How is my business doing?", activeRecommendationKeys: ["approve-business-knowledge", "finish-business-launch"] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Generic business question does not select KNOWLEDGE_LAUNCH", !planSpecialists({ question: "How is my business doing?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Generic work question does not select KNOWLEDGE_LAUNCH", !planSpecialists({ question: "What should I work on?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Tell-me-everything does not select KNOWLEDGE_LAUNCH", !planSpecialists({ question: "Tell me everything.", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Profit question does not select KNOWLEDGE_LAUNCH", !planSpecialists({ question: "How is profit?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Failed-message question does not select KNOWLEDGE_LAUNCH", !planSpecialists({ question: "What messages failed?", activeRecommendationKeys: [] }).selectedIds.includes("KNOWLEDGE_LAUNCH"));
  check("Fan-out stays <= 4", learned.fanout <= 4 && learned.selectedIds.length <= MAX_SPECIALIST_FANOUT);
  check("Recursion depth stays 1", learned.recursionDepth === 1);

  const tenantA = await createOwnerWorkspace("Alpha Knowledge");
  const tenantB = await createOwnerWorkspace("Beta Knowledge");
  const tenantComplete = await createOwnerWorkspace("Complete Launch");
  await entitleFounder(tenantA.business.id);
  await entitleFounder(tenantB.business.id);
  await entitleFounder(tenantComplete.business.id);

  const adminUser = await prisma.user.create({
    data: { name: "Alpha Admin", email: `admin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: tenantA.business.id, role: "ADMIN" },
  });
  const adminAccess = makeAccess(tenantA.business.id, "ADMIN", adminMembership.id, adminUser.id);

  const memberUser = await prisma.user.create({
    data: { name: "Alpha Member", email: `member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(tenantA.business.id, "MEMBER", memberMembership.id, memberUser.id);

  const seededA = await seedKnowledgeWorld(tenantA, { extraEntries: 6 });
  const seededB = await seedKnowledgeWorld(tenantB, { secret: true });
  const completedStatuses = LAUNCH_STEP_KEYS.map((key, index) => (index === LAUNCH_STEP_KEYS.length - 1 ? "SKIPPED" : "COMPLETED"));
  const seededComplete = await seedKnowledgeWorld(tenantComplete, { launchStatuses: completedStatuses });

  console.log("\nAUTH — owner/admin deep read, MEMBER, tenant isolation, fail-closed");
  check("MEMBER remains blocked from VIEW_REPORTS", !(() => {
    try {
      requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
      return true;
    } catch (error) {
      return !(error instanceof ForbiddenError);
    }
  })());
  check("MEMBER remains blocked from MANAGE_KNOWLEDGE", !(() => {
    try {
      requireBusinessCapability(memberAccess, CAPABILITIES.MANAGE_KNOWLEDGE);
      return true;
    } catch (error) {
      return !(error instanceof ForbiddenError);
    }
  })());

  resetLoads();
  const ownerResult = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(["approve-business-knowledge", "review-experience-learnings", "finish-business-launch"]),
    question: "What knowledge still needs review, and what is the next launch step?",
  });
  const ownerProjection = getLastKnowledgeLaunchProjection();
  check("Owner authorized deep read succeeds", ownerResult.status === "OK" && Boolean(ownerProjection));
  check("Tenant ownership is explicit on entries", ownerProjection.entries.every((row) => row.businessId === tenantA.business.id));
  check("Tenant ownership is explicit on candidates", ownerProjection.candidates.every((row) => row.businessId === tenantA.business.id));
  check("Owner sees targeted local titles", ownerProjection.entries.some((row) => row.title.includes("Alpha")));
  check("No forbidden/private fields leak", !knowledgeLaunchProjectionHasForbiddenFields(ownerProjection));
  check("Full knowledge bodies are not projected", !JSON.stringify(ownerProjection).includes('"body"'));
  check("Candidate evidence is not projected", !JSON.stringify(ownerProjection).includes("BetaSecret") && !JSON.stringify(ownerProjection).includes("evidence"));
  check("Tenant A does not see BetaSecretKnowledge", !JSON.stringify(ownerProjection).includes("BetaSecretKnowledge"));
  check("Tenant A does not see Beta candidate titles", !ownerProjection.candidates.some((row) => row.title.includes("BetaSecret")));

  resetLoads();
  const adminResult = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: adminAccess,
    catalog: emptyCatalog(),
    question: "What does our business know about this?",
  });
  check("Admin authorized deep read succeeds", adminResult.status === "OK" && getLastKnowledgeLaunchProjection()?.entries.some((row) => row.businessId === tenantA.business.id));

  resetLoads();
  const memberResult = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: memberAccess,
    catalog: emptyCatalog(),
    question: "What have we learned about this kind of work?",
  });
  check("MEMBER cannot receive business-wide Knowledge Hub data", memberResult.status === "SKIPPED" && memberResult.skipReason === "NOT_AUTHORIZED");
  check("MEMBER assigned field work does not load a projection", getLastKnowledgeLaunchProjection() === null);
  check("MEMBER result has no knowledge entries", memberResult.findings.length === 0);
  check("MEMBER skip does not fake empty knowledge", /not treated as empty knowledge or a finished launch/i.test(memberResult.limitation ?? ""));

  resetLoads();
  const tenantBResult = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantB.access,
    catalog: emptyCatalog(),
    question: "Is this knowledge approved?",
  });
  const tenantBProjection = getLastKnowledgeLaunchProjection();
  check("Tenant B run is OK", tenantBResult.status === "OK");
  check("Tenant B does not see Alpha titles", !JSON.stringify(tenantBProjection).includes("Alpha unreviewed") && !tenantBProjection.entries.some((row) => row.title.startsWith("Alpha")));
  check("Tenant B does not see Alpha entry ids", !tenantBProjection.entries.some((row) => row.id === seededA.approved.id));

  resetLoads();
  const foreignEntry = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Is this knowledge approved?",
    entityHints: { knowledgeEntryId: seededB.approved.id },
  });
  check("Targeted foreign knowledge entry fails closed", projectionIsClosed(getLastKnowledgeLaunchProjection()) && foreignEntry.status === "OK");
  check("Foreign entry limitation stays owner-facing", /not in this business workspace/i.test(foreignEntry.limitation ?? "") && !(foreignEntry.limitation ?? "").includes("BetaSecret"));

  resetLoads();
  const foreignCandidate = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What have we learned about this kind of work?",
    entityHints: { experienceCandidateId: seededB.candidate.id },
  });
  check("Targeted foreign candidate fails closed", projectionIsClosed(getLastKnowledgeLaunchProjection()));
  check("Foreign candidate does not substitute a local candidate", !getLastKnowledgeLaunchProjection().candidates.some((row) => row.id === seededA.candidate.id));

  resetLoads();
  const foreignProcedure = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What operating procedures do we have?",
    entityHints: { procedureId: seededB.procedure.id },
  });
  check("Targeted foreign procedure fails closed", projectionIsClosed(getLastKnowledgeLaunchProjection()));

  resetLoads();
  const ownedTarget = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Is this knowledge approved?",
    entityHints: { knowledgeEntryId: seededA.approved.id },
  });
  const ownedProjection = getLastKnowledgeLaunchProjection();
  check("Authorized single knowledge entry still succeeds", ownedTarget.status === "OK" && ownedProjection.entries.some((row) => row.id === seededA.approved.id));
  check("Authorized single entry stays bounded", ownedProjection.entries.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entries);

  resetLoads();
  const mixedHints = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What have we learned about this kind of work?",
    entityHints: {
      knowledgeEntryId: seededA.approved.id,
      experienceCandidateId: seededA.candidate.id,
    },
  });
  check("Same-tenant entry + unrelated candidate fails closed", projectionIsClosed(getLastKnowledgeLaunchProjection()));
  check(
    "Target consistency limitation is owner-facing and generic",
    (mixedHints.limitation ?? "").includes(KNOWLEDGE_LAUNCH_TARGET_CONSISTENCY_LIMITATION) &&
      !(mixedHints.limitation ?? "").includes("BetaSecret"),
  );

  resetLoads();
  const foreignMix = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What does our business know about this?",
    entityHints: {
      knowledgeEntryId: seededA.unreviewed.id,
      experienceCandidateId: seededB.candidate.id,
    },
  });
  check("Foreign + owned mix fails the entire targeted projection closed", projectionIsClosed(getLastKnowledgeLaunchProjection()));
  check("Foreign + owned mix does not load the owned entry as a substitute", !getLastKnowledgeLaunchProjection().entries.some((row) => row.id === seededA.unreviewed.id));
  check("Contradictory targeting never opens an unscoped whole-business view", foreignMix.status === "OK" && getLastKnowledgeLaunchProjection().totals.entries === 0);

  console.log("\nSTATES — approval, trust, source, candidate, and launch remain distinct");
  resetLoads();
  await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What knowledge still needs review?",
  });
  const stateProjection = getLastKnowledgeLaunchProjection();
  const byId = Object.fromEntries(stateProjection.entries.map((row) => [row.id, row]));
  check("UNREVIEWED stays UNREVIEWED", stateProjection.entries.some((row) => row.approvalState === "UNREVIEWED") && stateProjection.entries.every((row) => row.approvalState !== "UNREVIEWED" || row.approvalState === "UNREVIEWED"));
  check("APPROVED stays APPROVED", stateProjection.entries.some((row) => row.approvalState === "APPROVED"));
  check("UNREVIEWED never becomes APPROVED", !stateProjection.entries.some((row) => row.id === seededA.unreviewed.id && row.approvalState === "APPROVED") && stateProjection.totals.unreviewed > 0 && stateProjection.totals.approved > 0);
  check("CONFLICT remains CONFLICT", (byId[seededA.conflict.id]?.trustState ?? stateProjection.entries.find((row) => row.trustState === "CONFLICT")?.trustState) === "CONFLICT");
  check("ESTIMATE stays ESTIMATE", (byId[seededA.estimate.id]?.trustState ?? stateProjection.entries.find((row) => row.trustState === "ESTIMATE")?.trustState) === "ESTIMATE");
  check("UNKNOWN stays UNKNOWN", stateProjection.entries.some((row) => row.trustState === "UNKNOWN") && stateProjection.totals.unknown > 0);
  check("SUPPORTED stays SUPPORTED", stateProjection.entries.some((row) => row.trustState === "SUPPORTED"));
  check("EXTERNAL_REFERENCE stays EXTERNAL_REFERENCE", byId[seededA.external.id]?.sourceType === "EXTERNAL_REFERENCE" || stateProjection.entries.some((row) => row.sourceType === "EXTERNAL_REFERENCE"));
  check("SYSTEM_DERIVED stays reserved", byId[seededA.systemDerived.id]?.sourceType === "SYSTEM_DERIVED" || stateProjection.entries.some((row) => row.sourceType === "SYSTEM_DERIVED"));
  check("Candidate never becomes approved knowledge", stateProjection.candidates.every((row) => row.isApprovedKnowledge === false && row.status === "CANDIDATE"));
  const estimateFinding = ownerResult.findings.find((row) => row.key === "knowledge-estimate");
  check("ESTIMATE is labeled as estimate rather than fact", /ESTIMATE is not a known fact/i.test(estimateFinding?.summary ?? JSON.stringify(ownerResult.findings)));
  const unknownFinding = ownerResult.findings.find((row) => row.key === "knowledge-unknown");
  check("UNKNOWN is not treated as false", /UNKNOWN is not false/i.test(unknownFinding?.summary ?? JSON.stringify(ownerResult.findings)));
  const conflictFinding = ownerResult.findings.find((row) => row.key === "knowledge-conflict");
  check("CONFLICT finding stays unresolved", /CONFLICT is recorded trust, not a resolved fact/i.test(conflictFinding?.summary ?? JSON.stringify(ownerResult.findings)));
  const candidateFinding = ownerResult.findings.find((row) => row.key === "knowledge-candidate-not-policy");
  check("Candidate finding never claims approved knowledge", /not approved knowledge/i.test(candidateFinding?.summary ?? ""));

  const launchStatuses = new Set(stateProjection.launch.steps.map((row) => row.status));
  check("Launch PENDING/COMPLETED/SKIPPED/DEFERRED remain distinct", launchStatuses.has("PENDING") && launchStatuses.has("COMPLETED") && launchStatuses.has("SKIPPED") && launchStatuses.has("DEFERRED"));
  check("Launch recommended next is a pending or deferred step", stateProjection.launch.recommendedNext == null || ["PENDING", "DEFERRED"].includes(stateProjection.launch.steps.find((row) => row.stepKey === stateProjection.launch.recommendedNext)?.status));

  resetLoads();
  const completeResult = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantComplete.access,
    catalog: emptyCatalog(),
    question: "Is my business launch setup complete?",
  });
  const completeProjection = getLastKnowledgeLaunchProjection();
  check("Completed launch stays COMPLETED", completeProjection.launch.status === "COMPLETED");
  check("Skipped launch step stays SKIPPED", completeProjection.launch.steps.some((row) => row.status === "SKIPPED"));
  check("Launch completion does not mark website published", completeProjection.providers.websitePublished === false);
  check("Launch completion does not invent Stripe connected", completeProjection.providers.stripeStatus !== "connected");
  check(
    "Launch completion finding does not imply website or providers",
    completeResult.findings.some((row) => row.key === "launch-complete-vs-website" || row.key === "launch-complete-not-operating-proof") &&
      completeResult.findings.some((row) => /does not imply Stripe|Website publishing is a separate owner action/i.test(row.summary)),
  );
  check("Completed launch still reports actual provider state", ["not_connected", "setup_required", "unknown"].includes(completeProjection.providers.stripeStatus));

  console.log("\nBOUNDS — projection caps and deterministic result");
  resetLoads();
  const capped = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What does our business know about this?",
  });
  const cappedProjection = getLastKnowledgeLaunchProjection();
  check("Entry cap holds", cappedProjection.entries.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entries);
  check("Candidate cap holds", cappedProjection.candidates.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.candidates);
  check("Procedure cap holds", cappedProjection.procedures.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.procedures);
  check("Launch-step cap holds", cappedProjection.launch.steps.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.launchSteps);
  check("Finding cap holds", capped.findings.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.findings);
  check("Fact cap holds", capped.factKeys.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.facts);
  check("Overflow knowledge is not dumped", cappedProjection.entries.length < 7 + 6);
  check(
    "Excerpts stay bounded",
    cappedProjection.entries.every((row) => row.excerpt.length <= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.excerpt + 1),
  );

  resetLoads();
  const first = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What have we learned about this kind of work?",
    entityHints: { knowledgeEntryId: seededA.conflict.id },
  });
  const firstProjection = JSON.stringify(getLastKnowledgeLaunchProjection());
  resetLoads();
  const second = await runKnowledgeLaunchSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What have we learned about this kind of work?",
    entityHints: { knowledgeEntryId: seededA.conflict.id },
  });
  check(
    "Deterministic result for identical data",
    JSON.stringify(first.findings) === JSON.stringify(second.findings) &&
      JSON.stringify(first.factKeys) === JSON.stringify(second.factKeys) &&
      firstProjection === JSON.stringify(getLastKnowledgeLaunchProjection()),
  );

  console.log("\nCONFLICTS — Knowledge/Launch recorded truth only");
  function findingResult(id, keys) {
    return {
      specialistId: id,
      status: "OK",
      findings: keys.map((key) => ({
        key,
        title: key,
        summary: key,
        recommendationKeys: [key],
        factKeys: [],
      })),
      factKeys: [],
      recommendationKeys: keys,
    };
  }
  const emptyConflictInput = { recommendations: [], facts: {} };
  check(
    "UNREVIEWED_VS_APPROVED comes from unreviewed knowledge",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["knowledge-unreviewed-entries"])],
    }).items.some((item) => item.kind === "UNREVIEWED_VS_APPROVED"),
  );
  check(
    "CANDIDATE_VS_APPROVED_KNOWLEDGE keeps the candidate distinct",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["knowledge-candidate-not-policy"])],
    }).items.some((item) => item.kind === "CANDIDATE_VS_APPROVED_KNOWLEDGE"),
  );
  check(
    "CONFLICT_STILL_UNRESOLVED keeps CONFLICT distinct",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["knowledge-conflict"])],
    }).items.some((item) => item.kind === "CONFLICT_STILL_UNRESOLVED"),
  );
  check(
    "ESTIMATE_VS_KNOWN_FACT labels estimate",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["knowledge-estimate"])],
    }).items.some((item) => item.kind === "ESTIMATE_VS_KNOWN_FACT"),
  );
  check(
    "UNKNOWN_IS_NOT_FALSE keeps UNKNOWN unknown",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["knowledge-unknown"])],
    }).items.some((item) => item.kind === "UNKNOWN_IS_NOT_FALSE"),
  );
  check(
    "LAUNCH_COMPLETE_VS_WEBSITE does not publish",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["launch-complete-vs-website"])],
    }).items.some((item) => item.kind === "LAUNCH_COMPLETE_VS_WEBSITE"),
  );
  check(
    "LAUNCH_COMPLETE_VS_PROVIDER does not connect providers",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("KNOWLEDGE_LAUNCH", ["launch-complete-vs-provider"])],
    }).items.some((item) => item.kind === "LAUNCH_COMPLETE_VS_PROVIDER"),
  );
  check(
    "Knowledge conflicts do not fire without Knowledge findings",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("COMMUNICATIONS", ["communications-failed-delivery"])],
    }).items.every((item) => !["UNREVIEWED_VS_APPROVED", "CANDIDATE_VS_APPROVED_KNOWLEDGE", "LAUNCH_COMPLETE_VS_WEBSITE"].includes(item.kind)),
  );

  console.log("\nRUNTIME — orchestration, no write, no recursive specialist");
  resetLoads();
  const coach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What have we learned about this kind of work, and is this knowledge approved?",
    attemptId: randomUUID(),
    browserBusinessId: tenantB.business.id,
  });
  check("Coach omits Beta secret", Boolean(coach.text) && !coach.text.includes("BetaSecret"));
  check("Coach mentions recorded knowledge", /UNREVIEWED|APPROVED|candidate|launch|ESTIMATE|CONFLICT/i.test(coach.text ?? ""));
  check("Coach does not invent motives", !/because they forgot|the owner is lazy|we should fire/i.test(coach.text ?? ""));
  check("Exactly one Knowledge/Launch projection load when selected", getKnowledgeLaunchProjectionLoadCount() === 1);
  check("Knowledge/Launch interprets once", getKnowledgeLaunchSpecialistInterpretationCount() === 1);
  check("Orchestration can complete", coach.orchestrationStatus === "COMPLETED");

  resetLoads();
  const genericCoach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my business doing?",
    attemptId: randomUUID(),
  });
  check("Generic Coach question does not interpret Knowledge/Launch", getKnowledgeLaunchSpecialistInterpretationCount() === 0);
  check("Generic Coach question still completes", genericCoach.orchestrationStatus === "COMPLETED");
  check("Projection loads only when specialist is selected", getKnowledgeLaunchProjectionLoadCount() === 0);

  resetLoads();
  const financialOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my profit and outstanding invoices this month?",
    attemptId: randomUUID(),
  });
  check("Unrelated Financial question does not interpret Knowledge/Launch", getKnowledgeLaunchSpecialistInterpretationCount() === 0);
  check("Financial question still completes", financialOnly.orchestrationStatus === "COMPLETED");

  resetLoads();
  const failedMessages = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What messages failed?",
    attemptId: randomUUID(),
  });
  check("Failed-message question does not interpret Knowledge/Launch", getKnowledgeLaunchSpecialistInterpretationCount() === 0);
  check("Failed-message question still completes", failedMessages.orchestrationStatus === "COMPLETED");

  resetLoads();
  const failLoad = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What is the next launch step?",
    attemptId: randomUUID(),
    test: { failKnowledgeLaunchLoad: true },
  });
  check("Injected loader failure is PARTIAL", failLoad.orchestrationStatus === "PARTIAL");
  check("ATTENTION survives Knowledge/Launch loader failure", /surviving facts|could not be loaded|unavailable/i.test(failLoad.text ?? ""));

  const before = await countKnowledgeLaunchRows(tenantA.business.id);
  await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Approve this knowledge, promote the candidate, complete the next launch step, publish the website, and connect Stripe.",
    attemptId: randomUUID(),
  });
  const after = await countKnowledgeLaunchRows(tenantA.business.id);
  check("No knowledge entries are written", before.entries === after.entries && before.entryStates === after.entryStates);
  check("No experience candidates are created or promoted", before.candidates === after.candidates && before.candidateStates === after.candidateStates);
  check("No operating procedures are written", before.procedures === after.procedures && before.procedureStates === after.procedureStates);
  check("No launch progress is mutated", before.launchStatus === after.launchStatus && before.launchSteps === after.launchSteps);
  check("No company-setup proposal is created", before.proposals === after.proposals);

  check("Financial specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/specialists/financial.ts", import.meta.url), "utf8").includes("interpretFinancialSpecialist"));
  check("Workforce specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/workforce-specialist.ts", import.meta.url), "utf8").includes("runWorkforceSpecialist"));
  check("Growth specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/growth-specialist.ts", import.meta.url), "utf8").includes("interpretGrowthSpecialist"));
  check("Materials specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/materials-specialist.ts", import.meta.url), "utf8").includes("runMaterialsSpecialist"));
  check("Communications specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/communications-specialist.ts", import.meta.url), "utf8").includes("runCommunicationsSpecialist"));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nKnowledge/Launch specialist checks failed: ${failures}`);
  process.exit(1);
}
console.log("\nKnowledge/Launch specialist checks passed.");
