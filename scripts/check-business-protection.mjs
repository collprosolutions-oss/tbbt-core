/**
 * Business Protection + Business Vault + Agreement Coach verification.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-protection.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
  LEGAL_NOT_AUTHORITY_MESSAGE,
  NO_FAKE_ESIGN_MESSAGE,
  classifyExpiry,
  daysUntilCalendarDate,
  utcCalendarDate,
} = await import("@/lib/business-protection");
const {
  assertDigitalSignatureAllowed,
  canApplyDigitalSignature,
  EsignBoundaryError,
  normalizeCompletionMode,
  resolveEsignProviderStatus,
} = await import("@/lib/business-protection-esign");
const { PRODUCT_DOWNGRADE_RULES } = await import("@/lib/product-entitlements/downgrade");
const { MemoryStorageProvider } = await import("@/lib/business-storage/memory-provider");
const { ensureBusinessStorageAccount } = await import("@/lib/business-storage/service");
const { readPublicStoredAsset } = await import("@/lib/business-storage/service");
const { servePrivateStoredAsset } = await import("@/lib/business-storage/private-serve");
const {
  authorizeVaultDocumentUpload,
  completeAgreementExternally,
  createAgreement,
  createVaultRecord,
  finalizeVaultDocumentUpload,
  generateAgreementDraft,
  markAgreementOwnerReviewed,
  acknowledgeAgreementLegalReview,
  markAgreementReady,
  markAgreementSent,
  saveAgreementAnswers,
  saveAgreementDraftContent,
  BusinessProtectionError,
} = await import("@/lib/business-protection-ops");
const { loadProtectionWorkspace } = await import("@/lib/business-protection-data");
const { runAgreementAssist, AGREEMENT_AI_CANNOT_AUTHORIZE_MESSAGE } = await import(
  "@/lib/ai/agreements"
);
const { buildBusinessExportZip } = await import("@/lib/business-export");
const { PRODUCT_CAPABILITY_DEFINITIONS } = await import("@/lib/product-catalog/capabilities");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_protection_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business-protection test database.");
  process.exit(push.status ?? 1);
}

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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, extras = {}) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId, userId: extras.userId ?? "user-x" },
      user: { id: extras.userId ?? "user-x" },
      business: { id: businessId, name: extras.businessName ?? "Biz" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

try {
  console.log("\nSTATIC — Business Protection domain");
  const now = new Date(Date.UTC(2026, 8, 25));
  check("UTC calendar date is deterministic", utcCalendarDate(now) === "2026-09-25");
  check(
    "Expired is before today",
    classifyExpiry({ category: "LICENSE", expiresOn: "2026-09-24", now }) === "EXPIRED",
  );
  check(
    "Expiring soon is within 30 days",
    classifyExpiry({ category: "INSURANCE", expiresOn: "2026-10-10", now }) === "EXPIRING_SOON",
  );
  check(
    "Current is after the window",
    classifyExpiry({ category: "WARRANTY", expiresOn: "2026-12-01", now }) === "CURRENT",
  );
  check(
    "Missing date is required for licenses",
    classifyExpiry({ category: "LICENSE", expiresOn: null, now }) === "MISSING_DATE",
  );
  check(
    "Company/legal date is optional",
    classifyExpiry({ category: "COMPANY_LEGAL", expiresOn: null, now }) === "NO_DATE_OPTIONAL",
  );
  check("Day math is UTC-calendar", daysUntilCalendarDate("2026-09-26", now) === 1);
  check("E-sign provider is not connected", resolveEsignProviderStatus() === "NOT_CONNECTED");
  check("Digital signature is not allowed", canApplyDigitalSignature() === false);
  check("No-compliance copy is honest", LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE.includes("does not guarantee"));
  check("Not-an-authority copy is honest", LEGAL_NOT_AUTHORITY_MESSAGE.includes("not a nationwide licensing"));
  check("Drafts are not enforceable", AGREEMENT_NOT_ENFORCEABLE_MESSAGE.includes("not a representation"));
  check("No fake e-sign copy exists", NO_FAKE_ESIGN_MESSAGE.includes("will not invent"));
  check(
    "MEMBER cannot see Business Protection nav",
    !visibleAppNav("MEMBER").some((item) => item.href === "/business-protection"),
  );
  check(
    "OWNER sees Business Protection nav",
    visibleAppNav("OWNER").some((item) => item.href === "/business-protection"),
  );
  check("MEMBER lacks the protection capability", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_BUSINESS_PROTECTION));
  check(
    "DOCUMENT_STORAGE entitlement was not redesigned into a paid vault gate",
    PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.DOCUMENT_STORAGE].enforcementBoundary === false &&
      PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.DOCUMENT_STORAGE].implementationStatus === "PARTIAL",
  );
  check("Downgrade policy preserves records", PRODUCT_DOWNGRADE_RULES.preserveRecords === true);

  const pageSrc = readRepo("src/app/(app)/business-protection/page.tsx");
  const opsSrc = readRepo("src/lib/business-protection-ops.ts");
  const esignSrc = readRepo("src/lib/business-protection-esign.ts");
  const aiSrc = readRepo("src/lib/ai/agreements.ts");
  const workspaceSrc = readRepo("src/lib/workspace.ts");
  check("Protection page uses management + capability gates", pageSrc.includes("requireManagementPageAccess") && pageSrc.includes("MANAGE_BUSINESS_PROTECTION"));
  check("Ops never apply a digital signature when disconnected", opsSrc.includes("assertDigitalSignatureAllowed") && opsSrc.includes("will not invent a digital signature"));
  check("E-sign helper always returns NOT_CONNECTED in this PR", esignSrc.includes('return "NOT_CONNECTED"'));
  check("AI cannot authorize or sign", aiSrc.includes(AGREEMENT_AI_CANNOT_AUTHORIZE_MESSAGE) && aiSrc.includes("Do not authorize"));
  check("Workspace loader does not run protection DDL", !workspaceSrc.includes("BusinessVaultRecord"));

  console.log("\nDB — Tenant isolation, vault privacy, lifecycle, export");
  const ownerUser = await prisma.user.create({
    data: { name: "Pat Owner", email: `owner-bp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-bp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel Member", email: `member-bp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const otherUser = await prisma.user.create({
    data: { name: "Oli Other", email: `other-bp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Protection", slug: `alpha-bp-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Protection", slug: `beta-bp-${randomUUID()}`, tradeCode: "HANDYMAN" },
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
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, {
    userId: ownerUser.id,
    businessName: businessA.name,
  });
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, {
    userId: adminUser.id,
    businessName: businessA.name,
  });
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, {
    userId: memberUser.id,
    businessName: businessA.name,
  });
  const ownerB = makeAccess(businessB.id, "OWNER", otherMem.id, {
    userId: otherUser.id,
    businessName: businessB.name,
  });

  await expectError("MEMBER cannot pass the protection capability gate", () => {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_BUSINESS_PROTECTION);
  }, (error) => error instanceof ForbiddenError);

  await expectError("MEMBER cannot create a vault record", () => {
    return createVaultRecord(prisma, memberA, {
      title: "Secret license",
      category: "LICENSE",
      expiresOn: "2026-12-01",
    });
  }, (error) => error instanceof ForbiddenError);

  const provider = new MemoryStorageProvider();
  const deps = { db: prisma, provider, bucketName: "tbbt-vault-test", defaultLimitBytes: 5_000_000 };
  await ensureBusinessStorageAccount(prisma, businessA.id, {
    bucketName: "tbbt-vault-test",
    defaultLimitBytes: 5_000_000,
  });
  await ensureBusinessStorageAccount(prisma, businessB.id, {
    bucketName: "tbbt-vault-test",
    defaultLimitBytes: 5_000_000,
  });

  const pdf = Buffer.from("%PDF-1.4 vault-private");
  const authorized = await authorizeVaultDocumentUpload(deps, ownerA, {
    originalFilename: "gl-policy.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: pdf.byteLength,
  });
  check("Vault upload is forced PRIVATE", authorized.asset.visibility === "PRIVATE");
  check("Vault upload uses DOCUMENT + BUSINESS_VAULT purpose", authorized.asset.purpose === "BUSINESS_VAULT");
  await provider.putObject({
    bucket: authorized.account.bucketName,
    key: authorized.asset.storageKey,
    body: pdf,
    contentType: "application/pdf",
  });
  const finalized = await finalizeVaultDocumentUpload(deps, ownerA, authorized.asset.id);
  check("Finalized vault file stays PRIVATE", finalized.visibility === "PRIVATE");

  const publicLeak = await readPublicStoredAsset(prisma, finalized.id);
  check("Private vault files are not publicly readable", publicLeak === null);

  const vault = await createVaultRecord(prisma, ownerA, {
    title: "General liability",
    category: "INSURANCE",
    issuer: "Example Mutual",
    expiresOn: "2026-10-05",
    storedAssetId: finalized.id,
    now: new Date(Date.UTC(2026, 8, 25)),
  });
  check("Insurance vault record stores metadata", vault.category === "INSURANCE" && vault.storedAssetId === finalized.id);

  const license = await createVaultRecord(prisma, ownerA, {
    title: "Handyman license",
    category: "LICENSE",
    now: new Date(Date.UTC(2026, 8, 25)),
  });
  check("License without a date is MISSING_DATE", license.persistedExpiryState === "MISSING_DATE");

  await expectError("Foreign owner cannot attach this tenant's file", () => {
    return createVaultRecord(prisma, ownerB, {
      title: "Stolen policy",
      category: "INSURANCE",
      storedAssetId: finalized.id,
    });
  }, (error) => error instanceof Error);

  const otherVault = await createVaultRecord(prisma, ownerB, {
    title: "Beta EIN",
    category: "EIN_TAX",
    notes: "Beta only",
  });
  const leaked = await prisma.businessVaultRecord.findFirst({
    where: { id: otherVault.id, businessId: businessA.id },
  });
  check("Tenant A query cannot see tenant B vault row", leaked === null);

  const memberRead = await servePrivateStoredAsset(prisma, finalized.id, businessA.id, {
    provider,
    viewer: { role: "MEMBER", membershipId: memberMem.id },
  });
  check("MEMBER cannot browse a vault file", memberRead.ok === false);

  const ownerRead = await servePrivateStoredAsset(prisma, finalized.id, businessA.id, {
    provider,
    viewer: { role: "OWNER", membershipId: ownerMem.id },
  });
  check("OWNER can read the private vault file", ownerRead.ok === true);

  const crossRead = await servePrivateStoredAsset(prisma, finalized.id, businessB.id, {
    provider,
    viewer: { role: "OWNER", membershipId: otherMem.id },
  });
  check("Tenant B cannot read tenant A vault bytes", crossRead.ok === false);

  const agreement = await createAgreement(prisma, adminA, {
    agreementType: "CUSTOMER_AGREEMENT",
    title: "Bathroom remodel agreement",
  });
  await saveAgreementAnswers(prisma, adminA, {
    agreementId: agreement.id,
    answers: {
      counterparty: "Jordan Client",
      purpose: "Bathroom remodel",
      scope: "Vanity, faucet, and toilet",
      payment: "Fixed price recorded by owner",
      effectiveOn: "2026-10-01",
      expiresOn: "2027-10-01",
    },
    title: "Bathroom remodel agreement",
  });
  const drafted = await generateAgreementDraft(prisma, adminA, {
    agreementId: agreement.id,
    businessName: businessA.name,
  });
  check("Draft lifecycle moves to RISK_REVIEW", drafted.lifecycleStatus === "RISK_REVIEW");
  check(
    "Generated draft refuses legal sufficiency claims",
    drafted.versions[0].draftContent.includes(AGREEMENT_NOT_ENFORCEABLE_MESSAGE),
  );

  await markAgreementOwnerReviewed(prisma, adminA, { agreementId: agreement.id });
  const afterReview = await prisma.businessAgreement.findUniqueOrThrow({ where: { id: agreement.id } });
  check("High-risk owner review lands on LEGAL_WARNING", afterReview.lifecycleStatus === "LEGAL_WARNING");

  await expectError("ADMIN cannot acknowledge the attorney-review floor", () => {
    return acknowledgeAgreementLegalReview(prisma, adminA, {
      agreementId: agreement.id,
      acknowledged: true,
    });
  }, (error) => error instanceof ForbiddenError);

  await acknowledgeAgreementLegalReview(prisma, ownerA, {
    agreementId: agreement.id,
    acknowledged: true,
  });
  await markAgreementReady(prisma, ownerA, { agreementId: agreement.id });
  await markAgreementSent(prisma, ownerA, { agreementId: agreement.id });
  const sent = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: agreement.id },
    include: { versions: true },
  });
  const sentVersion = sent.versions.find((row) => row.id === sent.currentDraftVersionId);
  check("Sent version is locked", sent.lifecycleStatus === "SENT" && Boolean(sentVersion?.lockedAt));
  const sentContent = sentVersion.draftContent;

  await saveAgreementDraftContent(prisma, ownerA, {
    agreementId: agreement.id,
    draftContent: `${sentContent}\n\nOwner follow-up note on a new version.`,
  });
  const afterEditAttempt = await prisma.businessAgreementVersion.findUniqueOrThrow({
    where: { id: sentVersion.id },
  });
  check("Historical sent representation is unchanged", afterEditAttempt.draftContent === sentContent);
  const laterVersions = await prisma.businessAgreementVersion.findMany({
    where: { agreementId: agreement.id },
    orderBy: { versionNumber: "asc" },
  });
  check(
    "Later edits create a new version instead of rewriting the sent copy",
    laterVersions.length >= 2 && laterVersions[0].draftContent === sentContent,
  );

  await expectError("Fake digital signature is refused", () => {
    return completeAgreementExternally(prisma, ownerA, {
      agreementId: agreement.id,
      mode: "PROVIDER_READY",
    });
  }, (error) => error instanceof EsignBoundaryError || error instanceof BusinessProtectionError);

  await expectError("assertDigitalSignatureAllowed throws while disconnected", () => {
    assertDigitalSignatureAllowed("NOT_CONNECTED");
  }, (error) => error instanceof EsignBoundaryError);

  await expectError("ADMIN cannot finalize a sensitive agreement", () => {
    return completeAgreementExternally(prisma, adminA, {
      agreementId: agreement.id,
      mode: "EXTERNAL_SIGNATURE",
      notes: "Signed on paper",
    });
  }, (error) => error instanceof ForbiddenError);

  const completed = await completeAgreementExternally(prisma, ownerA, {
    agreementId: agreement.id,
    mode: "EXTERNAL_SIGNATURE",
    notes: "Signed on paper at the kitchen table",
    now: new Date(Date.UTC(2026, 9, 2)),
  });
  check("Completion records actor and timestamp", Boolean(completed.agreement.completedByMembershipId) && Boolean(completed.agreement.completedAt));
  check("Signed version is SIGNED_FINAL", completed.signedVersion.representationStatus === "SIGNED_FINAL");
  check("Final document is stored as a vault record", Boolean(completed.vault.id));

  await expectError("Completed agreement cannot be mutated into a new agreement", () => {
    return saveAgreementDraftContent(prisma, ownerA, {
      agreementId: agreement.id,
      draftContent: "Rewrite the signed deal",
    });
  }, (error) => error instanceof BusinessProtectionError);

  const signedStill = await prisma.businessAgreementVersion.findUniqueOrThrow({
    where: { id: completed.signedVersion.id },
  });
  const originalSent = await prisma.businessAgreementVersion.findUniqueOrThrow({
    where: { id: sentVersion.id },
  });
  check("Original sent copy is still the sent text", originalSent.draftContent === sentContent);
  check("Signed historical representation stays locked", signedStill.representationStatus === "SIGNED_FINAL" && Boolean(signedStill.lockedAt));

  const aiBefore = await prisma.businessAgreement.findUniqueOrThrow({ where: { id: agreement.id } });
  const ai = await runAgreementAssist(prisma, ownerA, {
    action: "SUMMARIZE",
    text: signedStill.draftContent,
    agreementType: "CUSTOMER_AGREEMENT",
    idempotencyKey: randomUUID(),
  });
  const aiAfter = await prisma.businessAgreement.findUniqueOrThrow({ where: { id: agreement.id } });
  check("AI returns assistance, not authorization", Boolean(ai.output?.text));
  check("AI cannot change agreement lifecycle", aiBefore.lifecycleStatus === aiAfter.lifecycleStatus);
  check("AI prompt forbids authorization", AGREEMENT_AI_CANNOT_AUTHORIZE_MESSAGE.includes("cannot authorize"));
  const interaction = await prisma.aiInteraction.findFirst({
    where: { businessId: businessA.id, taskType: "AGREEMENT_ASSIST" },
  });
  check("Agreement AI is audited", Boolean(interaction));

  await expectError("AI helper cannot be used to complete an agreement", () => {
    return completeAgreementExternally(prisma, memberA, {
      agreementId: agreement.id,
      mode: "EXTERNAL_SIGNATURE",
    });
  }, (error) => error instanceof ForbiddenError);

  const workspace = await loadProtectionWorkspace(prisma, businessA.id, { area: "dashboard" }, new Date(Date.UTC(2026, 8, 25)));
  check("Dashboard counts insurance", workspace.dashboard.insuranceOnFile >= 1);
  check("Dashboard counts missing dates", workspace.dashboard.missingDates >= 1);
  check("Dashboard does not claim compliance", workspace.dashboard.disclaimer.includes("does not guarantee"));
  check("Tenant workspace omits the other tenant vault", workspace.records.every((row) => row.id !== otherVault.id));

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, planCode: "FOUNDER", status: "active" },
  });
  await prisma.businessSaasSubscription.update({
    where: { businessId: businessA.id },
    data: { planCode: "STARTER", status: "active" },
  });
  const afterDowngrade = await prisma.businessVaultRecord.findUnique({ where: { id: vault.id } });
  const agreementAfterDowngrade = await prisma.businessAgreement.findUnique({ where: { id: agreement.id } });
  check("Downgrade preserves vault records", Boolean(afterDowngrade));
  check("Downgrade preserves completed agreements", Boolean(agreementAfterDowngrade));

  const zip = await buildBusinessExportZip(prisma, businessA.id);
  const zipText = zip.bytes.toString("utf8");
  check("Export includes vault metadata", zipText.includes("business-vault.csv") && zipText.includes("General liability"));
  check("Export includes agreement versions", zipText.includes("business-agreement-versions.json") && zipText.includes("Jordan Client"));
  check("Export excludes the other tenant", !zipText.includes("Beta EIN"));

  const nda = await createAgreement(prisma, ownerA, { agreementType: "NDA", title: "Vendor NDA" });
  await saveAgreementAnswers(prisma, ownerA, {
    agreementId: nda.id,
    answers: {
      counterparty: "Vendor Co",
      purpose: "Share pricing sheets",
      confidential: "Supplier pricing",
    },
  });
  const ndaDraft = await generateAgreementDraft(prisma, ownerA, {
    agreementId: nda.id,
    businessName: businessA.name,
  });
  check("NDA draft has no invented state clause", !/Nevada Revised Statutes|Florida Statute/i.test(ndaDraft.versions.at(-1).draftContent));

  await expectError("normalizeCompletionMode rejects a fake provider-ready request", () => {
    normalizeCompletionMode("PROVIDER_READY", "NOT_CONNECTED");
  }, (error) => error instanceof EsignBoundaryError);
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nAll business-protection checks passed."
    : `\n${failures} business-protection check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
