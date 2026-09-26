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

const { ForbiddenError, CAPABILITIES, requireBusinessCapability, roleHasCapability } = await import("@/lib/authorization");
const {
  BUSINESS_PROTECTION_CONTEXT_CAPS,
  BUSINESS_PROTECTION_TARGET_CONSISTENCY_LIMITATION,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  PROTECTION_STATE_CONTRACT,
  archivedIsNotActive,
  businessProtectionProjectionHasForbiddenFields,
  businessProtectionTextHasLegalSufficiency,
  checklistMetIsNotCompliance,
  completeDoesNotMeanEnforceable,
  currentIsNotInsured,
  draftIsNotComplete,
  draftIsNotReady,
  esignDisconnectedIsNotSigned,
  getBusinessProtectionProjectionLoadCount,
  getBusinessProtectionSpecialistInterpretationCount,
  getLastBusinessProtectionProjection,
  legalAckIsNotAttorneyApproval,
  missingDateIsNotCompliant,
  missingDateIsNotCurrent,
  noDateOptionalIsNotCurrent,
  ownerReviewIsRecordedOnly,
  planSpecialists,
  readyIsNotSent,
  resetBusinessProtectionSpecialistCounters,
  resetLastBusinessProtectionProjection,
  resolveConflicts,
  runBusinessProtectionSpecialist,
  runChiefOfStaffCoach,
  sentIsNotComplete,
} = await import("@/lib/chief-of-staff");
const { getSpecialistEntry } = await import("@/lib/chief-of-staff/registry");
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
  resetBusinessProtectionSpecialistCounters();
  resetLastBusinessProtectionProjection();
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
    projection.records.length === 0 &&
    projection.agreements.length === 0 &&
    projection.totals.records === 0 &&
    projection.totals.agreements === 0 &&
    projection.canReadDeep === false
  );
}

const NOW = new Date("2026-09-26T12:00:00.000Z");
const SECRET_NOTE = `VAULT_SECRET_NOTE_${randomUUID()}`;
const SECRET_DRAFT = `AGREEMENT_SECRET_DRAFT_${randomUUID()}`;
const SECRET_ANSWERS = `{"secret":"AGREEMENT_SECRET_ANSWERS_${randomUUID()}"}`;

async function countProtectionRows(businessId) {
  const [records, agreements, versions, audits, acks] = await Promise.all([
    prisma.businessVaultRecord.count({ where: { businessId } }),
    prisma.businessAgreement.count({ where: { businessId } }),
    prisma.businessAgreementVersion.count({ where: { businessId } }),
    prisma.businessProtectionAuditLog.count({ where: { businessId } }),
    prisma.businessProtectionAcknowledgment.count({ where: { businessId } }),
  ]);
  return { records, agreements, versions, audits, acks };
}

async function createVault(workspace, data) {
  return prisma.businessVaultRecord.create({
    data: {
      businessId: workspace.business.id,
      createdByMembershipId: workspace.membership.id,
      title: data.title,
      category: data.category,
      issuer: data.issuer ?? null,
      counterparty: data.counterparty ?? null,
      expiresOn: data.expiresOn ?? null,
      recordStatus: data.recordStatus ?? "ACTIVE",
      notes: data.notes ?? SECRET_NOTE,
    },
  });
}

async function createAgreement(workspace, data) {
  const agreement = await prisma.businessAgreement.create({
    data: {
      businessId: workspace.business.id,
      createdByMembershipId: workspace.membership.id,
      title: data.title,
      agreementType: data.agreementType ?? "CUSTOMER_AGREEMENT",
      lifecycleStatus: data.lifecycleStatus ?? "DRAFT",
      signingMode: data.signingMode ?? "NOT_CONNECTED",
      ownerReviewedAt: data.ownerReviewedAt ?? null,
      ownerReviewedByMembershipId: data.ownerReviewedAt ? workspace.membership.id : null,
      legalReviewAcknowledgedAt: data.legalReviewAcknowledgedAt ?? null,
      legalReviewAcknowledgedByMembershipId: data.legalReviewAcknowledgedAt
        ? workspace.membership.id
        : null,
      completedAt: data.completedAt ?? null,
      vaultRecordId: data.vaultRecordId ?? null,
    },
  });
  const version = await prisma.businessAgreementVersion.create({
    data: {
      businessId: workspace.business.id,
      agreementId: agreement.id,
      createdByMembershipId: workspace.membership.id,
      versionNumber: 1,
      representationStatus: "DRAFT",
      answersJson: SECRET_ANSWERS,
      draftContent: SECRET_DRAFT,
    },
  });
  return prisma.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      currentDraftVersionId: version.id,
      signedVersionId: data.signed ? version.id : null,
    },
  });
}

async function seedProtectionWorld(workspace, { secret = false } = {}) {
  const prefix = secret ? "BetaSecretVault" : "Alpha";
  const expired = await createVault(workspace, {
    title: `${prefix} expired insurance`,
    category: "INSURANCE",
    expiresOn: "2026-01-01",
  });
  const soon = await createVault(workspace, {
    title: `${prefix} expiring license`,
    category: "LICENSE",
    expiresOn: "2026-10-10",
  });
  const current = await createVault(workspace, {
    title: `${prefix} current warranty`,
    category: "WARRANTY",
    expiresOn: "2027-03-01",
  });
  const missing = await createVault(workspace, {
    title: `${prefix} missing insurance date`,
    category: "INSURANCE",
  });
  const optional = await createVault(workspace, {
    title: `${prefix} EIN optional date`,
    category: "EIN_TAX",
  });
  const archived = await createVault(workspace, {
    title: `${prefix} archived contract`,
    category: "CONTRACT",
    expiresOn: "2026-01-01",
    recordStatus: "ARCHIVED",
  });
  const draft = await createAgreement(workspace, {
    title: `${prefix} draft customer agreement`,
    lifecycleStatus: "DRAFT",
  });
  const ready = await createAgreement(workspace, {
    title: `${prefix} ready customer agreement`,
    lifecycleStatus: "READY",
    ownerReviewedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  const sent = await createAgreement(workspace, {
    title: `${prefix} sent customer agreement`,
    lifecycleStatus: "SENT",
    ownerReviewedAt: new Date("2026-09-01T00:00:00.000Z"),
    legalReviewAcknowledgedAt: new Date("2026-09-02T00:00:00.000Z"),
  });
  const complete = await createAgreement(workspace, {
    title: `${prefix} complete customer agreement`,
    lifecycleStatus: "COMPLETE",
    ownerReviewedAt: new Date("2026-09-01T00:00:00.000Z"),
    legalReviewAcknowledgedAt: new Date("2026-09-02T00:00:00.000Z"),
    completedAt: new Date("2026-09-20T00:00:00.000Z"),
    signed: true,
  });
  return { expired, soon, current, missing, optional, archived, draft, ready, sent, complete };
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

  console.log("\nSTATIC — Business Protection specialist is read/explain only");
  const entry = getSpecialistEntry("BUSINESS_PROTECTION");
  check("Registry enables existing BUSINESS_PROTECTION identity", entry.id === "BUSINESS_PROTECTION" && entry.enabled === true);
  check("Coach entry remains VIEW_REPORTS in runner", runSrc.includes("VIEW_REPORTS"));
  check("Deep read role floor is MANAGE_BUSINESS_PROTECTION", entry.requiredRoleCapability === CAPABILITIES.MANAGE_BUSINESS_PROTECTION);
  check("No invented product floor", entry.requiredProductCapability === null);
  check("Approval class is READ_EXPLAIN", entry.approvalClass === "READ_EXPLAIN");
  check("Deep loader is the bounded projection", entry.deepLoader === "business-protection-bounded-projection");
  check("Specialist performs no LLM call", !specialistSrc.includes("runAiTask") && !specialistSrc.includes("resolveAiProvider"));
  check(
    "Specialist does not call write paths",
    !specialistSrc.includes("createVaultRecord") &&
      !specialistSrc.includes("updateVaultRecord") &&
      !specialistSrc.includes("archiveVaultRecord") &&
      !specialistSrc.includes("authorizeVaultDocumentUpload") &&
      !specialistSrc.includes("completeAgreementExternally") &&
      !specialistSrc.includes("markAgreementOwnerReviewed") &&
      !specialistSrc.includes("acknowledgeAgreementLegalReview") &&
      !specialistSrc.includes("saveAgreementDraftContent") &&
      !specialistSrc.includes("transitionAgreementLifecycle") &&
      !specialistSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal"),
  );
  check(
    "Specialist does not invoke another specialist",
    !specialistSrc.includes("runWorkforceSpecialist") &&
      !specialistSrc.includes("runMaterialsSpecialist") &&
      !specialistSrc.includes("runCommunicationsSpecialist") &&
      !specialistSrc.includes("runKnowledgeLaunchSpecialist") &&
      !specialistSrc.includes("interpretFinancialSpecialist") &&
      !specialistSrc.includes("interpretGrowthSpecialist") &&
      !specialistSrc.includes("planSpecialists(") &&
      !specialistSrc.includes("runChiefOfStaffCoach"),
  );
  check("No Prisma schema change is required", schemaSrc.includes("model BusinessVaultRecord") && schemaSrc.includes("model BusinessAgreement"));
  check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
  check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);
  check(
    "Expiry and lifecycle states remain distinct",
    PROTECTION_STATE_CONTRACT.expiryStates.join(",") ===
      "CURRENT,EXPIRING_SOON,EXPIRED,MISSING_DATE,NO_DATE_OPTIONAL" &&
      PROTECTION_STATE_CONTRACT.recordStatuses.join(",") === "ACTIVE,ARCHIVED",
  );
  check("MISSING_DATE is not CURRENT", missingDateIsNotCurrent("MISSING_DATE"));
  check("MISSING_DATE is not compliant", missingDateIsNotCompliant("MISSING_DATE"));
  check("NO_DATE_OPTIONAL is not CURRENT", noDateOptionalIsNotCurrent("NO_DATE_OPTIONAL"));
  check("Checklist met is not compliance", checklistMetIsNotCompliance(true));
  check("DRAFT is not READY", draftIsNotReady("DRAFT"));
  check("DRAFT is not COMPLETE", draftIsNotComplete("DRAFT"));
  check("READY is not SENT", readyIsNotSent("READY"));
  check("SENT is not COMPLETE", sentIsNotComplete("SENT"));
  check("COMPLETE does not mean enforceable", completeDoesNotMeanEnforceable("COMPLETE"));
  check("E-sign disconnected is not signed", esignDisconnectedIsNotSigned("NOT_CONNECTED"));
  check("Owner review is recorded only", ownerReviewIsRecordedOnly(true));
  check("Legal ack is not attorney approval", legalAckIsNotAttorneyApproval(true));
  check("ARCHIVED is not ACTIVE", archivedIsNotActive("ARCHIVED"));
  check("CURRENT is not insured", currentIsNotInsured("CURRENT"));
  check("Live e-sign status stays NOT_CONNECTED", resolveEsignProviderStatus() === "NOT_CONNECTED");
  check("MEMBER lacks MANAGE_BUSINESS_PROTECTION", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_BUSINESS_PROTECTION));
  check("MEMBER lacks VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));

  const vaultPlan = planSpecialists({
    question: "What insurance is in the vault and what is expiring?",
    activeRecommendationKeys: [],
  });
  const genericPlan = planSpecialists({
    question: "How is my business doing?",
    activeRecommendationKeys: [],
  });
  const kitchen = planSpecialists({
    question: "What should I focus on this week for invoices, staff, materials, vault, growth, and knowledge?",
    activeRecommendationKeys: ["collect-unpaid-invoices"],
  });
  check("Planner selects BUSINESS_PROTECTION for vault/expiry questions", vaultPlan.selectedIds.includes("BUSINESS_PROTECTION"));
  check("Generic business question does not select BUSINESS_PROTECTION", !genericPlan.selectedIds.includes("BUSINESS_PROTECTION"));
  check("Kitchen-sink generic focus does not select BUSINESS_PROTECTION", !kitchen.selectedIds.includes("BUSINESS_PROTECTION"));
  check("Fan-out stays <= 4", vaultPlan.fanout <= 4 && kitchen.fanout <= 4);
  check("Recursion depth stays 1", vaultPlan.recursionDepth === 1 && kitchen.recursionDepth === 1);

  const tenantA = await createOwnerWorkspace("Alpha Protection");
  const tenantB = await createOwnerWorkspace("Beta Protection");
  await entitleFounder(tenantA.business.id);
  await entitleFounder(tenantB.business.id);
  const memberUser = await prisma.user.create({
    data: { name: "Alpha Member", email: `alpha-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(tenantA.business.id, "MEMBER", memberMembership.id, memberUser.id);
  const seededA = await seedProtectionWorld(tenantA);
  const seededB = await seedProtectionWorld(tenantB, { secret: true });

  console.log("\nAUTH — MEMBER block, tenant isolation, foreign target fail-closed");
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
  const memberResult = await runBusinessProtectionSpecialist({
    db: prisma,
    access: memberAccess,
    catalog: emptyCatalog(),
    question: "What is in the vault?",
    now: NOW,
  });
  check("MEMBER cannot receive business-wide Vault/agreement data", memberResult.status === "SKIPPED" && memberResult.skipReason === "NOT_AUTHORIZED");
  check("MEMBER assigned field work does not load a projection", getLastBusinessProtectionProjection() === null);
  check("MEMBER result has no vault findings", memberResult.findings.length === 0);
  check("MEMBER skip does not fake empty vault or compliance", /not treated as an empty vault or as legal compliance/i.test(memberResult.limitation ?? ""));

  resetLoads();
  const ownerResult = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What insurance and agreements are recorded?",
    now: NOW,
  });
  const ownerProjection = getLastBusinessProtectionProjection();
  check("Owner deep read succeeds", ownerResult.status === "OK" && ownerProjection.canReadDeep === true);
  check("Owner projection stays tenant-scoped", ownerProjection.records.every((row) => row.businessId === tenantA.business.id) && ownerProjection.agreements.every((row) => row.businessId === tenantA.business.id));
  check(
    "Foreign tenant records are absent",
    !JSON.stringify(ownerProjection).includes(seededB.expired.id) &&
      !JSON.stringify(ownerProjection).includes(seededB.draft.id) &&
      !JSON.stringify(ownerProjection).includes("BetaSecretVault") &&
      !JSON.stringify(ownerResult).includes("BetaSecretVault"),
  );

  resetLoads();
  const foreignVault = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is in this vault record?",
    entityHints: { vaultRecordId: seededB.expired.id },
    now: NOW,
  });
  const foreignVaultProjection = getLastBusinessProtectionProjection();
  check(
    "Foreign vault target fails closed",
    foreignVault.status === "OK" &&
      foreignVaultProjection.targetedVaultUnauthorized === true &&
      projectionIsClosed(foreignVaultProjection) &&
      !JSON.stringify(foreignVaultProjection).includes(seededB.expired.id) &&
      !JSON.stringify(foreignVaultProjection).includes(seededA.expired.id),
  );

  resetLoads();
  const foreignAgreement = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What is the lifecycle of this agreement?",
    entityHints: { agreementId: seededB.draft.id },
    now: NOW,
  });
  const foreignAgreementProjection = getLastBusinessProtectionProjection();
  check(
    "Foreign agreement target fails closed",
    foreignAgreement.status === "OK" &&
      foreignAgreementProjection.targetedAgreementUnauthorized === true &&
      projectionIsClosed(foreignAgreementProjection) &&
      !JSON.stringify(foreignAgreementProjection).includes(seededB.draft.id),
  );

  resetLoads();
  const mixedHints = await runBusinessProtectionSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Explain this vault record and agreement",
    entityHints: { vaultRecordId: seededA.expired.id, agreementId: seededB.draft.id },
    now: NOW,
  });
  const mixedProjection = getLastBusinessProtectionProjection();
  check(
    "Foreign + owned mix fails the entire targeted projection closed",
    mixedHints.status === "OK" &&
      mixedProjection.targetedAgreementUnauthorized === true &&
      mixedProjection.targetedEntityMismatch === true &&
      projectionIsClosed(mixedProjection) &&
      (mixedHints.limitation ?? "").includes(BUSINESS_PROTECTION_TARGET_CONSISTENCY_LIMITATION),
  );

  console.log("\nSTATES — expiry, checklist, lifecycle, and e-sign remain distinct");
  const expired = ownerProjection.records.find((row) => row.id === seededA.expired.id);
  const soon = ownerProjection.records.find((row) => row.id === seededA.soon.id);
  const current = ownerProjection.records.find((row) => row.id === seededA.current.id);
  const missing = ownerProjection.records.find((row) => row.id === seededA.missing.id);
  const optional = ownerProjection.records.find((row) => row.id === seededA.optional.id);
  const archived = ownerProjection.records.find((row) => row.id === seededA.archived.id);
  check("EXPIRED stays EXPIRED", expired?.expiryState === "EXPIRED" && expired.category === "INSURANCE");
  check("EXPIRING_SOON stays EXPIRING_SOON", soon?.expiryState === "EXPIRING_SOON" && soon.category === "LICENSE");
  check("CURRENT stays CURRENT", current?.expiryState === "CURRENT");
  check("MISSING_DATE stays MISSING_DATE", missing?.expiryState === "MISSING_DATE");
  check("NO_DATE_OPTIONAL stays NO_DATE_OPTIONAL", optional?.expiryState === "NO_DATE_OPTIONAL");
  check("ARCHIVED is owner-set and not used as CURRENT", archived?.recordStatus === "ARCHIVED" && archived.expiryState === "EXPIRED");
  check("MISSING_DATE is not treated as CURRENT in findings", ownerResult.findings.some((row) => row.key === "protection-missing-date" && /not CURRENT/.test(row.summary)));
  check("Checklist finding refuses compliance language", ownerResult.findings.some((row) => row.key === "protection-checklist-gap" && /not regulatory or legal compliance/.test(row.summary)));
  check("Insurance checklist can be met without implying compliance", ownerProjection.checklist.some((row) => row.id === "insurance" && row.met === true));

  const draft = ownerProjection.agreements.find((row) => row.id === seededA.draft.id);
  const ready = ownerProjection.agreements.find((row) => row.id === seededA.ready.id);
  const sent = ownerProjection.agreements.find((row) => row.id === seededA.sent.id);
  const complete = ownerProjection.agreements.find((row) => row.id === seededA.complete.id);
  check("DRAFT lifecycle stays DRAFT", draft?.lifecycleStatus === "DRAFT" && draft.completedRecorded === false);
  check("READY lifecycle stays READY", ready?.lifecycleStatus === "READY" && ready.ownerReviewRecorded === true);
  check("SENT lifecycle stays SENT", sent?.lifecycleStatus === "SENT" && sent.legalReviewAcknowledged === true);
  check("COMPLETE lifecycle stays COMPLETE", complete?.lifecycleStatus === "COMPLETE" && complete.completedRecorded === true);
  check("DRAFT finding is not READY/SENT/COMPLETE", ownerResult.findings.some((row) => row.key === "protection-agreement-draft" && /not READY, SENT, or COMPLETE/.test(row.summary)));
  check("READY finding is not SENT", ownerResult.findings.some((row) => row.key === "protection-agreement-ready" && /not SENT/.test(row.summary)));
  check("SENT finding is not COMPLETE", ownerResult.findings.some((row) => row.key === "protection-agreement-sent" && /not COMPLETE/.test(row.summary)));
  check("COMPLETE finding refuses legal sufficiency", ownerResult.findings.some((row) => row.key === "protection-agreement-complete" && /not legal sufficiency/.test(row.summary)));
  check("E-sign stays disconnected", ownerProjection.esign.connected === false && ownerProjection.esign.providerStatus === "NOT_CONNECTED");
  check("E-sign finding tells the disconnected truth", ownerResult.findings.some((row) => row.key === "protection-esign-disconnected" && /No e-sign provider is connected/.test(row.summary)));

  console.log("\nLEGAL / METADATA — no sufficiency language and no raw document content");
  const leakSurfaces = [JSON.stringify(ownerProjection), JSON.stringify(ownerResult)].join("\n");
  check("Projection has no forbidden fields", !businessProtectionProjectionHasForbiddenFields(ownerProjection));
  check("Specialist output has no legal-sufficiency language", !businessProtectionTextHasLegalSufficiency(ownerResult) && !businessProtectionTextHasLegalSufficiency(ownerProjection));
  check("Raw vault notes never reach Coach", !leakSurfaces.includes(SECRET_NOTE) && !leakSurfaces.includes("notes"));
  check("Raw agreement draft content never reaches Coach", !leakSurfaces.includes(SECRET_DRAFT) && !leakSurfaces.includes("draftContent"));
  check("Agreement answers never reach Coach", !leakSurfaces.includes(SECRET_ANSWERS) && !leakSurfaces.includes("answersJson"));
  check("No storage keys or private URLs", !leakSurfaces.includes("storageKey") && !leakSurfaces.includes("fileHref") && !leakSurfaces.includes("/api/storage/private"));

  console.log("\nBOUNDS — one projection load and caps");
  check("Exactly one projection load when selected", getBusinessProtectionProjectionLoadCount() === 1);
  check("Exactly one specialist interpretation", getBusinessProtectionSpecialistInterpretationCount() === 1);
  check(
    "Projection stays inside caps",
    ownerProjection.records.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.records &&
      ownerProjection.agreements.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.agreements &&
      ownerResult.findings.length <= BUSINESS_PROTECTION_CONTEXT_CAPS.findings,
  );

  const conflicts = resolveConflicts({
    results: [ownerResult],
    recommendations: [],
    facts: {},
  });
  check("MISSING_DATE vs CURRENT conflict is recorded", conflicts.items.some((row) => row.kind === "MISSING_DATE_VS_CURRENT"));
  check("Checklist vs compliance conflict is recorded", conflicts.items.some((row) => row.kind === "CHECKLIST_MET_VS_COMPLIANCE"));
  check("DRAFT vs COMPLETE conflict is recorded", conflicts.items.some((row) => row.kind === "DRAFT_VS_COMPLETE"));
  check("E-sign disconnected conflict is recorded", conflicts.items.some((row) => row.kind === "ESIGN_DISCONNECTED_VS_SIGNED"));

  console.log("\nRUNTIME — no writes and no recursive specialist");
  const before = await countProtectionRows(tenantA.business.id);
  resetLoads();
  const coach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What insurance is in the vault and which agreements are still draft?",
    attemptId: randomUUID(),
  });
  const after = await countProtectionRows(tenantA.business.id);
  check("Coach run stays read-only for vault and agreements", JSON.stringify(before) === JSON.stringify(after));
  check("Coach run does not invent legal sufficiency", !businessProtectionTextHasLegalSufficiency(coach));
  check("Selected specialist load stayed at one", getBusinessProtectionProjectionLoadCount() === 1);
  check("Coach text does not include raw secrets", !String(coach.text ?? "").includes(SECRET_NOTE) && !String(coach.text ?? "").includes(SECRET_DRAFT));

  if (failures > 0) {
    console.error(`\n${failures} Business Protection specialist check(s) failed.`);
    process.exit(1);
  }
  console.log("\nBusiness Protection specialist checks passed.");
} finally {
  await prisma.$disconnect();
}
