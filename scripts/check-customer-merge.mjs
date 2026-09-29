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
import { readFileSync } from "node:fs";
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
  loadDuplicateReview,
  loadOwnedMergePair,
  loadPossibleDuplicatesForCustomer,
  mergeConfirmedCustomers,
  REASSIGNED_CUSTOMER_RELATION_FIELDS,
} = await import("@/lib/customer-merge-ops");
const { authorizeManagedUpload } = await import("@/lib/business-storage/service");
const { StorageAccessError } = await import("@/lib/business-storage/types");

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
      SELECT pid, wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE datname = ${testDbName}
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label}: timed out waiting for wait_event_type=Lock on ${testDbName}`);
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
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
}

let dbCreated = false;
const extraClients = [];
let prisma;

function createTestClient() {
  const client = new PrismaClient({ datasourceUrl: testUrl });
  extraClients.push(client);
  return client;
}

try {
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
    "Ops require OWNER and lock both customers in one serializable transaction",
    opsSrc.includes('requireBusinessRole(access, "OWNER")') &&
      opsSrc.includes("FOR UPDATE") &&
      opsSrc.includes("Serializable"),
  );
  check(
    "Merge remaps jobs, estimates, invoices, properties, and communications",
    opsSrc.includes("tx.job.updateMany") &&
      opsSrc.includes("tx.estimate.updateMany") &&
      opsSrc.includes("tx.invoice.updateMany") &&
      opsSrc.includes("tx.property.updateMany") &&
      opsSrc.includes("tx.customerCommunication.updateMany"),
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
      opsSrc.includes('path: ["customerId"]'),
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
    "Upload-create takes FOR KEY SHARE on the customer before inserting a StoredAsset",
    readSrc("src/lib/business-storage/service.ts").includes("FOR KEY SHARE") &&
      readSrc("src/lib/business-storage/service.ts").includes('SELECT id FROM "Customer"'),
  );
  check(
    "This harness refuses non-localhost hosts before connect or push",
    testSrc.includes("assertLocalDatabaseUrl") &&
      testSrc.indexOf("assertLocalDatabaseUrl(baseUrl") < testSrc.indexOf("CREATE DATABASE") &&
      testSrc.indexOf("assertLocalDatabaseUrl(baseUrl") < testSrc.indexOf('db", "push"'),
  );

  const dmmfRelations = customerListRelationsFromDmmf(Prisma.dmmf);
  const missingRelations = dmmfRelations.filter(
    (name) => !REASSIGNED_CUSTOMER_RELATION_FIELDS.includes(name),
  );
  check(
    "DMMF Customer relations are all handled in reassignCustomerId",
    missingRelations.length === 0 &&
      REASSIGNED_CUSTOMER_RELATION_FIELDS.every((name) => dmmfRelations.includes(name)),
  );
  if (missingRelations.length > 0) {
    console.error(`  missing DMMF relations: ${missingRelations.join(", ")}`);
  }
  const reassignSrc = opsSrc.slice(
    opsSrc.indexOf("async function reassignCustomerId"),
    opsSrc.indexOf("async function assertNoLeftoverCustomerReferences"),
  );
  const relationTokens = {
    properties: "tx.property.updateMany",
    serviceRequests: "tx.serviceRequest.updateMany",
    estimates: "tx.estimate.updateMany",
    jobs: "tx.job.updateMany",
    invoices: "tx.invoice.updateMany",
    payments: "tx.payment.updateMany",
    expenses: "tx.expense.updateMany",
    reviewRequests: "tx.reviewRequest.updateMany",
    reviews: "tx.review.updateMany",
    communications: "tx.customerCommunication.updateMany",
    communicationThreads: "mergeCommunicationThreads",
    phoneInteractions: "tx.phoneInteraction.updateMany",
    receptionistEvents: "tx.receptionistEvent.updateMany",
    referralRequests: "tx.referralRequest.updateMany",
    customerFollowUps: "tx.customerFollowUp.updateMany",
    referralsGiven: "sourceCustomerId",
    referralsReceived: "referredCustomerId",
    growthActionRequests: "tx.growthActionRequest.updateMany",
  };
  check(
    "reassignCustomerId source mentions every Customer relation",
    dmmfRelations.every((name) => relationTokens[name] && reassignSrc.includes(relationTokens[name])),
  );
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
    return {
      campaign,
      property,
      request,
      estimate,
      job,
      invoice,
      payment,
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
  await createLinkedRecords(beta, betaTwin.id, "beta");

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

  const lockAdmin = new PrismaClient({ datasourceUrl: baseUrl });
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
  await withTimeout(abBarrier.firstArrived, BARRIER_WAIT_MS, "A+B vs B+A entered write");
  const abContender = mergeConfirmedCustomers(
    abClientB,
    alpha.owner,
    { keepCustomerId: raceAB.right.id, absorbCustomerId: raceAB.left.id, confirmedSameCustomer: true },
  );
  await waitForTestDbLock(lockAdmin, "A+B vs B+A");
  await abBarrier.arrive();
  const abResults = await withTimeout(Promise.allSettled([abHeld, abContender]), 25000, "A+B vs B+A");
  const abWins = abResults.filter((result) => result.status === "fulfilled");
  const abLosses = abResults.filter((result) => result.status === "rejected");
  check("A+B vs B+A has exactly one winner", abWins.length === 1 && abLosses.length === 1);
  check(
    "A+B vs B+A loser is not-available or try-again",
    abLosses[0] && isUnavailableOrTryAgain(abLosses[0].reason),
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
  await withTimeout(triangleBarrier.firstArrived, BARRIER_WAIT_MS, "A+B vs B+C entered write");
  const triangleContender = mergeConfirmedCustomers(
    triangleClientC,
    alpha.owner,
    { keepCustomerId: customerC.id, absorbCustomerId: customerB.id, confirmedSameCustomer: true },
  );
  await waitForTestDbLock(lockAdmin, "A+B vs B+C");
  await triangleBarrier.arrive();
  const triangleResults = await withTimeout(
    Promise.allSettled([triangleHeld, triangleContender]),
    25000,
    "A+B vs B+C",
  );
  const triangleWins = triangleResults.filter((result) => result.status === "fulfilled");
  const triangleLosses = triangleResults.filter((result) => result.status === "rejected");
  check("A+B vs B+C has exactly one winner", triangleWins.length === 1 && triangleLosses.length === 1);
  check(
    "A+B vs B+C loser is not-available or try-again",
    triangleLosses[0] && isUnavailableOrTryAgain(triangleLosses[0].reason),
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
  await withTimeout(editBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-edit entered write");
  const editP = editClient.customer.update({
    where: { id: editPair.right.id },
    data: { name: "Concurrent Edit" },
  });
  await waitForTestDbLock(lockAdmin, "merge vs edit");
  await editBarrier.arrive();
  const editResults = await withTimeout(Promise.allSettled([editMergeP, editP]), 25000, "merge vs edit");
  const editMergeResult = editResults[0];
  const editWriteResult = editResults[1];
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
  await withTimeout(jobBarrier.firstArrived, BARRIER_WAIT_MS, "merge-versus-job entered write");
  const jobCreateP = jobWriteClient.job.create({
    data: {
      businessId: alpha.business.id,
      customerId: jobPair.right.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  await waitForTestDbLock(lockAdmin, "merge vs Job");
  await jobBarrier.arrive();
  const jobRaceResults = await withTimeout(Promise.allSettled([jobMergeP, jobCreateP]), 25000, "merge vs Job");
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
  await waitForTestDbLock(lockAdmin, "merge vs StoredAsset");
  await assetBarrier.arrive();
  const assetRaceResults = await withTimeout(
    Promise.allSettled([assetMergeP, assetUploadP]),
    25000,
    "merge vs StoredAsset",
  );
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
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
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
