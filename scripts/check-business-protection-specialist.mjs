/**
 * AI Chief of Staff Business Protection specialist proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-protection-specialist.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability, roleHasCapability } = await import(
  "@/lib/authorization"
);
const {
  BUSINESS_PROTECTION_CONTEXT_CAPS,
  BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS,
  BUSINESS_PROTECTION_TARGET_CONSISTENCY_LIMITATION,
  FOREIGN_TARGET_LIMITATION,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  PROTECTION_STATE_CONTRACT,
  businessProtectionProjectionHasForbiddenFields,
  checklistMetIsNotCompliant,
  completionIsNotEnforceable,
  currentIsRecordedDateNotLegalValidity,
  esignStaysNotConnected,
  expiredIsRecordedDatePassed,
  expiringSoonUsesCanonicalWindow,
  getBusinessProtectionProjectionLoadCount,
  getBusinessProtectionSpecialistInterpretationCount,
  getLastBusinessProtectionProjection,
  lifecycleStatusesRemainDistinct,
  missingDateIsNotExpiredOrNoncompliant,
  noDateOptionalStaysDistinct,
  ownerReviewIsNotAttorneyReview,
  legalWarningAckIsNotAttorneyApproval,
  planSpecialists,
  resetBusinessProtectionSpecialistCounters,
  resetLastBusinessProtectionProjection,
  resolveConflicts,
  runBusinessProtectionSpecialist,
  runChiefOfStaffCoach,
} = await import("@/lib/chief-of-staff");
const { getSpecialistEntry, isSpecialistEnabled } = await import("@/lib/chief-of-staff/registry");
const { classifyExpiry, daysUntilCalendarDate, EXPIRING_SOON_DAYS } = await import(
  "@/lib/business-protection"
);
const { resolveEsignProviderStatus } = await import("@/lib/business-protection-esign");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_protection_specialist_test";
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
  resetBusinessProtectionSpecialistCounters();
  resetLastBusinessProtectionProjection();
}

function emptyCatalog() {
  return {
    facts: {},
    recommendations: [],
    activeRecommendations: [],
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
    projection.vaultRecords.length === 0 &&
    projection.agreements.length === 0 &&
    projection.canReadDeep === false &&
    projection.totals.vaultActive === 0 &&
    projection.totals.agreements === 0
  );
}

const SECRET_NOTES = "SECRET_VAULT_NOTES_DO_NOT_LEAK";
const SECRET_DRAFT = "SECRET_DRAFT_DO_NOT_LEAK";
const SECRET_ANSWERS = "SECRET_ANSWERS_DO_NOT_LEAK";
const SECRET_RISK = "SECRET_RISK_DO_NOT_LEAK";
const SECRET_PATH = "s3://secret-bucket/private/SECRET_FILE_PATH.pdf";
const BETA_SECRET = "BetaSecretInsurance";

const NOW = new Date(Date.UTC(2026, 8, 26));

async function seedProtectionWorld(workspace, { secret = false, extraVaults = 0 } = {}) {
  const prefix = secret ? "BetaSecret" : "Alpha";
  const businessId = workspace.business.id;
  const membershipId = workspace.membership.id;

  const insurance = await prisma.businessVaultRecord.create({
    data: {
      businessId,
      title: secret ? BETA_SECRET : "Alpha GL insurance",
      category: "INSURANCE",
      expiresOn: "2026-10-10",
      recordStatus: "ACTIVE",
      notes: secret ? "BETA_SECRET_NOTES" : `${SECRET_NOTES} ${SECRET_PATH}`,
      createdByMembershipId: membershipId,
    },
  });
  const expiredLicense = await prisma.businessVaultRecord.create({
    data: {
      businessId,
      title: `${prefix} expired license`,
      category: "LICENSE",
      expiresOn: "2026-09-01",
      recordStatus: "ACTIVE",
      notes: SECRET_NOTES,
      createdByMembershipId: membershipId,
    },
  });
  const currentWarranty = await prisma.businessVaultRecord.create({
    data: {
      businessId,
      title: `${prefix} current warranty`,
      category: "WARRANTY",
      expiresOn: "2026-12-01",
      recordStatus: "ACTIVE",
      createdByMembershipId: membershipId,
    },
  });
  const missingDate = await prisma.businessVaultRecord.create({
    data: {
      businessId,
      title: `${prefix} license missing date`,
      category: "LICENSE",
      recordStatus: "ACTIVE",
      createdByMembershipId: membershipId,
    },
  });
  const companyLegal = await prisma.businessVaultRecord.create({
    data: {
      businessId,
      title: `${prefix} articles of organization`,
      category: "COMPANY_LEGAL",
      recordStatus: "ACTIVE",
      createdByMembershipId: membershipId,
    },
  });

  const overflow = [];
  for (let i = 0; i < extraVaults; i += 1) {
    overflow.push(
      await prisma.businessVaultRecord.create({
        data: {
          businessId,
          title: `${prefix} overflow vault ${i + 1}`,
          category: "OTHER",
          recordStatus: "ACTIVE",
          notes: SECRET_NOTES,
          createdByMembershipId: membershipId,
        },
      }),
    );
  }

  async function createAgreement(title, lifecycleStatus, extras = {}) {
    const agreement = await prisma.businessAgreement.create({
      data: {
        businessId,
        title,
        agreementType: extras.agreementType ?? "SUBCONTRACTOR_AGREEMENT",
        lifecycleStatus,
        signingMode: extras.signingMode ?? "NOT_CONNECTED",
        vaultRecordId: extras.vaultRecordId ?? null,
        ownerReviewedAt: extras.ownerReviewedAt ?? null,
        legalReviewAcknowledgedAt: extras.legalReviewAcknowledgedAt ?? null,
        completedAt: extras.completedAt ?? null,
        createdByMembershipId: membershipId,
        completedByMembershipId: extras.completedByMembershipId ?? null,
      },
    });
    const version = await prisma.businessAgreementVersion.create({
      data: {
        businessId,
        agreementId: agreement.id,
        versionNumber: 1,
        representationStatus: extras.representationStatus ?? "DRAFT",
        answersJson: JSON.stringify({ hidden: SECRET_ANSWERS, purpose: "seeded answers" }),
        draftContent: `${SECRET_DRAFT} full unrestricted legal draft text`,
        riskReviewJson: JSON.stringify({ hidden: SECRET_RISK }),
        createdByMembershipId: membershipId,
      },
    });
    const signed = extras.signed
      ? await prisma.businessAgreement.update({
          where: { id: agreement.id },
          data: { signedVersionId: version.id, currentDraftVersionId: null },
        })
      : await prisma.businessAgreement.update({
          where: { id: agreement.id },
          data: { currentDraftVersionId: version.id },
        });
    return { agreement: signed, version };
  }

  const questions = await createAgreement(`${prefix} questions NDA`, "QUESTIONS", {
    agreementType: "NDA",
  });
  const draft = await createAgreement(`${prefix} draft vendor`, "DRAFT", {
    agreementType: "VENDOR_AGREEMENT",
  });
  const riskReview = await createAgreement(`${prefix} risk-review customer`, "RISK_REVIEW", {
    agreementType: "CUSTOMER_AGREEMENT",
  });
  const ownerReview = await createAgreement(`${prefix} owner-review subcontract`, "OWNER_REVIEW", {
    ownerReviewedAt: new Date("2026-09-20T00:00:00.000Z"),
  });
  const legalWarning = await createAgreement(`${prefix} legal-warning partnership`, "LEGAL_WARNING", {
    agreementType: "PARTNERSHIP_AGREEMENT",
    legalReviewAcknowledgedAt: new Date("2026-09-21T00:00:00.000Z"),
  });
  const ready = await createAgreement(`${prefix} ready referral`, "READY", {
    agreementType: "REFERRAL_AGREEMENT",
    ownerReviewedAt: new Date("2026-09-22T00:00:00.000Z"),
  });
  const sent = await createAgreement(`${prefix} sent customer`, "SENT", {
    agreementType: "CUSTOMER_AGREEMENT",
  });
  const complete = await createAgreement(`${prefix} complete subcontract`, "COMPLETE", {
    completedAt: new Date("2026-09-23T00:00:00.000Z"),
    completedByMembershipId: membershipId,
    signed: true,
    representationStatus: "SIGNED_FINAL",
    signingMode: "EXTERNAL_SIGNATURE",
  });
  const related = await createAgreement(`${prefix} related to insurance`, "DRAFT", {
    vaultRecordId: insurance.id,
  });
  const unrelated = await createAgreement(`${prefix} unrelated draft`, "DRAFT");

  return {
    insurance,
    expiredLicense,
    currentWarranty,
    missingDate,
    companyLegal,
    overflow,
    questions: questions.agreement,
    draft: draft.agreement,
    riskReview: riskReview.agreement,
    ownerReview: ownerReview.agreement,
    legalWarning: legalWarning.agreement,
    ready: ready.agreement,
    sent: sent.agreement,
    complete: complete.agreement,
    related: related.agreement,
    unrelated: unrelated.agreement,
    versions: [
      questions.version,
      draft.version,
      riskReview.version,
      ownerReview.version,
      legalWarning.version,
      ready.version,
      sent.version,
      complete.version,
      related.version,
      unrelated.version,
    ],
  };
}

async function snapshotProtection(businessId) {
  const [vaults, agreements, versions, audits] = await Promise.all([
    prisma.businessVaultRecord.findMany({
      where: { businessId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        notes: true,
        storedAssetId: true,
        recordStatus: true,
        expiresOn: true,
      },
    }),
    prisma.businessAgreement.findMany({
      where: { businessId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        lifecycleStatus: true,
        signedVersionId: true,
        completedAt: true,
        ownerReviewedAt: true,
        legalReviewAcknowledgedAt: true,
      },
    }),
    prisma.businessAgreementVersion.findMany({
      where: { businessId },
      orderBy: { id: "asc" },
      select: { id: true, draftContent: true, answersJson: true, riskReviewJson: true },
    }),
    prisma.businessProtectionAuditLog.findMany({
      where: { businessId },
      orderBy: { id: "asc" },
      select: { id: true, action: true },
    }),
  ]);
  return {
    vaultCount: vaults.length,
    agreementCount: agreements.length,
    versionCount: versions.length,
    auditCount: audits.length,
    vaults: JSON.stringify(vaults),
    agreements: JSON.stringify(agreements),
    versions: JSON.stringify(versions),
    audits: JSON.stringify(audits),
  };
}

try {
  const specialistSrc = readFileSync(
    new URL("../src/lib/chief-of-staff/business-protection-specialist.ts", import.meta.url),
    "utf8",
  );
  const snapshotSrc = readFileSync(
    new URL("../src/lib/chief-of-staff/business-protection-snapshot.ts", import.meta.url),
    "utf8",
  );
  const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const registrySrc = readFileSync(new URL("../src/lib/chief-of-staff/registry.ts", import.meta.url), "utf8");

  console.log("\nSTATIC — Business Protection specialist is read/explain only");
  const entry = getSpecialistEntry("BUSINESS_PROTECTION");
  check("Existing BUSINESS_PROTECTION identity becomes enabled", entry.id === "BUSINESS_PROTECTION" && entry.enabled === true);
  check("Registry uses MANAGE_BUSINESS_PROTECTION", entry.requiredRoleCapability === CAPABILITIES.MANAGE_BUSINESS_PROTECTION);
  check("No invented product capability", entry.requiredProductCapability === null);
  check("Approval class is READ_EXPLAIN", entry.approvalClass === "READ_EXPLAIN");
  check("Deep loader is the bounded projection", entry.deepLoader === "business-protection-bounded-projection");
  check("OWNER has the deep-read capability", roleHasCapability("OWNER", CAPABILITIES.MANAGE_BUSINESS_PROTECTION));
  check("ADMIN has the deep-read capability", roleHasCapability("ADMIN", CAPABILITIES.MANAGE_BUSINESS_PROTECTION));
  check("MEMBER lacks the deep-read capability", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_BUSINESS_PROTECTION));
  check("Specialist performs no LLM call", !specialistSrc.includes("runAiTask") && !specialistSrc.includes("resolveAiProvider"));
  check(
    "Specialist does not call write/action paths",
    !specialistSrc.includes("createVaultRecord") &&
      !specialistSrc.includes("updateVaultRecord") &&
      !specialistSrc.includes("authorizeVaultDocumentUpload") &&
      !specialistSrc.includes("finalizeVaultDocumentUpload") &&
      !specialistSrc.includes("abortVaultDocumentUpload") &&
      !specialistSrc.includes("releaseUnreferencedVaultAsset") &&
      !specialistSrc.includes("createAgreement") &&
      !specialistSrc.includes("saveAgreementAnswers") &&
      !specialistSrc.includes("generateAgreementDraft") &&
      !specialistSrc.includes("saveAgreementDraftContent") &&
      !specialistSrc.includes("markAgreementOwnerReviewed") &&
      !specialistSrc.includes("acknowledgeAgreementLegalReview") &&
      !specialistSrc.includes("markAgreementReady") &&
      !specialistSrc.includes("markAgreementSent") &&
      !specialistSrc.includes("completeAgreementExternally") &&
      !specialistSrc.includes("runAgreementAssist") &&
      !specialistSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal") &&
      !specialistSrc.includes("loadProtectionWorkspace"),
  );
  check(
    "Specialist does not invoke another specialist or Agreement Coach AI",
    !specialistSrc.includes("runWorkforceSpecialist") &&
      !specialistSrc.includes("runMaterialsSpecialist") &&
      !specialistSrc.includes("runCommunicationsSpecialist") &&
      !specialistSrc.includes("runKnowledgeLaunchSpecialist") &&
      !specialistSrc.includes("interpretFinancialSpecialist") &&
      !specialistSrc.includes("interpretGrowthSpecialist") &&
      !specialistSrc.includes("planSpecialists(") &&
      !specialistSrc.includes("runChiefOfStaffCoach") &&
      !specialistSrc.includes("@/lib/ai/agreements"),
  );
  check("No Prisma schema change is required", schemaSrc.includes("model BusinessVaultRecord") && schemaSrc.includes("model BusinessAgreement"));
  check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
  check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);
  check(
    "Canonical states remain distinct",
    PROTECTION_STATE_CONTRACT.vaultStatuses.join(",") === "ACTIVE,ARCHIVED" &&
      PROTECTION_STATE_CONTRACT.expiryStates.join(",") ===
        "CURRENT,EXPIRING_SOON,EXPIRED,MISSING_DATE,NO_DATE_OPTIONAL" &&
      PROTECTION_STATE_CONTRACT.lifecycleStatuses.join(",") ===
        "QUESTIONS,DRAFT,RISK_REVIEW,OWNER_REVIEW,LEGAL_WARNING,READY,SENT,SIGNED,COMPLETE,EXTERNAL_COMPLETE" &&
      PROTECTION_STATE_CONTRACT.expiringSoonDays === 30,
  );
  check("CURRENT is a recorded-date classifier", currentIsRecordedDateNotLegalValidity("CURRENT"));
  check(
    "EXPIRING_SOON stays on the canonical 30-day window",
    expiringSoonUsesCanonicalWindow("EXPIRING_SOON", 14) &&
      classifyExpiry({ category: "INSURANCE", expiresOn: "2026-10-10", now: NOW }) === "EXPIRING_SOON" &&
      daysUntilCalendarDate("2026-10-10", NOW) <= EXPIRING_SOON_DAYS,
  );
  check("EXPIRED means recorded date passed", expiredIsRecordedDatePassed("EXPIRED"));
  check("MISSING_DATE is not expired or noncompliant", missingDateIsNotExpiredOrNoncompliant("MISSING_DATE"));
  check("NO_DATE_OPTIONAL stays distinct", noDateOptionalStaysDistinct("NO_DATE_OPTIONAL"));
  check("Checklist met is not a compliance claim helper", checklistMetIsNotCompliant(true));
  check("OWNER_REVIEW helper does not become attorney review", ownerReviewIsNotAttorneyReview(true));
  check("Legal-warning acknowledgment is not attorney approval", legalWarningAckIsNotAttorneyApproval(true));
  check(
    "SIGNED/COMPLETE/EXTERNAL_COMPLETE stay completion facts",
    completionIsNotEnforceable("SIGNED") &&
      completionIsNotEnforceable("COMPLETE") &&
      completionIsNotEnforceable("EXTERNAL_COMPLETE"),
  );
  check(
    "Lifecycle statuses stay distinct",
    lifecycleStatusesRemainDistinct("QUESTIONS") === "QUESTIONS" &&
      lifecycleStatusesRemainDistinct("DRAFT") === "DRAFT" &&
      lifecycleStatusesRemainDistinct("OWNER_REVIEW") === "OWNER_REVIEW" &&
      lifecycleStatusesRemainDistinct("READY") === "READY",
  );
  check("E-sign helper stays NOT_CONNECTED", esignStaysNotConnected(resolveEsignProviderStatus()));
  check("No invented Protection recommendation keys", BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS.length === 0);
  check(
    "Projection caps stay deterministic",
    BUSINESS_PROTECTION_CONTEXT_CAPS.vaultRecords === 10 &&
      BUSINESS_PROTECTION_CONTEXT_CAPS.agreements === 8 &&
      BUSINESS_PROTECTION_CONTEXT_CAPS.findings === 16 &&
      BUSINESS_PROTECTION_CONTEXT_CAPS.facts === 24 &&
      BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds === 4 &&
      BUSINESS_PROTECTION_CONTEXT_CAPS.title === 120,
  );
  check("Existing Knowledge/Launch remains enabled", isSpecialistEnabled("KNOWLEDGE_LAUNCH"));
  check("Existing Communications remains enabled", isSpecialistEnabled("COMMUNICATIONS"));
  check("Existing Financial remains enabled", isSpecialistEnabled("FINANCIAL"));
  check("Existing Workforce remains enabled", isSpecialistEnabled("WORKFORCE"));
  check("Existing Growth remains enabled", isSpecialistEnabled("GROWTH"));
  check("Existing Materials remains enabled", isSpecialistEnabled("MATERIALS"));
  check("Registry still has only one BUSINESS_PROTECTION identity", (registrySrc.match(/id: "BUSINESS_PROTECTION"/g) || []).length === 1);

  const explicitQuestions = [
    "What is expiring in my business protection records?",
    "Do I have any insurance records expiring soon?",
    "What licenses or certifications have dates coming up?",
    "What is missing a renewal date?",
    "What is in my Business Vault?",
    "What is the status of this agreement?",
    "Which agreements are still drafts?",
    "Which agreements are waiting on owner review?",
    "Has this agreement been marked complete?",
    "Is e-sign connected?",
    "What protection records need my attention?",
    "What does my protection checklist show?",
  ];
  for (const question of explicitQuestions) {
    check(
      `Planner selects BUSINESS_PROTECTION for: ${question}`,
      planSpecialists({ question, activeRecommendationKeys: [] }).selectedIds.includes("BUSINESS_PROTECTION"),
    );
  }
  const genericQuestions = [
    "How is my business doing?",
    "What should I work on?",
    "Tell me everything.",
    "How is profit?",
    "What messages failed?",
    "What have we learned?",
    "What materials do I need?",
  ];
  for (const question of genericQuestions) {
    check(
      `Generic question does not select BUSINESS_PROTECTION: ${question}`,
      !planSpecialists({ question, activeRecommendationKeys: [] }).selectedIds.includes("BUSINESS_PROTECTION"),
    );
  }
  const targeted = planSpecialists({
    question: "How is my business doing?",
    activeRecommendationKeys: [],
    entityHints: { vaultRecordId: "vault-1" },
  });
  check("Explicit vault target hint selects BUSINESS_PROTECTION", targeted.selectedIds.includes("BUSINESS_PROTECTION"));
  const learned = planSpecialists({
    question: "What is in my Business Vault?",
    activeRecommendationKeys: [],
  });
  check("Fan-out stays <= 4", learned.fanout <= 4 && learned.selectedIds.length <= MAX_SPECIALIST_FANOUT);
  check("Recursion depth stays 1", learned.recursionDepth === 1);

  const tenantA = await createOwnerWorkspace("Alpha Protection");
  const tenantB = await createOwnerWorkspace("Beta Protection");
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

  const seededA = await seedProtectionWorld(tenantA, { extraVaults: 12 });
  const seededB = await seedProtectionWorld(tenantB, { secret: true });

  console.log("\nAUTH — owner/admin deep read, MEMBER, tenant isolation, fail-closed");
  check("MEMBER remains blocked from VIEW_REPORTS", !(() => {
    try {
      requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
      return true;
    } catch (error) {
      return !(error instanceof ForbiddenError);
    }
  })());
  check("MEMBER remains blocked from MANAGE_BUSINESS_PROTECTION", !(() => {
    try {
      requireBusinessCapability(memberAccess, CAPABILITIES.MANAGE_BUSINESS_PROTECTION);
      return true;
    } catch (error) {
      return !(error instanceof ForbiddenError);
    }
  })());

  resetLoads();
  const ownerResult = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is expiring in my business protection records?",
    now: NOW,
  });
  const ownerProjection = getLastBusinessProtectionProjection();
  check("OWNER authorized read works", ownerResult.status === "OK" && Boolean(ownerProjection));
  check("Owner sees local vault titles", ownerProjection.vaultRecords.some((row) => row.title.includes("Alpha GL insurance")));
  check("Tenant ownership is explicit on vault rows", ownerProjection.vaultRecords.every((row) => row.businessId === tenantA.business.id));
  check("Tenant ownership is explicit on agreements", ownerProjection.agreements.every((row) => row.businessId === tenantA.business.id));

  resetLoads();
  const adminResult = await runBusinessProtectionSpecialist({
    db: prisma,
    access: adminAccess,
    catalog: emptyCatalog(),
    question: "What is in my Business Vault?",
    now: NOW,
  });
  const adminProjection = getLastBusinessProtectionProjection();
  check("ADMIN authorized read works", adminResult.status === "OK" && adminProjection?.vaultRecords.some((row) => row.businessId === tenantA.business.id));
  check("ADMIN is not invented as OWNER-only", adminProjection.canReadDeep === true);

  resetLoads();
  const memberResult = await runBusinessProtectionSpecialist({
    db: prisma,
    access: memberAccess,
    catalog: emptyCatalog(),
    question: "What is in my Business Vault?",
    now: NOW,
  });
  check("MEMBER is blocked", memberResult.status === "SKIPPED" && memberResult.skipReason === "NOT_AUTHORIZED");
  check("MEMBER does not load a projection", getLastBusinessProtectionProjection() === null);
  check("MEMBER skip does not fake an empty vault", /not treated as an empty vault/i.test(memberResult.limitation ?? ""));

  resetLoads();
  const tenantBResult = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantB.access,
    catalog: emptyCatalog(),
    question: "What is in my Business Vault?",
    now: NOW,
  });
  const tenantBProjection = getLastBusinessProtectionProjection();
  check("Tenant B run is OK", tenantBResult.status === "OK");
  check("Tenant B Vault records never appear for tenant A", !JSON.stringify(ownerProjection).includes(BETA_SECRET));
  check("Tenant B agreements never appear for tenant A", !ownerProjection.agreements.some((row) => row.title.includes("BetaSecret")));
  check("Tenant A titles never appear for tenant B", !JSON.stringify(tenantBProjection).includes("Alpha GL insurance"));

  resetLoads();
  const foreignVault = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is the status of this agreement?",
    entityHints: { vaultRecordId: seededB.insurance.id },
    now: NOW,
  });
  check("Foreign vaultRecordId fails closed", projectionIsClosed(getLastBusinessProtectionProjection()) && foreignVault.status === "OK");
  check(
    "Foreign vault limitation is generic and does not reveal existence",
    (foreignVault.limitation ?? "").includes(FOREIGN_TARGET_LIMITATION) &&
      !(foreignVault.limitation ?? "").includes(BETA_SECRET),
  );
  check("Foreign vault does not substitute a local record", !getLastBusinessProtectionProjection().vaultRecords.some((row) => row.id === seededA.insurance.id));

  resetLoads();
  const foreignAgreement = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is the status of this agreement?",
    entityHints: { agreementId: seededB.ownerReview.id },
    now: NOW,
  });
  check("Foreign agreementId fails closed", projectionIsClosed(getLastBusinessProtectionProjection()));
  check("Foreign agreement does not substitute a local agreement", !getLastBusinessProtectionProjection().agreements.some((row) => row.id === seededA.ownerReview.id));

  resetLoads();
  const contradictory = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is the status of this agreement?",
    entityHints: {
      vaultRecordId: seededA.insurance.id,
      agreementId: seededA.unrelated.id,
    },
    now: NOW,
  });
  check("Contradictory same-tenant targets fail closed", projectionIsClosed(getLastBusinessProtectionProjection()));
  check(
    "Contradictory-target limitation is generic",
    (contradictory.limitation ?? "").includes(BUSINESS_PROTECTION_TARGET_CONSISTENCY_LIMITATION),
  );
  check("Contradictory targeting does not open a whole-business view", contradictory.status === "OK" && getLastBusinessProtectionProjection().totals.vaultActive === 0);

  resetLoads();
  const relatedTargets = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is the status of this agreement?",
    entityHints: {
      vaultRecordId: seededA.insurance.id,
      agreementId: seededA.related.id,
    },
    now: NOW,
  });
  const relatedProjection = getLastBusinessProtectionProjection();
  check("Canonically related same-tenant targets combine", relatedTargets.status === "OK" && relatedProjection.canReadDeep);
  check("Related target keeps the vault", relatedProjection.vaultRecords.some((row) => row.id === seededA.insurance.id));
  check("Related target keeps the agreement", relatedProjection.agreements.some((row) => row.id === seededA.related.id));

  console.log("\nBOUNDS — projection caps, private-field exclusion, recorded-truth states");
  resetLoads();
  const capped = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What protection records need my attention?",
    now: NOW,
  });
  const cappedProjection = getLastBusinessProtectionProjection();
  check("Vault projection is deterministically capped", cappedProjection.vaultRecords.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.vaultRecords);
  check("Agreement projection is deterministically capped", cappedProjection.agreements.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.agreements);
  check("Finding cap holds", capped.findings.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.findings);
  check("Fact cap holds", capped.factKeys.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.facts);
  check("Overflow vault titles are not all dumped", cappedProjection.vaultRecords.length < 5 + 12);
  check(
    "Titles stay bounded",
    cappedProjection.vaultRecords.every((row) => row.title.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.title + 1) &&
      cappedProjection.agreements.every((row) => row.title.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.title + 1),
  );
  const raw = JSON.stringify(cappedProjection);
  check("No notes/private file paths/storage IDs leak", !raw.includes(SECRET_NOTES) && !raw.includes(SECRET_PATH) && !raw.includes("storedAssetId") && !raw.includes("fileHref") && !raw.includes("privateAssetPath"));
  check("No draftContent leaks", !raw.includes(SECRET_DRAFT) && !raw.includes("draftContent"));
  check("No answersJson / answers leak", !raw.includes(SECRET_ANSWERS) && !raw.includes("answersJson") && !/"answers"/.test(raw));
  check("No riskReviewJson leaks", !raw.includes(SECRET_RISK) && !raw.includes("riskReviewJson"));
  check("No membership IDs leak", !raw.includes("MembershipId") && !raw.includes(tenantA.membership.id) && !raw.includes(adminMembership.id));
  check("No forbidden/private fields leak", !businessProtectionProjectionHasForbiddenFields(cappedProjection));

  const insuranceRow = cappedProjection.vaultRecords.find((row) => row.id === seededA.insurance.id);
  const expiredRow = cappedProjection.vaultRecords.find((row) => row.id === seededA.expiredLicense.id);
  const currentRow = cappedProjection.vaultRecords.find((row) => row.id === seededA.currentWarranty.id);
  const missingRow = cappedProjection.vaultRecords.find((row) => row.id === seededA.missingDate.id);
  const optionalRow = cappedProjection.vaultRecords.find((row) => row.id === seededA.companyLegal.id);
  check("CURRENT remains a recorded-date classifier, not legal validity", currentRow?.expiryState === "CURRENT" && !/legally valid|licensed|insured|compliant/.test(JSON.stringify(capped.findings.find((row) => row.key === "protection-current-recorded-date"))));
  check("EXPIRING_SOON remains based on the canonical 30-day classifier", insuranceRow?.expiryState === "EXPIRING_SOON");
  check("EXPIRED means recorded date passed, not regulatory noncompliance", expiredRow?.expiryState === "EXPIRED" && /not a legal or regulatory determination|not regulatory/.test(capped.findings.find((row) => row.key === "protection-expired-recorded-date")?.summary ?? ""));
  check("MISSING_DATE stays missing date, not expired/noncompliant", missingRow?.expiryState === "MISSING_DATE" && /does not prove expiration or noncompliance/.test(capped.findings.find((row) => row.key === "protection-missing-date")?.summary ?? ""));
  check("NO_DATE_OPTIONAL stays distinct", optionalRow?.expiryState === "NO_DATE_OPTIONAL" || cappedProjection.totals.noDateOptional > 0);

  const checklistFinding = capped.findings.find((row) => row.key === "protection-checklist-organization");
  check("Checklist met/present does not become compliant", /does not mean compliant|not mean compliant|organization checklist/i.test(checklistFinding?.summary ?? "") && !/you are compliant|you are licensed|you are legally protected/i.test(checklistFinding?.summary ?? ""));
  check("Canonical legal messages are preserved", (checklistFinding?.summary ?? "").includes("does not guarantee legal") && (checklistFinding?.summary ?? "").includes("not a nationwide licensing"));

  const lifecycleFinding = capped.findings.find((row) => row.key === "protection-agreement-lifecycle");
  check(
    "QUESTIONS/DRAFT/RISK_REVIEW/OWNER_REVIEW/LEGAL_WARNING/READY/SENT/SIGNED/COMPLETE/EXTERNAL_COMPLETE stay distinct",
    /QUESTIONS is not DRAFT/.test(lifecycleFinding?.summary ?? "") &&
      /DRAFT is not READY/.test(lifecycleFinding?.summary ?? "") &&
      /OWNER_REVIEW is a recorded owner review/.test(lifecycleFinding?.summary ?? "") &&
      /SIGNED, COMPLETE, and EXTERNAL_COMPLETE/.test(lifecycleFinding?.summary ?? ""),
  );
  check("OWNER_REVIEW does not become attorney review", /not attorney approval/.test(capped.findings.find((row) => row.key === "protection-owner-review-recorded")?.summary ?? ""));
  check("legalReviewAcknowledgedAt does not become attorney approval", /does not mean an attorney reviewed it/.test(capped.findings.find((row) => row.key === "protection-legal-warning-acknowledged")?.summary ?? ""));
  check("COMPLETE / SIGNED / EXTERNAL_COMPLETE do not become legally valid/enforceable", /not legal validity, enforceability/.test(capped.findings.find((row) => row.key === "protection-agreement-complete-not-enforceable")?.summary ?? lifecycleFinding?.summary ?? ""));
  check("e-sign NOT_CONNECTED stays NOT_CONNECTED even if a record is complete/signed externally", cappedProjection.esign.providerStatus === "NOT_CONNECTED" && /NOT_CONNECTED/.test(capped.findings.find((row) => row.key === "protection-esign-not-connected")?.summary ?? ""));
  check(
    "Projected vault metadata is only the safe fields",
    insuranceRow &&
      Object.keys(insuranceRow).sort().join(",") ===
        "businessId,category,effectiveOn,expiresOn,expiryState,id,recordStatus,renewalAttention,targeted,title",
  );
  check(
    "Projected agreement metadata is only the safe fields",
    cappedProjection.agreements[0] &&
      Object.keys(cappedProjection.agreements[0]).sort().join(",") ===
        "agreementType,businessId,completionRecorded,effectiveOn,expiresOn,hasSignedVersion,id,legalWarningAcknowledged,lifecycleStatus,ownerReviewRecorded,signingMode,targeted,title",
  );

  console.log("\nCONFLICTS — narrow recorded-truth distinctions only");
  function findingResult(id, keys) {
    return {
      specialistId: id,
      status: "OK",
      findings: keys.map((key) => ({
        key,
        title: key,
        summary: key,
        recommendationKeys: [],
        factKeys: [],
      })),
      factKeys: [],
      recommendationKeys: [],
    };
  }
  const emptyConflictInput = { recommendations: [], facts: {} };
  check(
    "CHECKLIST_PRESENT_VS_COMPLIANCE fires from the checklist finding",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("BUSINESS_PROTECTION", ["protection-checklist-organization"])],
    }).items.some((item) => item.kind === "CHECKLIST_PRESENT_VS_COMPLIANCE"),
  );
  check(
    "RECORDED_EXPIRY_VS_LEGAL_STATUS fires from expiry findings",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("BUSINESS_PROTECTION", ["protection-expiring-soon"])],
    }).items.some((item) => item.kind === "RECORDED_EXPIRY_VS_LEGAL_STATUS"),
  );
  check(
    "OWNER_REVIEW_VS_LEGAL_REVIEW stays distinct",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("BUSINESS_PROTECTION", ["protection-owner-review-recorded"])],
    }).items.some((item) => item.kind === "OWNER_REVIEW_VS_LEGAL_REVIEW"),
  );
  check(
    "AGREEMENT_COMPLETE_VS_ENFORCEABLE stays distinct",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("BUSINESS_PROTECTION", ["protection-agreement-complete-not-enforceable"])],
    }).items.some((item) => item.kind === "AGREEMENT_COMPLETE_VS_ENFORCEABLE"),
  );
  check(
    "ESIGN_NOT_CONNECTED_VS_DIGITAL_SIGNATURE stays distinct",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("BUSINESS_PROTECTION", ["protection-esign-not-connected"])],
    }).items.some((item) => item.kind === "ESIGN_NOT_CONNECTED_VS_DIGITAL_SIGNATURE"),
  );
  check(
    "Protection conflicts do not fire without Protection findings",
    resolveConflicts({
      ...emptyConflictInput,
      results: [findingResult("COMMUNICATIONS", ["communications-failed-delivery"])],
    }).items.every((item) => !["CHECKLIST_PRESENT_VS_COMPLIANCE", "RECORDED_EXPIRY_VS_LEGAL_STATUS", "ESIGN_NOT_CONNECTED_VS_DIGITAL_SIGNATURE"].includes(item.kind)),
  );

  console.log("\nRUNTIME — projection only when selected, Coach proof, no write");
  resetLoads();
  const coach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What is expiring in my business protection records, and what is the status of the owner-review agreement? Is e-sign connected?",
    attemptId: randomUUID(),
    browserBusinessId: tenantB.business.id,
  });
  check("Projection loads only when BUSINESS_PROTECTION is selected", getBusinessProtectionProjectionLoadCount() === 1);
  check("Specialist interprets once", getBusinessProtectionSpecialistInterpretationCount() === 1);
  check("Coach can name the expiring insurance record", /Alpha GL insurance/i.test(coach.text ?? "") && /INSURANCE|EXPIRING_SOON/i.test(coach.text ?? ""));
  check("Coach reports OWNER_REVIEW, not legally approved", /OWNER_REVIEW/i.test(coach.text ?? "") && !/attorney approved|legally approved|legally valid|enforceable contract/i.test(coach.text ?? ""));
  check("Coach reports e-sign NOT_CONNECTED", /NOT_CONNECTED|No e-sign provider is connected/i.test(coach.text ?? ""));
  check("Private notes/draft/secrets never appear in Coach output", !/SECRET_VAULT_NOTES|SECRET_DRAFT|SECRET_ANSWERS|SECRET_RISK|SECRET_FILE_PATH|BetaSecret/i.test(coach.text ?? ""));
  check("Coach does not invent compliance", !/you are compliant|you are licensed|your insurance is valid|you are legally protected/i.test(coach.text ?? ""));

  resetLoads();
  const genericCoach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my business doing?",
    attemptId: randomUUID(),
  });
  check("Generic Coach questions do not automatically select BUSINESS_PROTECTION", getBusinessProtectionSpecialistInterpretationCount() === 0);
  check("Generic Coach question still completes", genericCoach.orchestrationStatus === "COMPLETED");
  check("Projection does not load for generic questions", getBusinessProtectionProjectionLoadCount() === 0);

  resetLoads();
  const financialOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is profit?",
    attemptId: randomUUID(),
  });
  check("Profit question does not interpret Business Protection", getBusinessProtectionSpecialistInterpretationCount() === 0);
  check("Profit question still completes", financialOnly.orchestrationStatus === "COMPLETED");

  resetLoads();
  const learnedOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What have we learned?",
    attemptId: randomUUID(),
  });
  check("Learned question does not interpret Business Protection", getBusinessProtectionSpecialistInterpretationCount() === 0);
  check("Learned question still completes", learnedOnly.orchestrationStatus === "COMPLETED");

  resetLoads();
  const failLoad = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What is in my Business Vault?",
    attemptId: randomUUID(),
    test: { failBusinessProtectionLoad: true },
  });
  check("Injected loader failure is PARTIAL", failLoad.orchestrationStatus === "PARTIAL");
  check("ATTENTION survives Business Protection loader failure", /surviving facts|could not be loaded|unavailable/i.test(failLoad.text ?? ""));

  const before = await snapshotProtection(tenantA.business.id);
  const writeCoach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Mark this agreement legally approved, sign it, upload it, and renew my insurance.",
    attemptId: randomUUID(),
  });
  const after = await snapshotProtection(tenantA.business.id);
  check("No BusinessVaultRecord mutation occurs", before.vaultCount === after.vaultCount && before.vaults === after.vaults);
  check("No BusinessAgreement mutation occurs", before.agreementCount === after.agreementCount && before.agreements === after.agreements);
  check("No BusinessAgreementVersion mutation occurs", before.versionCount === after.versionCount && before.versions === after.versions);
  check("No BusinessProtectionAuditLog mutation occurs", before.auditCount === after.auditCount && before.audits === after.audits);
  check(
    "Write-command Coach stays read/explain",
    /recorded organizational|NOT_CONNECTED|does not sign|Coach does not sign|not a determination|OWNER_REVIEW|EXPIRING_SOON/i.test(writeCoach.text ?? "") &&
      !/I signed|I uploaded|I renewed|marked legally approved/i.test(writeCoach.text ?? ""),
  );

  check("Financial specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/specialists/financial.ts", import.meta.url), "utf8").includes("interpretFinancialSpecialist"));
  check("Workforce specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/workforce-specialist.ts", import.meta.url), "utf8").includes("runWorkforceSpecialist"));
  check("Growth specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/growth-specialist.ts", import.meta.url), "utf8").includes("interpretGrowthSpecialist"));
  check("Materials specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/materials-specialist.ts", import.meta.url), "utf8").includes("runMaterialsSpecialist"));
  check("Communications specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/communications-specialist.ts", import.meta.url), "utf8").includes("runCommunicationsSpecialist"));
  check("Knowledge/Launch specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/knowledge-launch-specialist.ts", import.meta.url), "utf8").includes("runKnowledgeLaunchSpecialist"));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nBusiness Protection specialist checks failed: ${failures}`);
  process.exit(1);
}
console.log("\nBusiness Protection specialist checks passed.");
