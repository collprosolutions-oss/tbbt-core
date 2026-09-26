/**
 * Business Vault expiration and renewal intelligence proofs.
 *
 * Extends the canonical BusinessVaultRecord. Does not create a second
 * vault, task engine, or specialist.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-vault-renewal-intelligence.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const {
  EXPIRING_SOON_DAYS,
  VAULT_RENEWAL_STATE_LABELS,
  classifyExpiry,
  deriveVaultRenewalState,
  parseOptionalRenewalLeadDays,
  vaultRenewalStateFromExpiry,
} = await import("@/lib/business-protection");
const {
  authorizeVaultDocumentUpload,
  createVaultRecord,
  finalizeVaultDocumentUpload,
  persistExpiryState,
  updateVaultRecord,
} = await import("@/lib/business-protection-ops");
const { loadProtectionWorkspace } = await import("@/lib/business-protection-data");
const {
  getLastBusinessProtectionProjection,
  resetLastBusinessProtectionProjection,
  runBusinessProtectionSpecialist,
} = await import("@/lib/chief-of-staff");
const { MemoryStorageProvider } = await import("@/lib/business-storage/memory-provider");
const { ensureBusinessStorageAccount, readPublicStoredAsset } = await import(
  "@/lib/business-storage/service"
);
const { servePrivateStoredAsset } = await import("@/lib/business-storage/private-serve");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_vault_renewal_intelligence_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for vault renewal intelligence test database.");
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const middayNySept26 = new Date("2026-09-26T16:00:00.000Z");
const utcMidnightSept26 = new Date("2026-09-26T00:00:00.000Z");
const justBeforeLaSept26 = new Date("2026-09-26T06:59:59.000Z");
const laMidnightSept26 = new Date("2026-09-26T07:00:00.000Z");

try {
  console.log("\nSTATIC — Canonical foundation and renewal helper");
  const helperSrc = readRepo("src/lib/business-protection.ts");
  const opsSrc = readRepo("src/lib/business-protection-ops.ts");
  const dataSrc = readRepo("src/lib/business-protection-data.ts");
  const specialistSrc = readRepo("src/lib/chief-of-staff/business-protection-specialist.ts");
  const workspaceUiSrc = readRepo("src/components/business-protection/workspace.tsx");
  const schemaSrc = readRepo("prisma/schema.prisma");
  const migrationSrc = readRepo("prisma/migrations/20260926223000_business_vault_renewal_lead_days/migration.sql");
  const workspaceLoaderSrc = readRepo("src/lib/workspace.ts");

  check("Canonical persisted record remains BusinessVaultRecord", schemaSrc.includes("model BusinessVaultRecord"));
  check("No second vault table was added", !/model\s+BusinessVault(?!Record)/.test(schemaSrc));
  check("Expiration remains owner-recorded expiresOn", schemaSrc.includes("expiresOn") && schemaSrc.includes("renewalLeadDays"));
  check("Migration is additive IF NOT EXISTS", migrationSrc.includes("ADD COLUMN IF NOT EXISTS") && !/DROP |ALTER COLUMN .* DROP/i.test(migrationSrc));
  check("No request-time DDL for renewal lead days", !opsSrc.includes("ADD COLUMN") && !dataSrc.includes("ADD COLUMN") && !specialistSrc.includes("$executeRaw"));
  check("Workspace loader still does not run protection DDL", !workspaceLoaderSrc.includes("BusinessVaultRecord"));
  check("Helper derives the four operational states", helperSrc.includes("deriveVaultRenewalState") && helperSrc.includes("NO_EXPIRATION_RECORDED"));
  check(
    "Helper never infers a date from category",
    helperSrc.includes("export function deriveVaultRenewalState(input: {") &&
      !/deriveVaultRenewalState\(input: \{[^}]*category/.test(helperSrc),
  );
  check("Workspace groups expired records instead of hiding them", workspaceUiSrc.includes("renewalGroups") && workspaceUiSrc.includes("EXPIRED"));
  check("Specialist candidate SQL is bounded and business-scoped", specialistSrc.includes("LIMIT ${input.take}") && specialistSrc.includes('"businessId" = ${input.businessId}'));
  check("Specialist discovers custom lead days in SQL candidates", specialistSrc.includes('COALESCE("renewalLeadDays"'));
  check("Specialist classification still uses the canonical helper", specialistSrc.includes("classifyExpiry("));
  check("Specialist does not persist a redundant renewal status", !specialistSrc.includes("persistedExpiryState:"));
  check("persistExpiryState re-resolves the owned vault row", opsSrc.includes("const existing = await requireOwnedVaultRecord(db, access, record.id)"));
  check("persistExpiryState writes with explicit business scope", opsSrc.includes("where: { id: existing.id, ...access.scope }"));
  check("Specialist stays read/explain", !specialistSrc.includes("createVaultRecord") && !specialistSrc.includes("updateVaultRecord") && !specialistSrc.includes("$executeRaw"));
  check("Specialist does not persist AI dates", !specialistSrc.includes("expiresOn:") || specialistSrc.includes("expiresOn: row.expiresOn"));
  check("No CollPro-specific copy in the vault workspace", !/CollPro|handyman-only/i.test(workspaceUiSrc));

  check(
    "No expiration recorded is truthful",
    deriveVaultRenewalState({ expiresOn: null, now: middayNySept26, timeZone: NY }) === "NO_EXPIRATION_RECORDED" &&
      VAULT_RENEWAL_STATE_LABELS.NO_EXPIRATION_RECORDED === "No expiration recorded",
  );
  check(
    "Future date outside the default lead window is Current",
    deriveVaultRenewalState({ expiresOn: "2026-12-01", now: middayNySept26, timeZone: NY }) === "CURRENT",
  );
  check(
    "Date inside the default lead window is Renewal approaching",
    deriveVaultRenewalState({ expiresOn: "2026-10-10", now: middayNySept26, timeZone: NY }) === "RENEWAL_APPROACHING",
  );
  check(
    "Past date is Expired",
    deriveVaultRenewalState({ expiresOn: "2026-09-01", now: middayNySept26, timeZone: NY }) === "EXPIRED",
  );
  check(
    "Exact lead-window boundary is approaching (today + 30)",
    deriveVaultRenewalState({ expiresOn: "2026-10-26", now: middayNySept26, timeZone: NY }) === "RENEWAL_APPROACHING",
  );
  check(
    "Day after the lead window is Current",
    deriveVaultRenewalState({ expiresOn: "2026-10-27", now: middayNySept26, timeZone: NY }) === "CURRENT",
  );
  check(
    "Expiration on the business calendar day is approaching, not expired",
    deriveVaultRenewalState({ expiresOn: "2026-09-26", now: middayNySept26, timeZone: NY }) === "RENEWAL_APPROACHING",
  );
  check(
    "Per-document lead time is honored",
    deriveVaultRenewalState({
      expiresOn: "2026-10-03",
      renewalLeadDays: 7,
      now: middayNySept26,
      timeZone: NY,
    }) === "RENEWAL_APPROACHING" &&
      deriveVaultRenewalState({
        expiresOn: "2026-10-04",
        renewalLeadDays: 7,
        now: middayNySept26,
        timeZone: NY,
      }) === "CURRENT",
  );
  check("Blank lead time uses the canonical 30-day default", parseOptionalRenewalLeadDays("") === null && EXPIRING_SOON_DAYS === 30);
  check(
    "UTC midnight does not expire a New York record that is still the prior calendar day",
    deriveVaultRenewalState({ expiresOn: "2026-09-25", now: utcMidnightSept26, timeZone: NY }) === "RENEWAL_APPROACHING" &&
      deriveVaultRenewalState({ expiresOn: "2026-09-25", now: utcMidnightSept26, timeZone: "UTC" }) === "EXPIRED",
  );
  check(
    "Los Angeles calendar day is used, not the browser or UTC date",
    deriveVaultRenewalState({ expiresOn: "2026-09-25", now: justBeforeLaSept26, timeZone: LA }) === "RENEWAL_APPROACHING" &&
      deriveVaultRenewalState({ expiresOn: "2026-09-25", now: laMidnightSept26, timeZone: LA }) === "EXPIRED",
  );
  check(
    "Existing expiry classifier stays compatible when timezone is omitted",
    classifyExpiry({ category: "INSURANCE", expiresOn: "2026-10-10", now: new Date(Date.UTC(2026, 8, 25)) }) ===
      "EXPIRING_SOON" &&
      vaultRenewalStateFromExpiry("MISSING_DATE") === "NO_EXPIRATION_RECORDED",
  );

  console.log("\nDB — Owner write, capability, isolation, specialist, files");
  const ownerUser = await prisma.user.create({
    data: { name: "Pat Owner", email: `owner-vr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-vr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel Member", email: `member-vr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const otherUser = await prisma.user.create({
    data: { name: "Oli Other", email: `other-vr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Trades",
      slug: `alpha-vr-${randomUUID()}`,
      tradeCode: "CLEANING",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Trades",
      slug: `beta-vr-${randomUUID()}`,
      tradeCode: "HVAC",
      timezone: LA,
    },
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
      title: "Secret workers comp",
      category: "INSURANCE",
      expiresOn: "2026-12-01",
    });
  }, (error) => error instanceof ForbiddenError);

  const none = await createVaultRecord(prisma, ownerA, {
    title: "Contractor license",
    category: "LICENSE",
    now: middayNySept26,
  });
  check("Owner write stores a vault record without inventing an expiration", none.expiresOn === null && none.effectiveOn === null);
  check("Missing expiration persists as no-expiration state", none.persistedExpiryState === "MISSING_DATE");

  const current = await createVaultRecord(prisma, adminA, {
    title: "Vehicle insurance",
    category: "INSURANCE",
    expiresOn: "2026-12-01",
    effectiveOn: "2026-01-01",
    now: middayNySept26,
  });
  check("ADMIN can record expiration and preserve the effective date", current.expiresOn === "2026-12-01" && current.effectiveOn === "2026-01-01");
  check("Future date outside the lead window persists as CURRENT", current.persistedExpiryState === "CURRENT");

  const approaching = await createVaultRecord(prisma, ownerA, {
    title: "General Liability certificate",
    category: "INSURANCE",
    expiresOn: "2026-10-15",
    renewalLeadDays: 30,
    now: middayNySept26,
  });
  check("Owner can record a lead time", approaching.renewalLeadDays === 30);
  check("Date inside the lead window persists as EXPIRING_SOON", approaching.persistedExpiryState === "EXPIRING_SOON");

  const expired = await createVaultRecord(prisma, ownerA, {
    title: "Business permit",
    category: "LICENSE",
    expiresOn: "2026-08-01",
    now: middayNySept26,
  });
  check("Past date persists as EXPIRED", expired.persistedExpiryState === "EXPIRED");

  const customLead = await createVaultRecord(prisma, ownerA, {
    title: "Vendor certificate",
    category: "CERTIFICATION",
    expiresOn: "2026-10-20",
    renewalLeadDays: 14,
    now: middayNySept26,
  });
  check(
    "Custom lead time of 14 days keeps Oct 20 current on Sept 26",
    customLead.persistedExpiryState === "CURRENT",
  );

  const updatedLead = await updateVaultRecord(prisma, ownerA, {
    recordId: customLead.id,
    renewalLeadDays: 30,
    now: middayNySept26,
  });
  check("Widening the recorded lead time moves the same date into approaching", updatedLead.persistedExpiryState === "EXPIRING_SOON");

  const cleared = await updateVaultRecord(prisma, ownerA, {
    recordId: approaching.id,
    expiresOn: "",
    now: middayNySept26,
  });
  check("Clearing expiration restores no-expiration state", cleared.expiresOn === null && cleared.persistedExpiryState === "MISSING_DATE");
  check("Clearing expiration does not invent a date", cleared.expiresOn === null && cleared.effectiveOn === null);

  const restored = await updateVaultRecord(prisma, adminA, {
    recordId: approaching.id,
    expiresOn: "2026-10-15",
    now: middayNySept26,
  });
  check("ADMIN can restore a recorded expiration", restored.expiresOn === "2026-10-15" && restored.persistedExpiryState === "EXPIRING_SOON");

  await expectError("MEMBER cannot update a vault expiration", () => {
    return updateVaultRecord(prisma, memberA, {
      recordId: approaching.id,
      expiresOn: "2027-01-01",
    });
  }, (error) => error instanceof ForbiddenError);

  const afterMember = await prisma.businessVaultRecord.findFirst({
    where: { id: approaching.id, businessId: businessA.id },
  });
  check("Unauthorized update did not change the recorded date", afterMember?.expiresOn === "2026-10-15");

  await expectError("Foreign tenant cannot update this vault record", () => {
    return updateVaultRecord(prisma, ownerB, {
      recordId: approaching.id,
      expiresOn: "2028-01-01",
    });
  }, (error) => error instanceof Error);

  const afterForeign = await prisma.businessVaultRecord.findFirst({
    where: { id: approaching.id, businessId: businessA.id },
  });
  check("Foreign write failed closed", afterForeign?.expiresOn === "2026-10-15");

  const leaked = await prisma.businessVaultRecord.findFirst({
    where: { id: approaching.id, businessId: businessB.id },
  });
  check("Foreign tenant query cannot see this vault row", leaked === null);

  const pacificBoundary = await createVaultRecord(prisma, ownerB, {
    title: "Pacific registration",
    category: "LICENSE",
    expiresOn: "2026-09-25",
    now: utcMidnightSept26,
  });
  check(
    "Pacific tenant still treats Sept 25 as approaching at UTC midnight Sept 26",
    pacificBoundary.persistedExpiryState === "EXPIRING_SOON",
  );
  const afterLaMidnight = await updateVaultRecord(prisma, ownerB, {
    recordId: pacificBoundary.id,
    now: laMidnightSept26,
  });
  check("Same Pacific record becomes expired after the business timezone date rolls", afterLaMidnight.persistedExpiryState === "EXPIRED");

  const workspace = await loadProtectionWorkspace(
    prisma,
    businessA.id,
    { area: "vault" },
    middayNySept26,
  );
  const groupBy = Object.fromEntries(workspace.renewalGroups.map((group) => [group.state, group]));
  check("Workspace uses the business timezone", workspace.dashboard.timeZone === NY);
  check("Expired group includes the expired permit", groupBy.EXPIRED.records.some((row) => row.id === expired.id));
  check("Renewal approaching group includes the GL certificate", groupBy.RENEWAL_APPROACHING.records.some((row) => row.id === approaching.id));
  check("Current group includes vehicle insurance", groupBy.CURRENT.records.some((row) => row.id === current.id));
  check("No expiration recorded group includes the contractor license", groupBy.NO_EXPIRATION_RECORDED.records.some((row) => row.id === none.id));
  check("Expired documents remain visible", workspace.records.some((row) => row.id === expired.id));
  check("Selected canonical record can be opened by id", workspace.records.some((row) => row.id === approaching.id));
  check("Dashboard no-expiration count is truthful", workspace.dashboard.noExpirationRecorded >= 1);
  check("Workspace does not include the foreign tenant record", workspace.records.every((row) => row.id !== pacificBoundary.id));

  const provider = new MemoryStorageProvider();
  const deps = { db: prisma, provider, bucketName: "tbbt-vault-renewal-test", defaultLimitBytes: 5_000_000 };
  await ensureBusinessStorageAccount(prisma, businessA.id, {
    bucketName: "tbbt-vault-renewal-test",
    defaultLimitBytes: 5_000_000,
  });
  const pdf = Buffer.from("%PDF-1.4 vault-renewal-private");
  const authorized = await authorizeVaultDocumentUpload(deps, ownerA, {
    originalFilename: "workers-comp.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: pdf.byteLength,
  });
  await provider.putObject({
    bucket: authorized.account.bucketName,
    key: authorized.asset.storageKey,
    body: pdf,
    contentType: "application/pdf",
  });
  const finalized = await finalizeVaultDocumentUpload(deps, ownerA, authorized.asset.id);
  const filed = await createVaultRecord(prisma, ownerA, {
    title: "Workers compensation certificate",
    category: "INSURANCE",
    expiresOn: "2026-10-12",
    storedAssetId: finalized.id,
    now: middayNySept26,
  });
  check("Vault file stays PRIVATE after expiration is recorded", finalized.visibility === "PRIVATE" && filed.storedAssetId === finalized.id);
  const publicLeak = await readPublicStoredAsset(prisma, finalized.id);
  check("Expiration metadata does not publish the private file", publicLeak === null);
  const ownerRead = await servePrivateStoredAsset(prisma, finalized.id, businessA.id, {
    provider,
    viewer: { role: "OWNER", membershipId: ownerMem.id },
  });
  check("OWNER can still read the private vault file", ownerRead.ok === true);
  const memberRead = await servePrivateStoredAsset(prisma, finalized.id, businessA.id, {
    provider,
    viewer: { role: "MEMBER", membershipId: memberMem.id },
  });
  check("MEMBER still cannot browse the private vault file", memberRead.ok === false);
  const crossRead = await servePrivateStoredAsset(prisma, finalized.id, businessB.id, {
    provider,
    viewer: { role: "OWNER", membershipId: otherMem.id },
  });
  check("Foreign tenant still cannot read vault bytes", crossRead.ok === false);
  const afterDateEdit = await updateVaultRecord(prisma, ownerA, {
    recordId: filed.id,
    expiresOn: "2026-11-01",
    now: middayNySept26,
  });
  const fileAfterEdit = await prisma.storedAsset.findUnique({ where: { id: finalized.id } });
  check("Editing expiration does not change file privacy", afterDateEdit.storedAssetId === finalized.id && fileAfterEdit?.visibility === "PRIVATE");

  resetLastBusinessProtectionProjection();
  const specialist = await runBusinessProtectionSpecialist({
    db: prisma,
    access: ownerA,
    catalog: emptyCatalog(),
    question: "What business protection documents are expired or approaching renewal?",
    now: middayNySept26,
  });
  const projection = getLastBusinessProtectionProjection();
  const spoken = JSON.stringify(specialist);
  const glRow = projection?.vaultRecords.find((row) => row.id === approaching.id);
  check("Business Protection specialist READ works for the owner", specialist.status === "OK" && Boolean(projection));
  check("Specialist uses the recorded GL expiration date", glRow?.expiresOn === "2026-10-15" && glRow.expiryState === "EXPIRING_SOON");
  check(
    "Specialist language is factual about the recorded date",
    /General Liability certificate has an expiration date of 2026-10-15/.test(spoken),
  );
  check(
    "Specialist does not claim illegal noncompliance",
    !/illegally uninsured|legally noncompliant|not legally licensed/i.test(spoken),
  );
  check("Specialist does not persist a generated date", approaching.expiresOn === "2026-10-15");
  const afterSpecialist = await prisma.businessVaultRecord.findUnique({ where: { id: none.id } });
  check("Specialist did not invent an expiration on a blank record", afterSpecialist?.expiresOn === null);

  resetLastBusinessProtectionProjection();
  const memberSpecialist = await runBusinessProtectionSpecialist({
    db: prisma,
    access: memberA,
    catalog: emptyCatalog(),
    question: "What is expiring?",
    now: middayNySept26,
  });
  check("MEMBER specialist read is blocked", memberSpecialist.status === "SKIPPED");
  check("MEMBER specialist does not load confidential vault rows", getLastBusinessProtectionProjection() === null);

  resetLastBusinessProtectionProjection();
  const foreignSpecialist = await runBusinessProtectionSpecialist({
    db: prisma,
    access: ownerB,
    catalog: emptyCatalog(),
    question: "Explain this vault record",
    entityHints: { vaultRecordId: approaching.id },
    now: middayNySept26,
  });
  const foreignProjection = getLastBusinessProtectionProjection();
  check("Foreign specialist target fails closed", foreignSpecialist.status === "OK" && (foreignProjection?.vaultRecords.length ?? 1) === 0);
  check("Foreign specialist does not name the other tenant certificate", !JSON.stringify(foreignSpecialist).includes("General Liability certificate"));

  console.log("\nREGRESSION — Specialist honors recorded renewalLeadDays");
  const leadUser = await prisma.user.create({
    data: { name: "Lea Lead", email: `lead-vr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const leadBusiness = await prisma.business.create({
    data: {
      name: "Lead Window Trades",
      slug: `lead-vr-${randomUUID()}`,
      tradeCode: "PLUMBING",
      timezone: NY,
    },
  });
  const leadMem = await prisma.membership.create({
    data: { userId: leadUser.id, businessId: leadBusiness.id, role: "OWNER" },
  });
  const leadAccess = makeAccess(leadBusiness.id, "OWNER", leadMem.id, {
    userId: leadUser.id,
    businessName: leadBusiness.name,
  });
  const far90 = await createVaultRecord(prisma, leadAccess, {
    title: "Ninety-day warranty",
    category: "WARRANTY",
    expiresOn: "2026-11-25",
    renewalLeadDays: 90,
    now: middayNySept26,
  });
  const far30 = await createVaultRecord(prisma, leadAccess, {
    title: "Thirty-day warranty",
    category: "WARRANTY",
    expiresOn: "2026-11-25",
    renewalLeadDays: 30,
    now: middayNySept26,
  });
  const leadExpired = await createVaultRecord(prisma, leadAccess, {
    title: "Expired plumbing license",
    category: "LICENSE",
    expiresOn: "2026-07-01",
    now: middayNySept26,
  });
  const leadBlank = await createVaultRecord(prisma, leadAccess, {
    title: "Registration without a date",
    category: "LICENSE",
    now: middayNySept26,
  });
  check("Helper: 60 days away + lead 90 is approaching", deriveVaultRenewalState({
    expiresOn: "2026-11-25",
    renewalLeadDays: 90,
    now: middayNySept26,
    timeZone: NY,
  }) === "RENEWAL_APPROACHING");
  check("Helper: same expiration + lead 30 is current", deriveVaultRenewalState({
    expiresOn: "2026-11-25",
    renewalLeadDays: 30,
    now: middayNySept26,
    timeZone: NY,
  }) === "CURRENT");

  resetLastBusinessProtectionProjection();
  const leadSpecialist = await runBusinessProtectionSpecialist({
    db: prisma,
    access: leadAccess,
    catalog: emptyCatalog(),
    question: "What business protection documents are approaching renewal?",
    now: middayNySept26,
  });
  const leadProjection = getLastBusinessProtectionProjection();
  const far90Row = leadProjection?.vaultRecords.find((row) => row.id === far90.id);
  const far30Row = leadProjection?.vaultRecords.find((row) => row.id === far30.id);
  const expiredRow = leadProjection?.vaultRecords.find((row) => row.id === leadExpired.id);
  const blankRow = leadProjection?.vaultRecords.find((row) => row.id === leadBlank.id);
  check("90-day lead record is surfaced as EXPIRING_SOON", leadSpecialist.status === "OK" && far90Row?.expiryState === "EXPIRING_SOON" && far90Row.expiresOn === "2026-11-25");
  check("30-day lead record with the same expiration is CURRENT", far30Row?.expiryState === "CURRENT");
  check("Custom 90-day lead contributes to expiringSoon totals", leadProjection?.totals.expiringSoon === 1);
  check("Matching 30-day lead contributes to current totals", leadProjection?.totals.current === 1);
  check("Expired remains expired", expiredRow?.expiryState === "EXPIRED" && leadProjection?.totals.expired === 1);
  check("No expiration remains no expiration recorded", blankRow?.expiryState === "MISSING_DATE" && leadProjection?.totals.missingDate === 1);

  resetLastBusinessProtectionProjection();
  const beforeLeadWindow = await runBusinessProtectionSpecialist({
    db: prisma,
    access: leadAccess,
    catalog: emptyCatalog(),
    question: "What is approaching renewal?",
    now: new Date("2026-08-26T16:00:00.000Z"),
  });
  const beforeProjection = getLastBusinessProtectionProjection();
  const far90Before = beforeProjection?.vaultRecords.find((row) => row.id === far90.id);
  const far90Unchanged = await prisma.businessVaultRecord.findUnique({ where: { id: far90.id } });
  check("Before the 90-day lead boundary the same row is CURRENT", beforeLeadWindow.status === "OK" && far90Before?.expiryState === "CURRENT");
  check("Crossing the custom lead boundary did not rewrite the vault row", far90Unchanged?.expiresOn === "2026-11-25" && far90Unchanged.renewalLeadDays === 90);
  check("Totals follow the moved now, not a persisted derived status", beforeProjection?.totals.current === 2 && beforeProjection?.totals.expiringSoon === 0);

  resetLastBusinessProtectionProjection();
  const afterExpiry = await runBusinessProtectionSpecialist({
    db: prisma,
    access: leadAccess,
    catalog: emptyCatalog(),
    question: "What is expired?",
    now: new Date("2026-11-26T16:00:00.000Z"),
  });
  const afterProjection = getLastBusinessProtectionProjection();
  check(
    "After the recorded date the 90-day lead record is expired without a row rewrite",
    afterExpiry.status === "OK" &&
      afterProjection?.vaultRecords.find((row) => row.id === far90.id)?.expiryState === "EXPIRED",
  );

  resetLastBusinessProtectionProjection();
  const utcMidnightCustom = await runBusinessProtectionSpecialist({
    db: prisma,
    access: leadAccess,
    catalog: emptyCatalog(),
    question: "What is approaching?",
    now: utcMidnightSept26,
  });
  const utcProjection = getLastBusinessProtectionProjection();
  check(
    "Business.timezone still decides the specialist calendar day",
    utcMidnightCustom.status === "OK" &&
      utcProjection?.vaultRecords.find((row) => row.id === far90.id)?.expiryState === "EXPIRING_SOON",
  );

  for (let i = 0; i < 12; i += 1) {
    await createVaultRecord(prisma, leadAccess, {
      title: `Overflow current warranty ${i + 1}`,
      category: "WARRANTY",
      expiresOn: "2027-06-01",
      now: middayNySept26,
    });
  }
  resetLastBusinessProtectionProjection();
  const capped = await runBusinessProtectionSpecialist({
    db: prisma,
    access: leadAccess,
    catalog: emptyCatalog(),
    question: "What is in my Business Vault?",
    now: middayNySept26,
  });
  const cappedProjection = getLastBusinessProtectionProjection();
  check("Bounded projection still caps vault rows", capped.status === "OK" && (cappedProjection?.vaultRecords.length ?? 99) <= 10);
  check("Bounded overflow does not dump every overflow title", !(cappedProjection?.vaultRecords.filter((row) => /Overflow current warranty/.test(row.title)).length >= 12));

  console.log("\nREGRESSION — persistExpiryState uses canonical owned DB truth");
  const persistTarget = await createVaultRecord(prisma, ownerA, {
    title: "Owned persist target",
    category: "INSURANCE",
    expiresOn: "2026-12-01",
    renewalLeadDays: 30,
    now: middayNySept26,
  });
  const foreignPersist = await createVaultRecord(prisma, ownerB, {
    title: "Foreign persist target",
    category: "INSURANCE",
    expiresOn: "2026-12-01",
    now: middayNySept26,
  });
  check("Same-tenant persist starts from CURRENT", persistTarget.persistedExpiryState === "CURRENT");

  await expectError("Business A cannot persist expiry state for Business B", () => {
    return persistExpiryState(prisma, ownerA, {
      id: foreignPersist.id,
      category: "INSURANCE",
      expiresOn: "2020-01-01",
      persistedExpiryState: "CURRENT",
      renewalLeadDays: 365,
    }, middayNySept26);
  }, (error) => error instanceof Error);

  const foreignAfter = await prisma.businessVaultRecord.findUnique({ where: { id: foreignPersist.id } });
  check("Foreign record remains unchanged after the rejected persist", foreignAfter?.persistedExpiryState === foreignPersist.persistedExpiryState && foreignAfter?.expiresOn === "2026-12-01");

  const fabricated = await persistExpiryState(prisma, ownerA, {
    id: persistTarget.id,
    category: "LICENSE",
    expiresOn: "2020-01-01",
    persistedExpiryState: "EXPIRED",
    renewalLeadDays: 365,
  }, middayNySept26);
  const afterFabrication = await prisma.businessVaultRecord.findUnique({ where: { id: persistTarget.id } });
  check("Fabricated caller expiresOn cannot alter classification", fabricated === "CURRENT" && afterFabrication?.expiresOn === "2026-12-01");
  check("Fabricated caller renewalLeadDays cannot alter classification", afterFabrication?.renewalLeadDays === 30 && afterFabrication.persistedExpiryState === "CURRENT");

  const moved = await persistExpiryState(prisma, adminA, persistTarget, new Date("2027-01-01T16:00:00.000Z"));
  const afterMove = await prisma.businessVaultRecord.findUnique({ where: { id: persistTarget.id } });
  check("Same-tenant canonical persist updates from recorded dates and now", moved === "EXPIRED" && afterMove?.persistedExpiryState === "EXPIRED" && afterMove.expiresOn === "2026-12-01");

  await expectError("MEMBER cannot persist expiry state", () => {
    return persistExpiryState(prisma, memberA, persistTarget, middayNySept26);
  }, (error) => error instanceof ForbiddenError);
  const afterMemberPersist = await prisma.businessVaultRecord.findUnique({ where: { id: persistTarget.id } });
  check("MEMBER persist left the owned record unchanged", afterMemberPersist?.persistedExpiryState === "EXPIRED");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll business vault renewal intelligence checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
