/**
 * OWNER same-business customer merge proofs.
 *
 * Dedicated localhost database only. Refuses any other DATABASE_URL host
 * before Prisma connect or db push. Drops tbbt_customer_merge_test in
 * finally after creation, including a failed push.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-merge.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for customer merge checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, requireBusinessRole } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  ABSORBED_CONTACT_AUDIT_MESSAGE,
  CUSTOMER_MERGE_ROUTE,
  CONFIRM_REQUIRED_MESSAGE,
  CROSS_BUSINESS_MERGE_MESSAGE,
  CUSTOMERS_NOT_AVAILABLE_MESSAGE,
  CustomerMergeError,
  DUPLICATE_REVIEW_GROUP_TAKE,
  DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP,
  findPossibleDuplicatePairs,
  MERGE_ALREADY_ABSORBED_MESSAGE,
  MERGE_LEFTOVER_REFERENCES_MESSAGE,
  MERGE_TRY_AGAIN_MESSAGE,
  mergeSmsConsentStates,
  NAME_IS_NOT_IDENTITY_MESSAGE,
  NO_SHARED_IDENTIFIER_MESSAGE,
  OWNER_ONLY_MERGE_MESSAGE,
  pairHref,
  pairMatchReasons,
} = await import("@/lib/customer-merge");
const {
  customerFkFieldsFromDmmf,
  customerListRelationsFromDmmf,
  customerMergeTestHooks,
  CUSTOMER_REASSIGN_SPECS,
  handledCustomerReassignKeys,
  loadDuplicateReview,
  loadOwnedMergePair,
  loadPossibleDuplicatesForCustomer,
  mergeConfirmedCustomers,
  REASSIGNED_CUSTOMER_RELATION_FIELDS,
  requiredCustomerReassignTargets,
} = await import("@/lib/customer-merge-ops");
const { authorizeManagedUpload } = await import("@/lib/business-storage/service");
const { StorageAccessError } = await import("@/lib/business-storage/types");
const { applyInboundConsentEvent, claimedAtFromCuid, inboundConsentTestHooks } = await import(
  "@/lib/customer-messaging/inbound"
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const featureFiles = [
  "src/lib/customer-merge.ts",
  "src/lib/customer-merge-ops.ts",
  "src/app/actions/customer-merge.ts",
  "src/app/(app)/customers/duplicates/page.tsx",
  "src/app/(app)/customers/duplicates/[leftId]/[rightId]/page.tsx",
  "src/components/customers/merge-customers-form.tsx",
];
const featureSource = featureFiles.map(readSrc).join("\n");
const opsSrc = readSrc("src/lib/customer-merge-ops.ts");
const inboundSrc = readSrc("src/lib/customer-messaging/inbound.ts");
const testSrc = readSrc("scripts/check-customer-merge.mjs");
const require = createRequire(import.meta.url);
const { Prisma, PrismaClient } = require("@prisma/client");

const ALLOWED_TEST_HOSTS = new Set(["localhost", "127.0.0.1"]);
const testDbName = "tbbt_customer_merge_test";

function assertLocalDatabaseUrl(urlString, label) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    console.error(`${label} is not a valid URL.`);
    process.exit(1);
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (!ALLOWED_TEST_HOSTS.has(host)) {
    console.error(
      `Refusing customer-merge test DB: ${label} host must be localhost or 127.0.0.1, got ${host || "(empty)"}.`,
    );
    process.exit(1);
  }
  return parsed;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
const parsed = assertLocalDatabaseUrl(baseUrl, "DATABASE_URL");
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
assertLocalDatabaseUrl(testUrl, "customer-merge test DATABASE_URL");
process.env.DATABASE_URL = testUrl;

const MUTATION_KIND = process.argv.includes("--mutation")
  ? process.argv[process.argv.indexOf("--mutation") + 1]
  : null;

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

const BARRIER_WAIT_MS = 10_000;
const LOCK_POLL_MS = 10_000;

function createCount2Barrier() {
  let count = 0;
  const waiters = [];
  let firstArrived;
  const first = new Promise((resolve) => {
    firstArrived = resolve;
  });
  return {
    arrive: async () => {
      count += 1;
      if (count === 1) firstArrived();
      if (count >= 2) {
        for (const release of waiters) release();
        waiters.length = 0;
        return;
      }
      await withTimeout(
        new Promise((resolve) => {
          waiters.push(resolve);
        }),
        BARRIER_WAIT_MS,
        "barrier wait",
      );
    },
    firstArrived: first,
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function isUnavailableOrTryAgain(error) {
  return (
    error instanceof CustomerMergeError &&
    (error.message === CUSTOMERS_NOT_AVAILABLE_MESSAGE || error.message === MERGE_TRY_AGAIN_MESSAGE)
  );
}

async function waitForTestDbLock(admin, label) {
  const started = Date.now();
  while (Date.now() - started < LOCK_POLL_MS) {
    const rows = await admin.$queryRaw`
      SELECT pid, wait_event_type, wait_event, state, left(query, 120) AS query
      FROM pg_stat_activity
      WHERE datname = ${testDbName}
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const snapshot = await admin.$queryRaw`
    SELECT pid, wait_event_type, wait_event, state, left(query, 160) AS query
    FROM pg_stat_activity
    WHERE datname = ${testDbName}
      AND pid <> pg_backend_pid()
  `;
  throw new Error(
    `${label}: timed out waiting for wait_event_type=Lock on ${testDbName}. activity=${JSON.stringify(snapshot)}`,
  );
}

function memoryStorageProvider() {
  return {
    id: "MEMORY",
    putObject: async () => ({ key: "memory", sizeBytes: 0 }),
    deleteObject: async () => {},
    getObjectMetadata: async () => null,
    getObject: async () => null,
    objectExists: async () => false,
    createUploadUrl: async () => ({
      url: "https://example.test/upload",
      method: "PUT",
      headers: {},
      expiresInSeconds: 60,
    }),
    createDownloadUrl: async () => ({ url: "https://example.test/download", expiresInSeconds: 60 }),
  };
}

async function terminateAndDrop(admin, name) {
  try {
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      name,
    );
  } catch {
    try {
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
    } catch {
      /* ignore */
    }
  }
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

let dbCreated = false;
const extraClients = [];
let prisma;

function createTestClient() {
  const client = new PrismaClient({ datasourceUrl: testUrl });
  extraClients.push(client);
  return client;
}

async function disconnectClient(client) {
  const index = extraClients.indexOf(client);
  if (index >= 0) extraClients.splice(index, 1);
  await client.$disconnect();
}

async function releaseAfterLock(admin, barrier, label) {
  try {
    await waitForTestDbLock(admin, label);
  } finally {
    await barrier.arrive();
  }
}

try {
  if (!MUTATION_KIND) {
  console.log("\nSTATIC — OWNER review, no name identity, no outreach");
  check("Dedicated route is /customers/duplicates", CUSTOMER_MERGE_ROUTE === "/customers/duplicates");
  check("Owner-only copy is present", OWNER_ONLY_MERGE_MESSAGE.includes("business owner"));
  check("Name-is-not-identity copy is present", NAME_IS_NOT_IDENTITY_MESSAGE.includes("Matching names do not prove"));
  check("Absorbed contact lives only in the audit snapshot", ABSORBED_CONTACT_AUDIT_MESSAGE.includes("audit snapshot"));
  check(
    "Global nav does not add a merge destination",
    APP_NAV.every((item) => item.href !== CUSTOMER_MERGE_ROUTE) &&
      !readSrc("src/lib/nav.ts").includes("duplicates"),
  );
  check(
    "Ops require OWNER and lock both customers in one ReadCommitted transaction",
    opsSrc.includes('requireBusinessRole(access, "OWNER")') &&
      opsSrc.includes("FOR UPDATE") &&
      opsSrc.includes("Prisma.TransactionIsolationLevel.ReadCommitted") &&
      !opsSrc.includes("Prisma.TransactionIsolationLevel.Serializable"),
  );
  check(
    "Merge remaps jobs, estimates, invoices, properties, and communications",
    CUSTOMER_REASSIGN_SPECS.some((spec) => spec.kind === "updateMany" && spec.delegate === "job") &&
      CUSTOMER_REASSIGN_SPECS.some((spec) => spec.kind === "updateMany" && spec.delegate === "estimate") &&
      CUSTOMER_REASSIGN_SPECS.some((spec) => spec.kind === "updateMany" && spec.delegate === "invoice") &&
      CUSTOMER_REASSIGN_SPECS.some((spec) => spec.kind === "updateMany" && spec.delegate === "property") &&
      CUSTOMER_REASSIGN_SPECS.some((spec) => spec.kind === "updateMany" && spec.delegate === "customerCommunication"),
  );
  check(
    "Merge remaps InvoiceCredit.customerId onto the survivor",
    CUSTOMER_REASSIGN_SPECS.some(
      (spec) =>
        spec.kind === "updateMany" &&
        spec.model === "InvoiceCredit" &&
        spec.delegate === "invoiceCredit" &&
        spec.field === "customerId" &&
        spec.relation === "invoiceCredits",
    ),
  );
  check(
    "Merge remaps JobCallback, InvoiceCollectionWorkItem, and both CustomerCsvImportRow customer ids",
    CUSTOMER_REASSIGN_SPECS.some(
      (spec) => spec.kind === "updateMany" && spec.model === "JobCallback" && spec.field === "customerId",
    ) &&
      CUSTOMER_REASSIGN_SPECS.some(
        (spec) =>
          spec.kind === "updateMany" && spec.model === "InvoiceCollectionWorkItem" && spec.field === "customerId",
      ) &&
      CUSTOMER_REASSIGN_SPECS.some(
        (spec) =>
          spec.kind === "updateMany" && spec.model === "CustomerCsvImportRow" && spec.field === "createdCustomerId",
      ) &&
      CUSTOMER_REASSIGN_SPECS.some(
        (spec) =>
          spec.kind === "updateMany" &&
          spec.model === "CustomerCsvImportRow" &&
          spec.field === "possibleDuplicateCustomerId",
      ),
  );
  check(
    "Feature does not send email or SMS",
    !/sendEmail|sendMail|sendSms|resend|attemptCustomerSms/i.test(featureSource),
  );
  check(
    "Customers list still exposes New Customer",
    readSrc("src/app/(app)/customers/page.tsx").includes('<NewCustomerForm label="New Customer" />'),
  );
  check(
    "Confirm form requires explicit same-customer confirmation",
    readSrc("src/components/customers/merge-customers-form.tsx").includes('name="confirmSameCustomer"'),
  );
  check(
    "UI tells the owner absorbed name/email/phone stay in the audit snapshot",
    readSrc("src/components/customers/merge-customers-form.tsx").includes("ABSORBED_CONTACT_AUDIT_MESSAGE") &&
      readSrc("src/app/(app)/customers/duplicates/[leftId]/[rightId]/page.tsx").includes(
        "ABSORBED_CONTACT_AUDIT_MESSAGE",
      ),
  );
  check(
    "Test-only hooks exist and production files never assign them",
    opsSrc.includes("export const customerMergeTestHooks") &&
      !/customerMergeTestHooks\.(beforeLock|afterLocked|afterRelationsMoved)\s*=/.test(featureSource) &&
      testSrc.includes("createCount2Barrier"),
  );
  check(
    "Serialization conflicts retry with a try-again message",
    opsSrc.includes("P2034") &&
      opsSrc.includes("40001") &&
      opsSrc.includes("P2028") &&
      opsSrc.includes("P2003") &&
      opsSrc.includes("MERGE_TRY_AGAIN_MESSAGE") &&
      opsSrc.includes("maxWait") &&
      opsSrc.includes("timeout") &&
      !opsSrc.includes('error.code === "P2002" || error.code === "P2025" || error.code === "P2034"'),
  );
  check(
    "Absorbed stricter consent keeps the absorbed smsConsentUpdatedAt",
    opsSrc.includes("adoptingAbsorbedStricter") &&
      opsSrc.includes("absorb.smsConsentUpdatedAt"),
  );
  check(
    "Leftover-reference check runs before hard delete and is unscoped by businessId",
    opsSrc.includes("assertNoLeftoverCustomerReferences") &&
      opsSrc.includes("customerFkFieldsFromDmmf") &&
      opsSrc.indexOf("assertNoLeftoverCustomerReferences") < opsSrc.indexOf("tx.customer.delete") &&
      !opsSrc.includes("new PrismaClient(") &&
      opsSrc.includes("possibleDuplicateCustomerId") &&
      opsSrc.includes('recordType: "CUSTOMER"') &&
      opsSrc.includes("pendingBusinessEventWhere") &&
      opsSrc.includes('path: ["customerId"]') &&
      opsSrc.includes("CUSTOMER_REASSIGN_SPECS"),
  );
  check(
    "Duplicate listing groups in SQL with take and a per-group cap",
    opsSrc.includes("GROUP BY") &&
      opsSrc.includes("DUPLICATE_REVIEW_GROUP_TAKE") &&
      opsSrc.includes("DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP") &&
      opsSrc.includes("loadPossibleDuplicatesForCustomer") &&
      !opsSrc.includes("async function loadOwnedIdentities") &&
      readSrc("src/app/(app)/customers/[customerId]/page.tsx").includes("loadPossibleDuplicatesForCustomer"),
  );
  check(
    "Membership merge actor FK is SET NULL",
    readSrc("prisma/schema.prisma").includes("CustomerMergeActor") &&
      readSrc("prisma/schema.prisma").includes("onDelete: SetNull") &&
      readSrc("prisma/migrations/20260929020000_customer_merge/migration.sql").includes("ON DELETE SET NULL") &&
      !/DROP NOT NULL|DROP CONSTRAINT/i.test(readSrc("prisma/migrations/20260929020000_customer_merge/migration.sql")),
  );
  check(
    "STOP and START consent writes use updateMany and follow absorbed merge hops",
    inboundSrc.includes("updateMany") &&
      inboundSrc.includes("absorbedCustomerId") &&
      inboundSrc.includes("smsConsentUpdatedAt") &&
      inboundSrc.includes("CONSENT_MERGE_HOPS") &&
      inboundSrc.includes("fromDigits") &&
      inboundSrc.includes("resolveLiveSurvivor") &&
      inboundSrc.includes("INBOUND_WEBHOOK_PENDING_AT") &&
      inboundSrc.includes('smsConsentStatus: "REVOKED"') &&
      inboundSrc.includes("start_not_applicable") &&
      inboundSrc.includes("stale_event") &&
      inboundSrc.includes("pg_advisory_xact_lock") &&
      inboundSrc.includes("tbbt-consent:") &&
      inboundSrc.includes("prepareInboundConsentClaim") &&
      inboundSrc.includes("smsConsentUpdatedAt: { lt:") &&
      inboundSrc.includes("console.error") &&
      inboundSrc.includes("redactedInboundConsentFailure(input.error)") &&
      !inboundSrc.includes("error: input.error") &&
      inboundSrc.includes("applyRecordedInboundConsent") &&
      inboundSrc.includes("findUnambiguousSurvivorForAbsorbedPhone") &&
      inboundSrc.includes("absorbedSnapshot") &&
      inboundSrc.includes("inboundConsentTestHooks") &&
      !inboundSrc.includes('if (duplicate === "duplicate")') &&
      !/customer\.update\(\s*\{/.test(inboundSrc) &&
      !/catch\s*\{/.test(inboundSrc),
  );
  check(
    "Upload-create takes FOR KEY SHARE on the customer before inserting a StoredAsset",
    readSrc("src/lib/business-storage/service.ts").includes("FOR KEY SHARE") &&
      readSrc("src/lib/business-storage/service.ts").includes('SELECT id FROM "Customer"'),
  );
  check(
    "This harness refuses non-localhost hosts before connect or push",
    testSrc.includes("assertLocalDatabaseUrl") &&
      testSrc.indexOf("assertLocalDatabaseUrl(baseUrl") < testSrc.indexOf("CREATE DATABASE") &&
      testSrc.indexOf("assertLocalDatabaseUrl(baseUrl") < testSrc.indexOf('db", "push"') &&
      testSrc.includes('DROP DATABASE IF EXISTS "${name}" WITH (FORCE)'),
  );

  const dmmfRelations = customerListRelationsFromDmmf(Prisma.dmmf);
  const missingRelations = dmmfRelations.filter(
    (name) => !REASSIGNED_CUSTOMER_RELATION_FIELDS.includes(name),
  );
  const requiredRefs = requiredCustomerReassignTargets(Prisma.dmmf);
  const handledRefs = handledCustomerReassignKeys();
  const missingRefs = requiredRefs.filter((ref) => !handledRefs.has(`${ref.model}.${ref.field}`));
  check(
    "DMMF Customer relations are all handled in reassignCustomerId",
    missingRelations.length === 0 &&
      REASSIGNED_CUSTOMER_RELATION_FIELDS.every((name) => dmmfRelations.includes(name)),
  );
  if (missingRelations.length > 0) {
    console.error(`  missing DMMF relations: ${missingRelations.join(", ")}`);
  }
  check(
    "Re-point table covers every Customer FK, list relation, and soft customer-id column",
    missingRefs.length === 0 &&
      requiredRefs.some((ref) => ref.model === "StoredAsset" && ref.field === "customerId") &&
      requiredRefs.some((ref) => ref.model === "ExternalLeadImportRow" && ref.field === "possibleDuplicateCustomerId") &&
      requiredRefs.some((ref) => ref.model === "Job" && ref.field === "customerId") &&
      requiredRefs.some((ref) => ref.model === "JobCallback" && ref.field === "customerId") &&
      requiredRefs.some((ref) => ref.model === "InvoiceCollectionWorkItem" && ref.field === "customerId") &&
      requiredRefs.some((ref) => ref.model === "CustomerCsvImportRow" && ref.field === "createdCustomerId") &&
      requiredRefs.some((ref) => ref.model === "CustomerCsvImportRow" && ref.field === "possibleDuplicateCustomerId") &&
      requiredRefs.some((ref) => ref.model === "InvoiceCredit" && ref.field === "customerId"),
  );
  if (missingRefs.length > 0) {
    console.error(
      `  unhandled Customer refs: ${missingRefs.map((ref) => `${ref.model}.${ref.field} (${ref.via})`).join(", ")}`,
    );
  }
  check(
    "DMMF leftover scan finds Customer foreign keys",
    customerFkFieldsFromDmmf(Prisma.dmmf).some((ref) => ref.model === "Job" && ref.field === "customerId"),
  );
  check(
    "Shared test hooks start inert",
    !customerMergeTestHooks.beforeLock &&
      !customerMergeTestHooks.afterLocked &&
      !customerMergeTestHooks.afterRelationsMoved,
  );
  check("Listing group take is bounded", DUPLICATE_REVIEW_GROUP_TAKE <= 25);
  check("Pairs per group are capped", DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP <= 8);

  console.log("\nUNIT — matching and stricter SMS consent");
  const sameEmail = findPossibleDuplicatePairs([
    {
      id: "a",
      businessId: "biz",
      name: "Ada",
      email: "ada@example.com",
      phone: "2395550100",
      smsConsentStatus: "GRANTED",
      smsConsentUpdatedAt: null,
      firstLeadSource: null,
      firstCampaignId: null,
      createdAt: new Date(),
    },
    {
      id: "b",
      businessId: "biz",
      name: "Ada Lovelace",
      email: "ADA@example.com",
      phone: "2395550199",
      smsConsentStatus: "UNKNOWN",
      smsConsentUpdatedAt: null,
      firstLeadSource: null,
      firstCampaignId: null,
      createdAt: new Date(),
    },
    {
      id: "c",
      businessId: "biz",
      name: "Ada",
      email: "other@example.com",
      phone: "4075550100",
      smsConsentStatus: "UNKNOWN",
      smsConsentUpdatedAt: null,
      firstLeadSource: null,
      firstCampaignId: null,
      createdAt: new Date(),
    },
  ]);
  check(
    "Email match is a possible pair even when names differ",
    sameEmail.length === 1 &&
      sameEmail[0].reasons.includes("email") &&
      sameEmail[0].sharedEmail === "ada@example.com",
  );
  check(
    "Matching names alone are not a possible pair",
    pairMatchReasons(
      { email: "one@example.com", phone: "2395550100" },
      { email: "two@example.com", phone: "4075550100" },
    ).length === 0 && sameEmail.every((pair) => pair.left.id !== "c" && pair.right.id !== "c"),
  );
  check("REVOKED wins over GRANTED", mergeSmsConsentStates("GRANTED", "REVOKED") === "REVOKED");
  check("UNKNOWN wins over GRANTED", mergeSmsConsentStates("GRANTED", "UNKNOWN") === "UNKNOWN");
  check("Both GRANTED stay GRANTED", mergeSmsConsentStates("GRANTED", "GRANTED") === "GRANTED");
  check("Canonical pair href sorts ids", pairHref("b", "a") === "/customers/duplicates/a/b");
  const manySameEmail = findPossibleDuplicatePairs(
    Array.from({ length: 12 }, (_, index) => ({
      id: `g${index}`,
      businessId: "biz",
      name: `Group ${index}`,
      email: "group@example.com",
      phone: null,
      smsConsentStatus: "UNKNOWN",
      smsConsentUpdatedAt: null,
      firstLeadSource: null,
      firstCampaignId: null,
      createdAt: new Date(),
    })),
  );
  check(
    "In-memory pair builder caps customers per group",
    manySameEmail.length === (DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP * (DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP - 1)) / 2,
  );

  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await terminateAndDrop(admin, testDbName);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
    dbCreated = true;
  } finally {
    await admin.$disconnect();
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    throw new Error("Failed to push schema for customer merge test database.");
  }
  }

  prisma = new PrismaClient({ datasourceUrl: testUrl });

  async function seedBusiness(label) {
    const business = await prisma.business.create({
      data: { name: `${label} Merge`, slug: `${label}-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
    });
    const ownerUser = await prisma.user.create({
      data: { name: `${label} Owner`, email: `${label}-owner-${randomUUID()}@example.com`, passwordHash: "x" },
    });
    const adminUser = await prisma.user.create({
      data: { name: `${label} Admin`, email: `${label}-admin-${randomUUID()}@example.com`, passwordHash: "x" },
    });
    const memberUser = await prisma.user.create({
      data: { name: `${label} Member`, email: `${label}-member-${randomUUID()}@example.com`, passwordHash: "x" },
    });
    const ownerMem = await prisma.membership.create({
      data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
    });
    const adminMem = await prisma.membership.create({
      data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
    });
    const memberMem = await prisma.membership.create({
      data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
    });
    const storage = await prisma.businessStorageAccount.create({
      data: {
        businessId: business.id,
        bucketName: `${label}-bucket`,
        namespacePrefix: `businesses/${business.id}`,
        storageLimitBytes: 1_000_000n,
      },
    });
    return {
      business,
      storage,
      ownerMem,
      owner: makeAccess(business.id, "OWNER", ownerMem.id),
      admin: makeAccess(business.id, "ADMIN", adminMem.id),
      member: makeAccess(business.id, "MEMBER", memberMem.id),
    };
  }

  async function createLinkedRecords(ctx, customerId, suffix, extra = {}) {
    const { business, storage, ownerMem } = ctx;
    const businessId = business.id;
    const campaign = await prisma.marketingCampaign.create({
      data: { businessId, name: `${suffix} campaign` },
    });
    if (extra.firstCampaign) {
      await prisma.customer.update({
        where: { id: customerId },
        data: { firstCampaignId: campaign.id, firstLeadSource: "WEBSITE" },
      });
    }
    const property = await prisma.property.create({
      data: { businessId, customerId, addressLine1: `${suffix} Main St` },
    });
    const request = await prisma.serviceRequest.create({
      data: { businessId, customerId, propertyId: property.id, summary: `${suffix} request` },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId,
        customerId,
        propertyId: property.id,
        serviceRequestId: request.id,
        publicToken: randomUUID(),
        total: 100,
      },
    });
    const job = await prisma.job.create({
      data: {
        businessId,
        customerId,
        propertyId: property.id,
        estimateId: estimate.id,
        projectToken: randomUUID(),
        status: "UNSCHEDULED",
      },
    });
    const invoice = await prisma.invoice.create({
      data: { businessId, customerId, jobId: job.id, total: 100, status: "SENT" },
    });
    const payment = await prisma.payment.create({
      data: {
        businessId,
        customerId,
        invoiceId: invoice.id,
        jobId: job.id,
        purpose: "INVOICE_BALANCE",
        amount: 25,
        method: "CASH",
      },
    });
    const invoiceCredit = await prisma.invoiceCredit.create({
      data: {
        businessId,
        invoiceId: invoice.id,
        customerId,
        amount: 10,
        reason: `${suffix} recorded credit`,
        recordedByMembershipId: ownerMem.id,
        idempotencyKey: `merge-credit-${suffix}-${randomUUID()}`,
      },
    });
    const expense = await prisma.expense.create({
      data: {
        businessId,
        customerId,
        jobId: job.id,
        occurredOn: new Date("2026-09-01T00:00:00.000Z"),
        description: `${suffix} expense`,
        amount: 12,
        category: "MATERIALS",
      },
    });
    const thread = await prisma.communicationThread.create({
      data: {
        businessId,
        customerId,
        subjectType: "CUSTOMER",
        subjectId: customerId,
        title: `${suffix} thread`,
      },
    });
    const communication = await prisma.customerCommunication.create({
      data: {
        businessId,
        customerId,
        threadId: thread.id,
        purpose: "GENERAL",
        idempotencyKey: `merge-${suffix}-${randomUUID()}`,
        status: "SENT",
        provider: "none",
        bodySnapshot: `${suffix} hello`,
      },
    });
    const reviewRequest = await prisma.reviewRequest.create({
      data: {
        businessId,
        customerId,
        jobId: job.id,
        createdByMembershipId: ownerMem.id,
        requestText: `${suffix} review ask`,
      },
    });
    const review = await prisma.review.create({
      data: {
        businessId,
        customerId,
        jobId: job.id,
        reviewRequestId: reviewRequest.id,
        platform: "GOOGLE",
        recordedByMembershipId: ownerMem.id,
        reviewText: `${suffix} review`,
      },
    });
    const referralRequest = await prisma.referralRequest.create({
      data: {
        businessId,
        customerId,
        jobId: job.id,
        createdByMembershipId: ownerMem.id,
        requestText: `${suffix} referral ask`,
      },
    });
    const otherCustomer = extra.referredCustomerId
      ? { id: extra.referredCustomerId }
      : await prisma.customer.create({
          data: {
            businessId,
            name: `${suffix} referred`,
            email: `${suffix}-referred-${randomUUID().slice(0, 8)}@example.com`,
          },
        });
    const referralGiven = await prisma.referral.create({
      data: {
        businessId,
        sourceCustomerId: customerId,
        referredCustomerId: extra.skipReferred ? null : otherCustomer.id,
        referralRequestId: referralRequest.id,
      },
    });
    const referralReceived = extra.sourceCustomerId
      ? await prisma.referral.create({
          data: {
            businessId,
            sourceCustomerId: extra.sourceCustomerId,
            referredCustomerId: customerId,
          },
        })
      : null;
    const followUp = await prisma.customerFollowUp.create({
      data: {
        businessId,
        customerId,
        jobId: job.id,
        kind: "JOB_COMPLETE",
      },
    });
    const phoneInteraction = await prisma.phoneInteraction.create({
      data: {
        businessId,
        customerId,
        threadId: thread.id,
        kind: "MANUAL_PHONE",
        idempotencyKey: `phone-${suffix}-${randomUUID()}`,
        summary: `${suffix} call`,
      },
    });
    const receptionistEvent = await prisma.receptionistEvent.create({
      data: {
        businessId,
        customerId,
        phoneInteractionId: phoneInteraction.id,
        kind: "INBOUND_CALL",
        status: "RECORDED",
        idempotencyKey: `recv-${suffix}-${randomUUID()}`,
      },
    });
    const growth = await prisma.growthActionRequest.create({
      data: {
        businessId,
        customerId,
        kind: "REVIEW_ASK",
        queue: "DORMANT",
      },
    });
    const asset = await prisma.storedAsset.create({
      data: {
        businessId,
        storageAccountId: storage.id,
        customerId,
        category: "CUSTOMER_PHOTO",
        originalFilename: `${suffix}.jpg`,
        storageKey: `${suffix}-${randomUUID()}`,
        mimeType: "image/jpeg",
        fileSizeBytes: 128,
      },
    });
    const leadImport = extra.skipSoftRefs
      ? null
      : await prisma.externalLeadImport.create({
          data: {
            businessId,
            sourceKind: "CSV_UPLOAD",
            sourceLabel: `${suffix}.csv`,
            contentSha256: randomUUID().replaceAll("-", ""),
            capturedAt: new Date(),
            rowCount: 1,
            validCount: 0,
            invalidCount: 0,
            possibleDuplicateCount: 1,
            createdByMembershipId: ownerMem.id,
          },
        });
    const importRow = leadImport
      ? await prisma.externalLeadImportRow.create({
          data: {
            businessId,
            importId: leadImport.id,
            rowNumber: 1,
            previewStatus: "POSSIBLE_DUPLICATE",
            rowFingerprint: randomUUID(),
            name: suffix,
            leadSource: "MANUAL",
            possibleDuplicateCustomerId: customerId,
          },
        })
      : null;
    const correction = extra.skipSoftRefs
      ? null
      : await prisma.leadAttributionCorrection.create({
          data: {
            businessId,
            recordType: "CUSTOMER",
            recordId: customerId,
            reason: `${suffix} attribution`,
          },
        });
    const event = extra.skipSoftRefs
      ? null
      : await prisma.businessEvent.create({
          data: {
            businessId,
            type: "CUSTOMER_FOLLOW_UP_DUE",
            subjectType: "CUSTOMER",
            subjectId: customerId,
            payload: { customerId, businessName: "Merge Co" },
            idempotencyKey: `evt-${suffix}-${randomUUID()}`,
          },
        });
    const jobCallback = await prisma.jobCallback.create({
      data: {
        businessId,
        jobId: job.id,
        customerId,
        description: `${suffix} callback`,
        reportedVia: "PHONE",
        recordedByMembershipId: ownerMem.id,
      },
    });
    const collectionWorkItem = await prisma.invoiceCollectionWorkItem.create({
      data: {
        businessId,
        invoiceId: invoice.id,
        customerId,
        status: "OPEN",
        nextStep: "CALL",
        note: `${suffix} collect`,
      },
    });
    const csvImport = await prisma.customerCsvImport.create({
      data: {
        businessId,
        sourceKind: "CSV_UPLOAD",
        sourceLabel: `${suffix}-customers.csv`,
        contentSha256: randomUUID().replaceAll("-", ""),
        capturedAt: new Date(),
        status: "CONFIRMED",
        rowCount: 2,
        validCount: 1,
        invalidCount: 0,
        possibleDuplicateCount: 1,
        createdByMembershipId: ownerMem.id,
      },
    });
    const csvCreatedRow = await prisma.customerCsvImportRow.create({
      data: {
        businessId,
        importId: csvImport.id,
        rowNumber: 1,
        previewStatus: "VALID",
        rowFingerprint: randomUUID(),
        name: `${suffix} created`,
        createdCustomerId: customerId,
      },
    });
    const csvDuplicateRow = await prisma.customerCsvImportRow.create({
      data: {
        businessId,
        importId: csvImport.id,
        rowNumber: 2,
        previewStatus: "POSSIBLE_DUPLICATE",
        rowFingerprint: randomUUID(),
        name: `${suffix} duplicate`,
        possibleDuplicateCustomerId: customerId,
      },
    });
    return {
      campaign,
      property,
      request,
      estimate,
      job,
      invoice,
      payment,
      invoiceCredit,
      expense,
      thread,
      communication,
      reviewRequest,
      review,
      referralRequest,
      referralGiven,
      referralReceived,
      followUp,
      phoneInteraction,
      receptionistEvent,
      growth,
      asset,
      importRow,
      correction,
      event,
      otherCustomer,
      jobCallback,
      collectionWorkItem,
      csvCreatedRow,
      csvDuplicateRow,
    };
  }

  async function assertNoOrphans(deletedId, label) {
    const leftovers = [];
    for (const ref of customerFkFieldsFromDmmf(Prisma.dmmf)) {
      const count = await prisma[ref.delegate].count({ where: { [ref.field]: deletedId } });
      if (count > 0) leftovers.push(`${ref.model}.${ref.field}`);
    }
    const extras = await Promise.all([
      prisma.storedAsset.count({ where: { customerId: deletedId } }),
      prisma.externalLeadImportRow.count({ where: { possibleDuplicateCustomerId: deletedId } }),
      prisma.customerCsvImportRow.count({ where: { createdCustomerId: deletedId } }),
      prisma.customerCsvImportRow.count({ where: { possibleDuplicateCustomerId: deletedId } }),
      prisma.leadAttributionCorrection.count({ where: { recordType: "CUSTOMER", recordId: deletedId } }),
      prisma.businessEvent.count({
        where: {
          OR: [
            { payload: { path: ["customerId"], equals: deletedId } },
            { subjectType: "CUSTOMER", subjectId: deletedId },
          ],
        },
      }),
    ]);
    if (extras.some((count) => count > 0)) leftovers.push("soft-ref");
    check(`${label}: no leftover or orphaned rows`, leftovers.length === 0);
  }

  async function runInvoiceCreditMergeProof(ctx) {
    const keepCustomer = await prisma.customer.create({
      data: {
        businessId: ctx.business.id,
        name: "Credit Keep",
        email: "invoice-credit-merge@example.com",
        phone: "2395550199",
      },
    });
    const absorbCustomer = await prisma.customer.create({
      data: {
        businessId: ctx.business.id,
        name: "Credit Absorb",
        email: "invoice-credit-merge@example.com",
        phone: "(239) 555-0199",
      },
    });
    const job = await prisma.job.create({
      data: {
        businessId: ctx.business.id,
        customerId: absorbCustomer.id,
        projectToken: randomUUID(),
        status: "COMPLETED",
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        businessId: ctx.business.id,
        customerId: absorbCustomer.id,
        jobId: job.id,
        kind: "ORIGINAL",
        status: "SENT",
        total: 100,
      },
    });
    const credit = await prisma.invoiceCredit.create({
      data: {
        businessId: ctx.business.id,
        invoiceId: invoice.id,
        customerId: absorbCustomer.id,
        amount: 30,
        reason: "absorbed customer credit",
        recordedByMembershipId: ctx.ownerMem.id,
        idempotencyKey: `invoice-credit-merge-${randomUUID()}`,
      },
    });
    let mergeError = null;
    try {
      await mergeConfirmedCustomers(prisma, ctx.owner, {
        keepCustomerId: keepCustomer.id,
        absorbCustomerId: absorbCustomer.id,
        confirmedSameCustomer: true,
      });
    } catch (error) {
      mergeError = error;
    }
    const moved = await prisma.invoiceCredit.findUnique({ where: { id: credit.id } });
    check(
      "Absorbed invoice credit now belongs to the survivor",
      mergeError === null && moved?.customerId === keepCustomer.id,
    );
  }

  if (MUTATION_KIND === "invoice-credit-reassign") {
    const ctx = await seedBusiness("credit-mutation");
    await runInvoiceCreditMergeProof(ctx);
  } else {

  const alpha = await seedBusiness("alpha");
  const beta = await seedBusiness("beta");
  const consentUpdatedAt = new Date("2026-04-02T15:00:00.000Z");

  const keep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ada Keep",
      email: "ada-merge@example.com",
      phone: "2395550100",
      smsConsentStatus: "GRANTED",
    },
  });
  const absorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ada Absorb",
      email: "ada-merge@example.com",
      phone: "(239) 555-0100",
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: consentUpdatedAt,
    },
  });
  const nameOnly = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ada Keep",
      email: "different-ada@example.com",
      phone: "4075550100",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const betaTwin = await prisma.customer.create({
    data: {
      businessId: beta.business.id,
      name: "Beta Ada",
      email: "ada-merge@example.com",
      phone: "2395550100",
      smsConsentStatus: "GRANTED",
    },
  });

  const keepLinks = await createLinkedRecords(alpha, keep.id, "keep", { firstCampaign: true });
  const absorbLinks = await createLinkedRecords(alpha, absorb.id, "absorb", {
    firstCampaign: true,
    sourceCustomerId: keep.id,
    referredCustomerId: keep.id,
  });
  const betaLinks = await createLinkedRecords(beta, betaTwin.id, "beta");

  console.log("\nAUTH — OWNER review only");
  try {
    requireBusinessRole(alpha.admin, "OWNER");
    check("ADMIN fails the OWNER role floor", false);
  } catch (error) {
    check("ADMIN fails the OWNER role floor", error instanceof ForbiddenError);
  }
  try {
    await loadDuplicateReview(prisma, alpha.admin);
    check("ADMIN cannot load duplicate review", false);
  } catch (error) {
    check("ADMIN cannot load duplicate review", error instanceof ForbiddenError);
  }
  try {
    await mergeConfirmedCustomers(prisma, alpha.member, {
      keepCustomerId: keep.id,
      absorbCustomerId: absorb.id,
      confirmedSameCustomer: true,
    });
    check("MEMBER cannot merge", false);
  } catch (error) {
    check("MEMBER cannot merge", error instanceof ForbiddenError);
  }
  try {
    await mergeConfirmedCustomers(prisma, alpha.owner, {
      keepCustomerId: keep.id,
      absorbCustomerId: absorb.id,
      confirmedSameCustomer: false,
    });
    check("Unconfirmed merge is rejected", false);
  } catch (error) {
    check("Unconfirmed merge is rejected", error instanceof CustomerMergeError && error.message === CONFIRM_REQUIRED_MESSAGE);
  }

  console.log("\nISOLATION — other businesses never appear or merge");
  const review = await loadDuplicateReview(prisma, alpha.owner);
  check(
    "Review lists the same-business email/phone pair only",
    review.pairs.length === 1 &&
      review.pairs[0].left.id === keep.id &&
      review.pairs[0].right.id === absorb.id &&
      review.pairs[0].reasons.includes("email") &&
      review.pairs[0].reasons.includes("phone"),
  );
  const detailPairs = await loadPossibleDuplicatesForCustomer(prisma, alpha.owner, keep.id);
  check(
    "Per-customer lookup returns the same pair without a full scan",
    detailPairs.pairs.length === 1 &&
      detailPairs.pairs[0].left.id === keep.id &&
      detailPairs.pairs[0].right.id === absorb.id,
  );
  check(
    "Name-only same-business customer is not a pair",
    review.pairs.every((pair) => pair.left.id !== nameOnly.id && pair.right.id !== nameOnly.id),
  );
  check(
    "Other-business twin is not a pair",
    review.pairs.every((pair) => pair.left.id !== betaTwin.id && pair.right.id !== betaTwin.id),
  );
  try {
    await mergeConfirmedCustomers(prisma, alpha.owner, {
      keepCustomerId: keep.id,
      absorbCustomerId: betaTwin.id,
      confirmedSameCustomer: true,
    });
    check("Cross-business merge is rejected", false);
  } catch (error) {
    check(
      "Cross-business merge is rejected",
      error instanceof CustomerMergeError &&
        (error.message === CUSTOMERS_NOT_AVAILABLE_MESSAGE || error.message === CROSS_BUSINESS_MERGE_MESSAGE),
    );
  }
  try {
    await mergeConfirmedCustomers(prisma, alpha.owner, {
      keepCustomerId: keep.id,
      absorbCustomerId: nameOnly.id,
      confirmedSameCustomer: true,
    });
    check("Name-only merge is rejected", false);
  } catch (error) {
    check(
      "Name-only merge is rejected",
      error instanceof CustomerMergeError && error.message === NO_SHARED_IDENTIFIER_MESSAGE,
    );
  }

  console.log("\nROLLBACK — failed merge leaves both records intact");
  try {
    await mergeConfirmedCustomers(
      prisma,
      alpha.owner,
      {
        keepCustomerId: keep.id,
        absorbCustomerId: absorb.id,
        confirmedSameCustomer: true,
      },
      {
        afterRelationsMoved: async () => {
          throw new CustomerMergeError("forced rollback");
        },
      },
    );
    check("Forced failure aborts the merge", false);
  } catch (error) {
    check("Forced failure aborts the merge", error instanceof CustomerMergeError && error.message === "forced rollback");
  }
  const absorbAfterRollback = await prisma.customer.findUnique({ where: { id: absorb.id } });
  const absorbJobAfterRollback = await prisma.job.findUnique({ where: { id: absorbLinks.job.id } });
  const absorbInvoiceAfterRollback = await prisma.invoice.findUnique({ where: { id: absorbLinks.invoice.id } });
  const absorbMessageAfterRollback = await prisma.customerCommunication.findUnique({
    where: { id: absorbLinks.communication.id },
  });
  const mergeRowsAfterRollback = await prisma.customerMerge.count({
    where: { businessId: alpha.business.id },
  });
  check("Absorbed customer still exists after rollback", Boolean(absorbAfterRollback));
  check("Absorbed job still points at the absorbed customer", absorbJobAfterRollback?.customerId === absorb.id);
  check("Absorbed invoice still points at the absorbed customer", absorbInvoiceAfterRollback?.customerId === absorb.id);
  check(
    "Absorbed communication still points at the absorbed customer",
    absorbMessageAfterRollback?.customerId === absorb.id,
  );
  check("No merge audit row after rollback", mergeRowsAfterRollback === 0);

  console.log("\nPRESERVE — every Customer relation and stricter consent stay on the survivor");
  const preserved = await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: keep.id,
    absorbCustomerId: absorb.id,
    confirmedSameCustomer: true,
  });
  const survivor = await prisma.customer.findUnique({ where: { id: keep.id } });
  const absorbedGone = await prisma.customer.findUnique({ where: { id: absorb.id } });
  check("Survivor remains", preserved.survivorId === keep.id && survivor?.id === keep.id);
  check("Absorbed customer is deleted", absorbedGone === null);
  check("Stricter SMS consent is REVOKED", survivor?.smsConsentStatus === "REVOKED");
  check(
    "Absorbed smsConsentUpdatedAt is kept when its stricter status is adopted",
    survivor?.smsConsentUpdatedAt?.getTime() === consentUpdatedAt.getTime(),
  );
  check("Survivor keeps its first campaign", survivor?.firstCampaignId === keepLinks.campaign.id);

  const relationChecks = [
    ["jobs", prisma.job, [keepLinks.job.id, absorbLinks.job.id]],
    ["estimates", prisma.estimate, [keepLinks.estimate.id, absorbLinks.estimate.id]],
    ["invoices", prisma.invoice, [keepLinks.invoice.id, absorbLinks.invoice.id]],
    ["properties", prisma.property, [keepLinks.property.id, absorbLinks.property.id]],
    ["serviceRequests", prisma.serviceRequest, [keepLinks.request.id, absorbLinks.request.id]],
    ["payments", prisma.payment, [keepLinks.payment.id, absorbLinks.payment.id]],
    ["invoiceCredits", prisma.invoiceCredit, [keepLinks.invoiceCredit.id, absorbLinks.invoiceCredit.id]],
    ["expenses", prisma.expense, [keepLinks.expense.id, absorbLinks.expense.id]],
    ["reviewRequests", prisma.reviewRequest, [keepLinks.reviewRequest.id, absorbLinks.reviewRequest.id]],
    ["reviews", prisma.review, [keepLinks.review.id, absorbLinks.review.id]],
    ["communications", prisma.customerCommunication, [keepLinks.communication.id, absorbLinks.communication.id]],
    ["phoneInteractions", prisma.phoneInteraction, [keepLinks.phoneInteraction.id, absorbLinks.phoneInteraction.id]],
    ["receptionistEvents", prisma.receptionistEvent, [keepLinks.receptionistEvent.id, absorbLinks.receptionistEvent.id]],
    ["referralRequests", prisma.referralRequest, [keepLinks.referralRequest.id, absorbLinks.referralRequest.id]],
    ["customerFollowUps", prisma.customerFollowUp, [keepLinks.followUp.id, absorbLinks.followUp.id]],
    ["growthActionRequests", prisma.growthActionRequest, [keepLinks.growth.id, absorbLinks.growth.id]],
    ["storedAssets", prisma.storedAsset, [keepLinks.asset.id, absorbLinks.asset.id]],
  ];
  for (const [label, delegate, ids] of relationChecks) {
    const rows = await delegate.findMany({ where: { id: { in: ids } } });
    check(
      `Both ${label} now belong to the survivor`,
      rows.length === ids.length && rows.every((row) => row.customerId === keep.id),
    );
  }
  const movedThreads = await prisma.communicationThread.findMany({
    where: { businessId: alpha.business.id, customerId: keep.id },
  });
  check(
    "Customer-level threads collapsed onto the survivor",
    movedThreads.length === 1 &&
      movedThreads[0].customerId === keep.id &&
      movedThreads[0].subjectId === keep.id,
  );
  const given = await prisma.referral.findMany({
    where: { id: { in: [keepLinks.referralGiven.id, absorbLinks.referralGiven.id] } },
  });
  check(
    "Referrals given move sourceCustomerId onto the survivor",
    given.length === 2 && given.every((row) => row.sourceCustomerId === keep.id),
  );
  const received = await prisma.referral.findUnique({ where: { id: absorbLinks.referralReceived.id } });
  check("Referral received moves referredCustomerId onto the survivor", received?.referredCustomerId === keep.id);
  const importRow = await prisma.externalLeadImportRow.findUnique({ where: { id: absorbLinks.importRow.id } });
  check(
    "ExternalLeadImportRow.possibleDuplicateCustomerId remaps",
    importRow?.possibleDuplicateCustomerId === keep.id,
  );
  const remappedCallback = await prisma.jobCallback.findUnique({ where: { id: absorbLinks.jobCallback.id } });
  check(
    "JobCallback.customerId remaps onto the survivor and is not nulled",
    remappedCallback?.customerId === keep.id,
  );
  const remappedCollection = await prisma.invoiceCollectionWorkItem.findUnique({
    where: { id: absorbLinks.collectionWorkItem.id },
  });
  check(
    "InvoiceCollectionWorkItem.customerId remaps onto the survivor and is not nulled",
    remappedCollection?.customerId === keep.id,
  );
  const remappedInvoiceCredit = await prisma.invoiceCredit.findUnique({
    where: { id: absorbLinks.invoiceCredit.id },
  });
  check(
    "InvoiceCredit.customerId remaps onto the survivor and is not nulled",
    remappedInvoiceCredit?.customerId === keep.id,
  );

  console.log("\nTEST — Merge remaps an absorbed InvoiceCredit onto the survivor");
  const creditMergeCtx = await seedBusiness("credit-merge");
  await runInvoiceCreditMergeProof(creditMergeCtx);
  const remappedCsvCreated = await prisma.customerCsvImportRow.findUnique({
    where: { id: absorbLinks.csvCreatedRow.id },
  });
  check(
    "CustomerCsvImportRow.createdCustomerId remaps onto the survivor and is not dangling",
    remappedCsvCreated?.createdCustomerId === keep.id,
  );
  const remappedCsvDuplicate = await prisma.customerCsvImportRow.findUnique({
    where: { id: absorbLinks.csvDuplicateRow.id },
  });
  check(
    "CustomerCsvImportRow.possibleDuplicateCustomerId remaps onto the survivor and is not dangling",
    remappedCsvDuplicate?.possibleDuplicateCustomerId === keep.id,
  );
  const betaCallback = await prisma.jobCallback.findUnique({ where: { id: betaLinks.jobCallback.id } });
  const betaCollection = await prisma.invoiceCollectionWorkItem.findUnique({
    where: { id: betaLinks.collectionWorkItem.id },
  });
  const betaCsvCreated = await prisma.customerCsvImportRow.findUnique({
    where: { id: betaLinks.csvCreatedRow.id },
  });
  const betaCsvDuplicate = await prisma.customerCsvImportRow.findUnique({
    where: { id: betaLinks.csvDuplicateRow.id },
  });
  check(
    "Another business's JobCallback, collection work item, and CSV import rows stay on that tenant's customer",
    betaCallback?.customerId === betaTwin.id &&
      betaCollection?.customerId === betaTwin.id &&
      betaCsvCreated?.createdCustomerId === betaTwin.id &&
      betaCsvDuplicate?.possibleDuplicateCustomerId === betaTwin.id,
  );
  const correction = await prisma.leadAttributionCorrection.findUnique({ where: { id: absorbLinks.correction.id } });
  check("LeadAttributionCorrection CUSTOMER recordId remaps", correction?.recordId === keep.id);
  const event = await prisma.businessEvent.findUnique({ where: { id: absorbLinks.event.id } });
  check(
    "Pending BusinessEvent payload.customerId remaps",
    event?.subjectId === keep.id && event?.payload?.customerId === keep.id,
  );
  const audit = await prisma.customerMerge.findMany({ where: { businessId: alpha.business.id } });
  check(
    "Merge audit records the absorbed snapshot",
    audit.length === 1 &&
      audit[0].survivorCustomerId === keep.id &&
      audit[0].absorbedCustomerId === absorb.id &&
      audit[0].matchReasons.includes("email") &&
      audit[0].absorbedSnapshot?.name === "Ada Absorb",
  );
  check("Beta twin is untouched", (await prisma.customer.findUnique({ where: { id: betaTwin.id } }))?.email === "ada-merge@example.com");
  await assertNoOrphans(absorb.id, "Preserve merge");

  const ownedPair = await loadOwnedMergePair(prisma, alpha.owner, keep.id, nameOnly.id);
  check(
    "Remaining name-only customer still has no shared identifier",
    ownedPair.reasons.length === 0,
  );
  const leftoverReview = await loadDuplicateReview(prisma, alpha.owner);
  check("Successful merge clears the email/phone pair", leftoverReview.pairs.length === 0);

  async function seedPair(prefix, email) {
    const left = await prisma.customer.create({
      data: {
        businessId: alpha.business.id,
        name: `${prefix} Left`,
        email,
        phone: "2395550199",
        smsConsentStatus: "UNKNOWN",
      },
    });
    const right = await prisma.customer.create({
      data: {
        businessId: alpha.business.id,
        name: `${prefix} Right`,
        email,
        phone: "2395550199",
        smsConsentStatus: "GRANTED",
      },
    });
    const leftLinks = await createLinkedRecords(alpha, left.id, `${prefix}-l`, { skipSoftRefs: true });
    const rightLinks = await createLinkedRecords(alpha, right.id, `${prefix}-r`, { skipSoftRefs: true });
    return { left, right, leftLinks, rightLinks };
  }

  const lockAdminUrl = new URL(baseUrl);
  lockAdminUrl.searchParams.set("connection_limit", "1");
  const lockAdmin = new PrismaClient({ datasourceUrl: lockAdminUrl.toString() });
  extraClients.push(lockAdmin);

  console.log("\nCONCURRENT — A+B vs B+A with a count-2 barrier and separate clients");
  const raceAB = await seedPair("abba", `abba-${randomUUID().slice(0, 8)}@example.com`);
  const abBarrier = createCount2Barrier();
  const abClientA = createTestClient();
  const abClientB = createTestClient();
  const abHeld = mergeConfirmedCustomers(
    abClientA,
    alpha.owner,
    { keepCustomerId: raceAB.left.id, absorbCustomerId: raceAB.right.id, confirmedSameCustomer: true },
    { afterLocked: abBarrier.arrive },
  );
  const abHeldSettled = Promise.allSettled([abHeld]);
  await withTimeout(abBarrier.firstArrived, BARRIER_WAIT_MS, "A+B vs B+A entered write");
  const abContender = mergeConfirmedCustomers(
    abClientB,
    alpha.owner,
    { keepCustomerId: raceAB.right.id, absorbCustomerId: raceAB.left.id, confirmedSameCustomer: true },
  );
  const abContenderSettled = Promise.allSettled([abContender]);
  await releaseAfterLock(lockAdmin, abBarrier, "A+B vs B+A");
  const [abHeldResult] = await withTimeout(abHeldSettled, 25000, "A+B vs B+A held");
  const [abContenderResult] = await withTimeout(abContenderSettled, 25000, "A+B vs B+A contender");
  const abResults = [abHeldResult, abContenderResult];
  await Promise.all([disconnectClient(abClientA), disconnectClient(abClientB)]);
  const abWins = abResults.filter((result) => result.status === "fulfilled");
  const abLosses = abResults.filter((result) => result.status === "rejected");
  check("A+B vs B+A has exactly one winner", abWins.length === 1 && abLosses.length === 1);
  check(
    "A+B vs B+A loser is not-available",
    abLosses[0] &&
      abLosses[0].reason instanceof CustomerMergeError &&
      abLosses[0].reason.message === CUSTOMERS_NOT_AVAILABLE_MESSAGE,
  );
  const abLeft = await prisma.customer.findUnique({ where: { id: raceAB.left.id } });
  const abRight = await prisma.customer.findUnique({ where: { id: raceAB.right.id } });
  const abRemaining = [abLeft, abRight].filter(Boolean);
  check("A+B vs B+A leaves exactly one of the two customers", abRemaining.length === 1);
  const abSurvivorId = abRemaining[0]?.id;
  const abJobs = await prisma.job.findMany({
    where: { id: { in: [raceAB.leftLinks.job.id, raceAB.rightLinks.job.id] } },
  });
  check(
    "A+B vs B+A moves both jobs onto the survivor",
    Boolean(abSurvivorId) && abJobs.length === 2 && abJobs.every((row) => row.customerId === abSurvivorId),
  );
  await assertNoOrphans(raceAB.left.id === abSurvivorId ? raceAB.right.id : raceAB.left.id, "A+B vs B+A");

  console.log("\nCONCURRENT — A+B vs B+C (shared absorb B) with a count-2 barrier");
  const sharedEmail = `triangle-${randomUUID().slice(0, 8)}@example.com`;
  const customerA = await prisma.customer.create({
    data: { businessId: alpha.business.id, name: "Triangle A", email: sharedEmail, phone: "2395550188" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: alpha.business.id, name: "Triangle B", email: sharedEmail, phone: "2395550188" },
  });
  const customerC = await prisma.customer.create({
    data: { businessId: alpha.business.id, name: "Triangle C", email: sharedEmail, phone: "2395550188" },
  });
  const triangleA = await createLinkedRecords(alpha, customerA.id, "tri-a", { skipSoftRefs: true });
  const triangleB = await createLinkedRecords(alpha, customerB.id, "tri-b", { skipSoftRefs: true });
  const triangleC = await createLinkedRecords(alpha, customerC.id, "tri-c", { skipSoftRefs: true });
  const triangleBarrier = createCount2Barrier();
  const triangleClientA = createTestClient();
  const triangleClientC = createTestClient();
  const triangleHeld = mergeConfirmedCustomers(
    triangleClientA,
    alpha.owner,
    { keepCustomerId: customerA.id, absorbCustomerId: customerB.id, confirmedSameCustomer: true },
    { afterLocked: triangleBarrier.arrive },
  );
  const triangleHeldSettled = Promise.allSettled([triangleHeld]);
  await withTimeout(triangleBarrier.firstArrived, BARRIER_WAIT_MS, "A+B vs B+C entered write");
  const triangleContender = mergeConfirmedCustomers(
    triangleClientC,
    alpha.owner,
    { keepCustomerId: customerC.id, absorbCustomerId: customerB.id, confirmedSameCustomer: true },
  );
  const triangleContenderSettled = Promise.allSettled([triangleContender]);
  await releaseAfterLock(lockAdmin, triangleBarrier, "A+B vs B+C");
  const [triangleHeldResult] = await withTimeout(triangleHeldSettled, 25000, "A+B vs B+C held");
  const [triangleContenderResult] = await withTimeout(triangleContenderSettled, 25000, "A+B vs B+C contender");
  const triangleResults = [triangleHeldResult, triangleContenderResult];
  await Promise.all([disconnectClient(triangleClientA), disconnectClient(triangleClientC)]);
  const triangleWins = triangleResults.filter((result) => result.status === "fulfilled");
  const triangleLosses = triangleResults.filter((result) => result.status === "rejected");
  check("A+B vs B+C has exactly one winner", triangleWins.length === 1 && triangleLosses.length === 1);
  check(
    "A+B vs B+C loser is not-available",
    triangleLosses[0] &&
      triangleLosses[0].reason instanceof CustomerMergeError &&
      triangleLosses[0].reason.message === CUSTOMERS_NOT_AVAILABLE_MESSAGE,
  );
  const afterA = await prisma.customer.findUnique({ where: { id: customerA.id } });
  const afterB = await prisma.customer.findUnique({ where: { id: customerB.id } });
  const afterC = await prisma.customer.findUnique({ where: { id: customerC.id } });
  check("Shared absorb B is deleted exactly once", afterB === null);
  check("The third customer is not deleted", Boolean(afterA) && Boolean(afterC));
  const triangleJobs = await prisma.job.findMany({
    where: { id: { in: [triangleA.job.id, triangleB.job.id, triangleC.job.id] } },
  });
  check(
    "A+B vs B+C keeps every job on a living customer",
    triangleJobs.length === 3 &&
      triangleJobs.every((row) => row.customerId === customerA.id || row.customerId === customerC.id),
  );
  const triangleAssets = await prisma.storedAsset.findMany({
    where: { id: { in: [triangleA.asset.id, triangleB.asset.id, triangleC.asset.id] } },
  });
  check(
    "A+B vs B+C keeps every stored asset on a living customer",
    triangleAssets.length === 3 &&
      triangleAssets.every((row) => row.customerId === customerA.id || row.customerId === customerC.id),
  );
  await assertNoOrphans(customerB.id, "A+B vs B+C");

  console.log("\nCONCURRENT — merge vs customer edit with a count-2 barrier");
  const editPair = await seedPair("edit", `edit-${randomUUID().slice(0, 8)}@example.com`);
  const editBarrier = createCount2Barrier();
  const editMergeClient = createTestClient();
  const editClient = createTestClient();
  const editMergeP = mergeConfirmedCustomers(
    editMergeClient,
    alpha.owner,
    { keepCustomerId: editPair.left.id, absorbCustomerId: editPair.right.id, confirmedSameCustomer: true },
    { afterLocked: editBarrier.arrive },
  );
  const editMergeSettled = Promise.allSettled([editMergeP]);
  await withTimeout(editBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-edit entered write");
  const editP = editClient.customer.update({
    where: { id: editPair.right.id },
    data: { name: "Concurrent Edit" },
  });
  const editWriteSettled = Promise.allSettled([editP]);
  await releaseAfterLock(lockAdmin, editBarrier, "merge vs edit");
  const [editMergeResult] = await withTimeout(editMergeSettled, 25000, "merge vs edit merge");
  const [editWriteResult] = await withTimeout(editWriteSettled, 25000, "merge vs edit write");
  await Promise.all([disconnectClient(editMergeClient), disconnectClient(editClient)]);
  check("Merge vs edit: merge is the single winner", editMergeResult.status === "fulfilled");
  check(
    "Merge vs edit: edit loses with P2025",
    editWriteResult.status === "rejected" &&
      editWriteResult.reason instanceof Prisma.PrismaClientKnownRequestError &&
      editWriteResult.reason.code === "P2025",
  );
  check("Absorbed customer is gone after merge-versus-edit", (await prisma.customer.findUnique({ where: { id: editPair.right.id } })) === null);
  const editJobs = await prisma.job.findMany({
    where: { id: { in: [editPair.leftLinks.job.id, editPair.rightLinks.job.id] } },
  });
  check(
    "Merge vs edit does not lose jobs",
    editJobs.length === 2 && editJobs.every((row) => row.customerId === editPair.left.id),
  );
  await assertNoOrphans(editPair.right.id, "Merge vs edit");

  console.log("\nCONCURRENT — merge vs Job-alone on the absorbed customer");
  const jobPair = await seedPair("jobrace", `jobrace-${randomUUID().slice(0, 8)}@example.com`);
  const jobBarrier = createCount2Barrier();
  const jobMergeClient = createTestClient();
  const jobWriteClient = createTestClient();
  const jobMergeP = mergeConfirmedCustomers(
    jobMergeClient,
    alpha.owner,
    { keepCustomerId: jobPair.left.id, absorbCustomerId: jobPair.right.id, confirmedSameCustomer: true },
    { afterLocked: jobBarrier.arrive },
  );
  const jobMergeSettled = Promise.allSettled([jobMergeP]);
  await withTimeout(jobBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-job entered write");
  const jobCreateP = jobWriteClient.job.create({
    data: {
      businessId: alpha.business.id,
      customerId: jobPair.right.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const jobCreateSettled = Promise.allSettled([jobCreateP]);
  await releaseAfterLock(lockAdmin, jobBarrier, "merge vs Job");
  const [jobMergeResult] = await withTimeout(jobMergeSettled, 25000, "merge vs Job merge");
  const [jobCreateResult] = await withTimeout(jobCreateSettled, 25000, "merge vs Job insert");
  const jobRaceResults = [jobMergeResult, jobCreateResult];
  await Promise.all([disconnectClient(jobMergeClient), disconnectClient(jobWriteClient)]);
  check("Merge vs Job: merge is the single winner", jobRaceResults[0].status === "fulfilled");
  check(
    "Merge vs Job: job insert loses with P2003",
    jobRaceResults[1].status === "rejected" &&
      jobRaceResults[1].reason instanceof Prisma.PrismaClientKnownRequestError &&
      jobRaceResults[1].reason.code === "P2003",
  );
  check("Merge vs Job: absorbed customer is gone", (await prisma.customer.findUnique({ where: { id: jobPair.right.id } })) === null);
  const jobRaceJobs = await prisma.job.findMany({
    where: { id: { in: [jobPair.leftLinks.job.id, jobPair.rightLinks.job.id] } },
  });
  check(
    "Merge vs Job does not lose the original jobs",
    jobRaceJobs.length === 2 && jobRaceJobs.every((row) => row.customerId === jobPair.left.id),
  );
  await assertNoOrphans(jobPair.right.id, "Merge vs Job");

  console.log("\nCONCURRENT — merge vs StoredAsset-alone on the absorbed customer");
  const assetPair = await seedPair("assetrace", `assetrace-${randomUUID().slice(0, 8)}@example.com`);
  const assetBarrier = createCount2Barrier();
  const assetMergeClient = createTestClient();
  const assetWriteClient = createTestClient();
  const assetMergeP = mergeConfirmedCustomers(
    assetMergeClient,
    alpha.owner,
    { keepCustomerId: assetPair.left.id, absorbCustomerId: assetPair.right.id, confirmedSameCustomer: true },
    { afterLocked: assetBarrier.arrive },
  );
  const assetMergeSettled = Promise.allSettled([assetMergeP]);
  await withTimeout(assetBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-asset entered write");
  const assetCountBefore = await prisma.storedAsset.count({
    where: { businessId: alpha.business.id, customerId: assetPair.right.id },
  });
  const assetUploadP = authorizeManagedUpload(
    {
      db: assetWriteClient,
      provider: memoryStorageProvider(),
      bucketName: alpha.storage.bucketName,
    },
    alpha.business.id,
    {
      category: "CUSTOMER_PHOTO",
      originalFilename: "race.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 64,
      visibility: "PRIVATE",
      customerId: assetPair.right.id,
    },
  );
  const assetUploadSettled = Promise.allSettled([assetUploadP]);
  await releaseAfterLock(lockAdmin, assetBarrier, "merge vs StoredAsset");
  const [assetMergeResult] = await withTimeout(assetMergeSettled, 25000, "merge vs StoredAsset merge");
  const [assetUploadResult] = await withTimeout(assetUploadSettled, 25000, "merge vs StoredAsset upload");
  const assetRaceResults = [assetMergeResult, assetUploadResult];
  await Promise.all([disconnectClient(assetMergeClient), disconnectClient(assetWriteClient)]);
  check("Merge vs StoredAsset: merge is the single winner", assetRaceResults[0].status === "fulfilled");
  check(
    "Merge vs StoredAsset: upload loses because the customer row is gone",
    assetRaceResults[1].status === "rejected" &&
      assetRaceResults[1].reason instanceof StorageAccessError &&
      assetRaceResults[1].reason.message === "That customer is not available.",
  );
  check(
    "Merge vs StoredAsset: absorbed customer is gone",
    (await prisma.customer.findUnique({ where: { id: assetPair.right.id } })) === null,
  );
  check(
    "Merge vs StoredAsset: no dangling upload row",
    (await prisma.storedAsset.count({
      where: { businessId: alpha.business.id, originalFilename: "race.jpg" },
    })) === 0,
  );
  const movedAssets = await prisma.storedAsset.findMany({
    where: { id: { in: [assetPair.leftLinks.asset.id, assetPair.rightLinks.asset.id] } },
  });
  check(
    "Merge vs StoredAsset remaps the original assets",
    movedAssets.length === 2 &&
      movedAssets.every((row) => row.customerId === assetPair.left.id) &&
      assetCountBefore === 1,
  );
  await assertNoOrphans(assetPair.right.id, "Merge vs StoredAsset");

  console.log("\nCONCURRENT — reverse-order upload then merge");
  const reversePair = await seedPair("reverse", `reverse-${randomUUID().slice(0, 8)}@example.com`);
  const reverseBarrier = createCount2Barrier();
  const reverseUploadClient = createTestClient();
  const reverseMergeClient = createTestClient();
  const reverseUploadP = reverseUploadClient.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id FROM "Customer"
        WHERE id = ${reversePair.right.id} AND "businessId" = ${alpha.business.id}
        FOR KEY SHARE
      `;
      if (locked.length === 0) {
        throw new Error("reverse-order upload could not key-share the absorbed customer");
      }
      const created = await tx.storedAsset.create({
        data: {
          businessId: alpha.business.id,
          storageAccountId: alpha.storage.id,
          customerId: reversePair.right.id,
          category: "CUSTOMER_PHOTO",
          originalFilename: "reverse-race.jpg",
          storageKey: `reverse-${randomUUID()}`,
          mimeType: "image/jpeg",
          fileSizeBytes: 32,
        },
      });
      await reverseBarrier.arrive();
      return created;
    },
    { timeout: 25_000, maxWait: 10_000 },
  );
  const reverseUploadSettled = Promise.allSettled([reverseUploadP]);
  await withTimeout(reverseBarrier.firstArrived, BARRIER_WAIT_MS, "reverse-order upload entered write");
  const reverseMergeP = mergeConfirmedCustomers(reverseMergeClient, alpha.owner, {
    keepCustomerId: reversePair.left.id,
    absorbCustomerId: reversePair.right.id,
    confirmedSameCustomer: true,
  });
  const reverseMergeSettled = Promise.allSettled([reverseMergeP]);
  try {
    await waitForTestDbLock(lockAdmin, "reverse-order merge");
  } finally {
    await reverseBarrier.arrive();
  }
  const [reverseUploadResult] = await withTimeout(reverseUploadSettled, 25000, "reverse-order upload");
  const [reverseMergeResult] = await withTimeout(reverseMergeSettled, 25000, "reverse-order merge");
  await Promise.all([disconnectClient(reverseUploadClient), disconnectClient(reverseMergeClient)]);
  check("Reverse-order upload committed", reverseUploadResult.status === "fulfilled");
  const reverseMergeOk =
    reverseMergeResult.status === "fulfilled" ||
    (reverseMergeResult.status === "rejected" &&
      reverseMergeResult.reason instanceof CustomerMergeError &&
      reverseMergeResult.reason.message === MERGE_TRY_AGAIN_MESSAGE);
  check("Reverse-order merge remaps the new asset or asks to try again", reverseMergeOk);
  const reverseLeftoverAssets = await prisma.storedAsset.findMany({
    where: { customerId: reversePair.right.id },
  });
  check("Reverse-order leaves no StoredAsset on the absorbed id", reverseLeftoverAssets.length === 0);
  if (reverseMergeResult.status === "fulfilled" && reverseUploadResult.status === "fulfilled") {
    const reverseMoved = await prisma.storedAsset.findUnique({
      where: { id: reverseUploadResult.value.id },
    });
    check(
      "Reverse-order moves the raced asset onto the survivor",
      reverseMoved?.customerId === reversePair.left.id,
    );
    check(
      "Reverse-order deletes the absorbed customer",
      (await prisma.customer.findUnique({ where: { id: reversePair.right.id } })) === null,
    );
  }
  await assertNoOrphans(reversePair.right.id, "Reverse-order upload then merge");

  console.log("\nCONCURRENT — merge vs inbound STOP on the absorbed phone");
  const stopEmail = `stop-${randomUUID().slice(0, 8)}@example.com`;
  const stopPhone = "2395550177";
  const stopTo = "2395550180";
  await prisma.business.update({
    where: { id: alpha.business.id },
    data: { operationalSmsNumber: stopTo },
  });
  const stopKeep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Stop Keep",
      email: stopEmail,
      phone: null,
      smsConsentStatus: "GRANTED",
    },
  });
  const stopAbsorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Stop Absorb",
      email: stopEmail,
      phone: stopPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const stopBarrier = createCount2Barrier();
  const stopMergeClient = createTestClient();
  const stopInboundClient = createTestClient();
  const stopMergeP = mergeConfirmedCustomers(
    stopMergeClient,
    alpha.owner,
    { keepCustomerId: stopKeep.id, absorbCustomerId: stopAbsorb.id, confirmedSameCustomer: true },
    { afterLocked: stopBarrier.arrive },
  );
  const stopMergeSettled = Promise.allSettled([stopMergeP]);
  await withTimeout(stopBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-STOP entered write");
  const stopInboundP = applyInboundConsentEvent(stopInboundClient, {
    provider: "twilio",
    providerEventId: `SM_merge_stop_${randomUUID()}`,
    from: `+1${stopPhone}`,
    to: `+1${stopTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  const stopInboundSettled = Promise.allSettled([stopInboundP]);
  await releaseAfterLock(lockAdmin, stopBarrier, "merge vs inbound STOP");
  const [stopMergeResult] = await withTimeout(stopMergeSettled, 25000, "merge vs STOP merge");
  const [stopInboundResult] = await withTimeout(stopInboundSettled, 25000, "merge vs STOP inbound");
  await Promise.all([disconnectClient(stopMergeClient), disconnectClient(stopInboundClient)]);
  check("Merge vs STOP: merge succeeds", stopMergeResult.status === "fulfilled");
  check(
    "Merge vs STOP: result is revoked on the survivor",
    stopInboundResult.status === "fulfilled" &&
      stopInboundResult.value.applied === true &&
      stopInboundResult.value.reason === "revoked" &&
      stopInboundResult.value.consentStatus === "REVOKED" &&
      stopInboundResult.value.customerId === stopKeep.id,
  );
  const stopSurvivor = await prisma.customer.findUnique({ where: { id: stopKeep.id } });
  check("Merge vs STOP: survivor is REVOKED", stopSurvivor?.smsConsentStatus === "REVOKED");
  check(
    "Merge vs STOP: absorbed customer is gone",
    (await prisma.customer.findUnique({ where: { id: stopAbsorb.id } })) === null,
  );
  await assertNoOrphans(stopAbsorb.id, "Merge vs STOP");

  console.log("\nCONCURRENT — merge vs inbound START from the absorbed phone");
  const startEmail = `start-${randomUUID().slice(0, 8)}@example.com`;
  const startKeepPhone = "2395550182";
  const startAbsorbPhone = "2395550183";
  const startKeep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Start Keep",
      email: startEmail,
      phone: startKeepPhone,
      smsConsentStatus: "REVOKED",
    },
  });
  const startAbsorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Start Absorb",
      email: startEmail,
      phone: startAbsorbPhone,
      smsConsentStatus: "REVOKED",
    },
  });
  const startBarrier = createCount2Barrier();
  const startMergeClient = createTestClient();
  const startInboundClient = createTestClient();
  const startMergeP = mergeConfirmedCustomers(
    startMergeClient,
    alpha.owner,
    { keepCustomerId: startKeep.id, absorbCustomerId: startAbsorb.id, confirmedSameCustomer: true },
    { afterLocked: startBarrier.arrive },
  );
  const startMergeSettled = Promise.allSettled([startMergeP]);
  await withTimeout(startBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-START entered write");
  const startInboundP = applyInboundConsentEvent(startInboundClient, {
    provider: "twilio",
    providerEventId: `SM_merge_start_${randomUUID()}`,
    from: `+1${startAbsorbPhone}`,
    to: `+1${stopTo}`,
    body: "START",
    optOutType: "START",
  });
  const startInboundSettled = Promise.allSettled([startInboundP]);
  await releaseAfterLock(lockAdmin, startBarrier, "merge vs inbound START");
  const [startMergeResult] = await withTimeout(startMergeSettled, 25000, "merge vs START merge");
  const [startInboundResult] = await withTimeout(startInboundSettled, 25000, "merge vs START inbound");
  await Promise.all([disconnectClient(startMergeClient), disconnectClient(startInboundClient)]);
  check("Merge vs START: merge succeeds", startMergeResult.status === "fulfilled");
  check(
    "Merge vs START: result is start_not_applicable",
    startInboundResult.status === "fulfilled" &&
      startInboundResult.value.applied === false &&
      startInboundResult.value.reason === "start_not_applicable",
  );
  const startSurvivor = await prisma.customer.findUnique({ where: { id: startKeep.id } });
  check("Merge vs START: survivor stays REVOKED", startSurvivor?.smsConsentStatus === "REVOKED");
  check(
    "Merge vs START: absorbed customer is gone",
    (await prisma.customer.findUnique({ where: { id: startAbsorb.id } })) === null,
  );
  await assertNoOrphans(startAbsorb.id, "Merge vs START");

  console.log("\nERROR — failed consent write leaves a pending webhook row");
  const failPhone = "2395550184";
  await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Consent Write Fail",
      phone: failPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const failEventId = `SM_consent_fail_${randomUUID()}`;
  const forcedWriteError = new Error("forced consent write failure");
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    throw forcedWriteError;
  };
  const failSettled = await Promise.allSettled([
    applyInboundConsentEvent(prisma, {
      provider: "twilio",
      providerEventId: failEventId,
      from: `+1${failPhone}`,
      to: `+1${stopTo}`,
      body: "STOP",
      optOutType: "STOP",
    }),
  ]);
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  check(
    "Failed consent write rejects applyInboundConsentEvent",
    failSettled[0].status === "rejected" && failSettled[0].reason === forcedWriteError,
  );
  check(
    "Failed consent write leaves the pending webhook row retryable",
    (await prisma.customerMessagingWebhookEvent.count({
      where: { provider: "twilio", providerEventId: failEventId },
    })) === 1,
  );

  console.log("\nPOST-MERGE — STOP from the absorbed customer's former phone");
  const formerEmail = `former-${randomUUID().slice(0, 8)}@example.com`;
  const keepPhone = "2395550191";
  const absorbPhone = "2395550192";
  const formerTo = "2395550190";
  const otherBizTo = "2395550193";
  await prisma.business.update({
    where: { id: alpha.business.id },
    data: { operationalSmsNumber: formerTo },
  });
  await prisma.business.update({
    where: { id: beta.business.id },
    data: { operationalSmsNumber: otherBizTo },
  });
  const formerKeep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Former Keep",
      email: formerEmail,
      phone: keepPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const formerAbsorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Former Absorb",
      email: formerEmail,
      phone: absorbPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const otherBizSamePhone = await prisma.customer.create({
    data: {
      businessId: beta.business.id,
      name: "Other Biz Same Phone",
      phone: absorbPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const mergeFormer = await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: formerKeep.id,
    absorbCustomerId: formerAbsorb.id,
    confirmedSameCustomer: true,
  });
  check("Post-merge of different phones keeps the survivor", mergeFormer.survivorId === formerKeep.id);
  const survivorAfterMerge = await prisma.customer.findUnique({ where: { id: formerKeep.id } });
  check(
    "Survivor kept its own non-null phone",
    survivorAfterMerge?.phone === keepPhone && survivorAfterMerge?.smsConsentStatus === "GRANTED",
  );
  check("Absorbed former phone is gone as a live customer", (await prisma.customer.findUnique({ where: { id: formerAbsorb.id } })) === null);

  const postMergeStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_former_stop_${randomUUID()}`,
    from: `+1${absorbPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  const survivorAfterStop = await prisma.customer.findUnique({ where: { id: formerKeep.id } });
  const otherBizAfterStop = await prisma.customer.findUnique({ where: { id: otherBizSamePhone.id } });
  check(
    "Post-merge STOP from the absorbed former phone revokes the survivor",
    postMergeStop.applied === true &&
      postMergeStop.reason === "revoked" &&
      postMergeStop.consentStatus === "REVOKED" &&
      postMergeStop.customerId === formerKeep.id &&
      survivorAfterStop?.smsConsentStatus === "REVOKED",
  );
  check(
    "Another business using the same former phone stays GRANTED",
    otherBizAfterStop?.smsConsentStatus === "GRANTED",
  );
  const postMergeStart = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_former_start_${randomUUID()}`,
    from: `+1${absorbPhone}`,
    to: `+1${formerTo}`,
    body: "START",
    optOutType: "START",
  });
  check(
    "START from a former absorbed phone stays conservative",
    postMergeStart.applied === false &&
      postMergeStart.reason === "unknown_customer" &&
      (await prisma.customer.findUnique({ where: { id: formerKeep.id } }))?.smsConsentStatus === "REVOKED",
  );

  const ambiguousEmailA = `amb-a-${randomUUID().slice(0, 8)}@example.com`;
  const ambiguousEmailB = `amb-b-${randomUUID().slice(0, 8)}@example.com`;
  const ambiguousPhone = "2395550194";
  const ambKeepA = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ambiguous Keep A",
      email: ambiguousEmailA,
      phone: "2395550195",
      smsConsentStatus: "GRANTED",
    },
  });
  const ambAbsorbA = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ambiguous Absorb A",
      email: ambiguousEmailA,
      phone: ambiguousPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: ambKeepA.id,
    absorbCustomerId: ambAbsorbA.id,
    confirmedSameCustomer: true,
  });
  const ambKeepB = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ambiguous Keep B",
      email: ambiguousEmailB,
      phone: "2395550196",
      smsConsentStatus: "GRANTED",
    },
  });
  const ambAbsorbB = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ambiguous Absorb B",
      email: ambiguousEmailB,
      phone: ambiguousPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: ambKeepB.id,
    absorbCustomerId: ambAbsorbB.id,
    confirmedSameCustomer: true,
  });
  const ambiguousStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_former_ambiguous_${randomUUID()}`,
    from: `+1${ambiguousPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  check(
    "Ambiguous absorbed former phone does not revoke either survivor",
    ambiguousStop.applied === false &&
      ambiguousStop.reason === "ambiguous_customer" &&
      (await prisma.customer.findUnique({ where: { id: ambKeepA.id } }))?.smsConsentStatus === "GRANTED" &&
      (await prisma.customer.findUnique({ where: { id: ambKeepB.id } }))?.smsConsentStatus === "GRANTED",
  );

  console.log("\nPOST-MERGE — chained hops, normalization, changed survivor phone, concurrent STOP");
  const chainEmail = `chain-${randomUUID().slice(0, 8)}@example.com`;
  const chainA = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Chain A",
      email: chainEmail,
      phone: "2395550210",
      smsConsentStatus: "GRANTED",
    },
  });
  const chainB = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Chain B",
      email: chainEmail,
      phone: "2395550211",
      smsConsentStatus: "GRANTED",
    },
  });
  await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: chainB.id,
    absorbCustomerId: chainA.id,
    confirmedSameCustomer: true,
  });
  const chainC = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Chain C",
      email: chainEmail,
      phone: "2395550212",
      smsConsentStatus: "GRANTED",
    },
  });
  await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: chainC.id,
    absorbCustomerId: chainB.id,
    confirmedSameCustomer: true,
  });
  const beforeChainStop = await prisma.customer.findUnique({ where: { id: chainC.id } });
  const chainStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_chain_stop_${randomUUID()}`,
    from: "+1 (239) 555-0210",
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  const chainAfterStop = await prisma.customer.findUnique({ where: { id: chainC.id } });
  check(
    "Chained A-into-B-into-C STOP from A's former phone revokes C",
    chainStop.applied === true &&
      chainStop.reason === "revoked" &&
      chainStop.customerId === chainC.id &&
      chainAfterStop?.smsConsentStatus === "REVOKED",
  );
  check(
    "Chained STOP writes a tenant-scoped survivor consent timestamp",
    chainAfterStop?.smsConsentUpdatedAt instanceof Date &&
      (beforeChainStop?.smsConsentUpdatedAt == null ||
        chainAfterStop.smsConsentUpdatedAt.getTime() >=
          beforeChainStop.smsConsentUpdatedAt.getTime()),
  );

  const formattedAbsorbPhone = "(239) 555-0213";
  const formattedEmail = `fmt-${randomUUID().slice(0, 8)}@example.com`;
  const formattedKeep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Formatted Keep",
      email: formattedEmail,
      phone: "2395550214",
      smsConsentStatus: "GRANTED",
    },
  });
  const formattedAbsorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Formatted Absorb",
      email: formattedEmail,
      phone: formattedAbsorbPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: formattedKeep.id,
    absorbCustomerId: formattedAbsorb.id,
    confirmedSameCustomer: true,
  });
  const formattedStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_formatted_stop_${randomUUID()}`,
    from: "+12395550213",
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  check(
    "Normalized STOP from a formatted absorbed phone revokes the survivor",
    formattedStop.applied === true &&
      formattedStop.customerId === formattedKeep.id &&
      (await prisma.customer.findUnique({ where: { id: formattedKeep.id } }))?.smsConsentStatus ===
        "REVOKED",
  );

  const changedEmail = `changed-${randomUUID().slice(0, 8)}@example.com`;
  const changedKeep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Changed Keep",
      email: changedEmail,
      phone: "2395550215",
      smsConsentStatus: "GRANTED",
    },
  });
  const changedAbsorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Changed Absorb",
      email: changedEmail,
      phone: "2395550216",
      smsConsentStatus: "GRANTED",
    },
  });
  await mergeConfirmedCustomers(prisma, alpha.owner, {
    keepCustomerId: changedKeep.id,
    absorbCustomerId: changedAbsorb.id,
    confirmedSameCustomer: true,
  });
  await prisma.customer.update({
    where: { id: changedKeep.id },
    data: { phone: "2395550217" },
  });
  const changedStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_changed_phone_stop_${randomUUID()}`,
    from: "+12395550216",
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  check(
    "STOP still revokes after the survivor's live phone later changed",
    changedStop.applied === true &&
      changedStop.customerId === changedKeep.id &&
      (await prisma.customer.findUnique({ where: { id: changedKeep.id } }))?.phone === "2395550217" &&
      (await prisma.customer.findUnique({ where: { id: changedKeep.id } }))?.smsConsentStatus ===
        "REVOKED",
  );

  const raceEmail = `race-${randomUUID().slice(0, 8)}@example.com`;
  const raceKeepPhone = "2395550220";
  const raceAbsorbPhone = "2395550221";
  const raceKeep = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Race Keep",
      email: raceEmail,
      phone: raceKeepPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const raceAbsorb = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Race Absorb",
      email: raceEmail,
      phone: raceAbsorbPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const raceBarrier = createCount2Barrier();
  const raceMergeClient = createTestClient();
  const raceInboundClient = createTestClient();
  const raceMergeP = mergeConfirmedCustomers(
    raceMergeClient,
    alpha.owner,
    { keepCustomerId: raceKeep.id, absorbCustomerId: raceAbsorb.id, confirmedSameCustomer: true },
    { afterLocked: raceBarrier.arrive },
  );
  const raceMergeSettled = Promise.allSettled([raceMergeP]);
  await withTimeout(raceBarrier.firstArrived, BARRIER_WAIT_MS, "distinct-phone merge-versus-STOP entered write");
  const raceInboundP = applyInboundConsentEvent(raceInboundClient, {
    provider: "twilio",
    providerEventId: `SM_race_former_stop_${randomUUID()}`,
    from: `+1${raceAbsorbPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  const raceInboundSettled = Promise.allSettled([raceInboundP]);
  await releaseAfterLock(lockAdmin, raceBarrier, "distinct-phone merge vs inbound STOP");
  const [raceMergeResult] = await withTimeout(raceMergeSettled, 25000, "distinct-phone merge vs STOP merge");
  const [raceInboundResult] = await withTimeout(raceInboundSettled, 25000, "distinct-phone merge vs STOP inbound");
  await Promise.all([disconnectClient(raceMergeClient), disconnectClient(raceInboundClient)]);
  const raceSurvivor = await prisma.customer.findUnique({ where: { id: raceKeep.id } });
  check("Distinct-phone merge vs STOP: merge succeeds", raceMergeResult.status === "fulfilled");
  check(
    "Distinct-phone merge vs STOP: survivor is REVOKED",
    raceSurvivor?.smsConsentStatus === "REVOKED" && raceSurvivor?.phone === raceKeepPhone,
  );
  check(
    "Distinct-phone merge vs STOP: absorbed customer is gone",
    (await prisma.customer.findUnique({ where: { id: raceAbsorb.id } })) === null,
  );

  console.log("\nERROR — leftover webhook claim stays retryable after cleanup failure");
  const leftoverPhone = "2395550197";
  const leftoverCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Leftover Claim",
      phone: leftoverPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const leftoverEventId = `SM_leftover_claim_${randomUUID()}`;
  const leftoverWriteError = new Error("forced leftover consent write failure");
  const leftoverCleanupError = new Error("forced leftover cleanup failure");
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    throw leftoverWriteError;
  };
  inboundConsentTestHooks.beforeCleanup = async () => {
    throw leftoverCleanupError;
  };
  const leftoverFirst = await Promise.allSettled([
    applyInboundConsentEvent(prisma, {
      provider: "twilio",
      providerEventId: leftoverEventId,
      from: `+1${leftoverPhone}`,
      to: `+1${formerTo}`,
      body: "STOP",
      optOutType: "STOP",
    }),
  ]);
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  inboundConsentTestHooks.beforeCleanup = undefined;
  check(
    "Consent write plus cleanup failure rejects the first STOP",
    leftoverFirst[0].status === "rejected" && leftoverFirst[0].reason === leftoverWriteError,
  );
  check(
    "Leftover webhook claim remains after cleanup failure",
    (await prisma.customerMessagingWebhookEvent.count({
      where: { provider: "twilio", providerEventId: leftoverEventId },
    })) === 1,
  );
  check(
    "Leftover claim did not revoke consent",
    (await prisma.customer.findUnique({ where: { id: leftoverCustomer.id } }))?.smsConsentStatus === "GRANTED",
  );
  const leftoverRetry = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: leftoverEventId,
    from: `+1${leftoverPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  const leftoverAfterRetry = await prisma.customer.findUnique({ where: { id: leftoverCustomer.id } });
  check(
    "Retry of the leftover STOP applies REVOKED exactly once",
    leftoverRetry.applied === true &&
      leftoverRetry.reason === "revoked" &&
      leftoverRetry.consentStatus === "REVOKED" &&
      leftoverRetry.customerId === leftoverCustomer.id &&
      leftoverAfterRetry?.smsConsentStatus === "REVOKED",
  );
  const leftoverThird = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: leftoverEventId,
    from: `+1${leftoverPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  check(
    "A third leftover STOP is idempotent and stays REVOKED",
    leftoverThird.applied === true &&
      leftoverThird.reason === "idempotent" &&
      (await prisma.customer.findUnique({ where: { id: leftoverCustomer.id } }))?.smsConsentStatus ===
        "REVOKED",
  );

  console.log("\nERROR — stuck START cannot resurrect consent after a newer STOP");
  const staleStartPhone = "2395550228";
  const staleStartCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Stale Start Merge",
      phone: staleStartPhone,
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  const staleStartEventId = `SM_stale_start_${randomUUID()}`;
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    throw new Error("forced stale START write failure");
  };
  const staleStartFirst = await Promise.allSettled([
    applyInboundConsentEvent(prisma, {
      provider: "twilio",
      providerEventId: staleStartEventId,
      from: `+1${staleStartPhone}`,
      to: `+1${formerTo}`,
      body: "START",
      optOutType: "START",
    }),
  ]);
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  check(
    "Stuck START rejects and stays REVOKED",
    staleStartFirst[0].status === "rejected" &&
      (await prisma.customer.findUnique({ where: { id: staleStartCustomer.id } }))?.smsConsentStatus ===
        "REVOKED",
  );
  const newerStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_newer_stop_${randomUUID()}`,
    from: `+1${staleStartPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  check(
    "Newer STOP after stuck START is applied",
    newerStop.applied === true && newerStop.consentStatus === "REVOKED",
  );
  const staleStartRetry = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: staleStartEventId,
    from: `+1${staleStartPhone}`,
    to: `+1${formerTo}`,
    body: "START",
    optOutType: "START",
  });
  check(
    "Older START retry after newer STOP stays REVOKED",
    staleStartRetry.applied === false &&
      staleStartRetry.reason === "stale_event" &&
      (await prisma.customer.findUnique({ where: { id: staleStartCustomer.id } }))?.smsConsentStatus ===
        "REVOKED",
  );

  console.log("\nERROR — overlapping newer STOP wins over in-flight START");
  const overlapPhone = "2395550229";
  const overlapCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Overlap Merge Start",
      phone: overlapPhone,
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  let overlapWrites = 0;
  let overlapStartAtWrite;
  const overlapStartHeld = new Promise((resolve) => {
    overlapStartAtWrite = resolve;
  });
  let releaseOverlapStart;
  const overlapStartHold = new Promise((resolve) => {
    releaseOverlapStart = resolve;
  });
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    overlapWrites += 1;
    if (overlapWrites === 1) {
      overlapStartAtWrite();
      await withTimeout(overlapStartHold, BARRIER_WAIT_MS, "merge overlap START hold");
    }
  };
  const overlapStartClient = createTestClient();
  const overlapStopClient = createTestClient();
  const overlapStartSettled = Promise.allSettled([
    applyInboundConsentEvent(overlapStartClient, {
      provider: "twilio",
      providerEventId: `SM_merge_overlap_start_${randomUUID()}`,
      from: `+1${overlapPhone}`,
      to: `+1${formerTo}`,
      body: "START",
      optOutType: "START",
    }),
  ]);
  await withTimeout(overlapStartHeld, BARRIER_WAIT_MS, "merge overlap START reached write");
  const overlapStop = await applyInboundConsentEvent(overlapStopClient, {
    provider: "twilio",
    providerEventId: `SM_merge_overlap_stop_${randomUUID()}`,
    from: `+1${overlapPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  releaseOverlapStart();
  const [overlapStartResult] = await withTimeout(overlapStartSettled, 25000, "merge overlap START");
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  await Promise.all([disconnectClient(overlapStartClient), disconnectClient(overlapStopClient)]);
  check(
    "Merge overlap: newer STOP commits while START is in-flight",
    overlapStop.applied === true && overlapStop.consentStatus === "REVOKED",
  );
  check(
    "Merge overlap: in-flight START is stale_event and stays REVOKED",
    overlapStartResult.status === "fulfilled" &&
      overlapStartResult.value.reason === "stale_event" &&
      (await prisma.customer.findUnique({ where: { id: overlapCustomer.id } }))?.smsConsentStatus ===
        "REVOKED",
  );

  console.log("\nERROR — consent transaction rollback keeps original START claim");
  const rollbackPhone = "2395550230";
  const rollbackCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Rollback Merge Start",
      phone: rollbackPhone,
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  const rollbackStartId = `SM_merge_rollback_start_${randomUUID()}`;
  let rollbackClaimed;
  const rollbackClaimReady = new Promise((resolve) => {
    rollbackClaimed = resolve;
  });
  let releaseRollbackClaim;
  const rollbackClaimHold = new Promise((resolve) => {
    releaseRollbackClaim = resolve;
  });
  inboundConsentTestHooks.afterClaim = async () => {
    rollbackClaimed();
    await withTimeout(rollbackClaimHold, BARRIER_WAIT_MS, "merge rollback claim hold");
  };
  inboundConsentTestHooks.beforeConsentWrite = async (ctx) => {
    if (!ctx?.db) throw new Error("consent write hook missing db");
    await ctx.db.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION 'consent_tx_killed'; END $$`);
  };
  const rollbackFirst = Promise.allSettled([
    applyInboundConsentEvent(prisma, {
      provider: "twilio",
      providerEventId: rollbackStartId,
      from: `+1${rollbackPhone}`,
      to: `+1${formerTo}`,
      body: "START",
      optOutType: "START",
    }),
  ]);
  await withTimeout(rollbackClaimReady, BARRIER_WAIT_MS, "merge rollback START claim committed");
  const rollbackClaimDuring = await prisma.customerMessagingWebhookEvent.findFirst({
    where: { provider: "twilio", providerEventId: rollbackStartId },
  });
  releaseRollbackClaim();
  const [rollbackSettled] = await withTimeout(rollbackFirst, 25000, "merge rollback START");
  inboundConsentTestHooks.afterClaim = undefined;
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  const rollbackClaim = await prisma.customerMessagingWebhookEvent.findFirst({
    where: { provider: "twilio", providerEventId: rollbackStartId },
  });
  check(
    "Merge rollback: pending START claim survives the aborted consent transaction",
    rollbackSettled.status === "rejected" &&
      rollbackClaimDuring != null &&
      rollbackClaim != null &&
      rollbackClaim.id === rollbackClaimDuring.id &&
      claimedAtFromCuid(rollbackClaim.id) instanceof Date,
  );
  await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_merge_rollback_stop_${randomUUID()}`,
    from: `+1${rollbackPhone}`,
    to: `+1${formerTo}`,
    body: "STOP",
    optOutType: "STOP",
  });
  const rollbackRetry = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: rollbackStartId,
    from: `+1${rollbackPhone}`,
    to: `+1${formerTo}`,
    body: "START",
    optOutType: "START",
  });
  check(
    "Merge rollback: retry after newer STOP stays REVOKED",
    rollbackRetry.reason === "stale_event" &&
      (await prisma.customer.findUnique({ where: { id: rollbackCustomer.id } }))?.smsConsentStatus ===
        "REVOKED",
  );

  if (failures === 0) {
    console.log("\nMUTATION — drop InvoiceCredit reassign spec and show the merge test fail");
    const opsPath = join(root, "src/lib/customer-merge-ops.ts");
    const original = readFileSync(opsPath, "utf8");
    const find =
      '  { kind: "updateMany", model: "InvoiceCredit", delegate: "invoiceCredit", field: "customerId", relation: "invoiceCredits" },\n';
    if (!original.includes(find)) {
      check("mutation invoice-credit-reassign found its target", false);
    } else {
      writeFileSync(opsPath, original.replace(find, ""));
      try {
        const child = spawnSync(
          process.execPath,
          ["--experimental-strip-types", fileURLToPath(import.meta.url), "--mutation", "invoice-credit-reassign"],
          {
            encoding: "utf8",
            env: { ...process.env, DATABASE_URL: testUrl, TZ: "America/New_York" },
          },
        );
        check(
          "mutation invoice-credit-reassign makes the matching test fail",
          child.status !== 0,
        );
        if (child.status === 0) {
          console.error(child.stdout);
          console.error(child.stderr);
        }
      } finally {
        writeFileSync(opsPath, original);
      }
    }
  }
  }
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  inboundConsentTestHooks.afterClaim = undefined;
  inboundConsentTestHooks.afterCustomerLock = undefined;
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  inboundConsentTestHooks.beforeCleanup = undefined;
  for (const client of extraClients) {
    try {
      await client.$disconnect();
    } catch {
      /* ignore */
    }
  }
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }
  if (dbCreated) {
    const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
    try {
      await terminateAndDrop(cleanup, testDbName);
    } catch (error) {
      console.error("Failed to drop customer-merge test database", error);
      failures += 1;
    } finally {
      await cleanup.$disconnect();
    }
  }
}

if (failures > 0) {
  console.error(`\ncustomer-merge check failed: ${failures} failure(s)`);
  process.exit(1);
}

console.log("\ncustomer-merge check passed.");
