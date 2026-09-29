/**
 * OWNER same-business customer merge proofs.
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
  CUSTOMER_MERGE_ROUTE,
  CONFIRM_REQUIRED_MESSAGE,
  CROSS_BUSINESS_MERGE_MESSAGE,
  CUSTOMERS_NOT_AVAILABLE_MESSAGE,
  CustomerMergeError,
  findPossibleDuplicatePairs,
  MERGE_ALREADY_ABSORBED_MESSAGE,
  mergeSmsConsentStates,
  NAME_IS_NOT_IDENTITY_MESSAGE,
  NO_SHARED_IDENTIFIER_MESSAGE,
  OWNER_ONLY_MERGE_MESSAGE,
  pairHref,
  pairMatchReasons,
} = await import("@/lib/customer-merge");
const {
  loadDuplicateReview,
  loadOwnedMergePair,
  mergeConfirmedCustomers,
} = await import("@/lib/customer-merge-ops");

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

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_customer_merge_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for customer merge test database.");
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
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

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
  return {
    business,
    owner: makeAccess(business.id, "OWNER", ownerMem.id),
    admin: makeAccess(business.id, "ADMIN", adminMem.id),
    member: makeAccess(business.id, "MEMBER", memberMem.id),
  };
}

async function createLinkedRecords(businessId, customerId, suffix) {
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
  return { property, request, estimate, job, invoice, payment, expense, thread, communication };
}

try {
  console.log("\nSTATIC — OWNER review, no name identity, no outreach");
  check("Dedicated route is /customers/duplicates", CUSTOMER_MERGE_ROUTE === "/customers/duplicates");
  check("Owner-only copy is present", OWNER_ONLY_MERGE_MESSAGE.includes("business owner"));
  check("Name-is-not-identity copy is present", NAME_IS_NOT_IDENTITY_MESSAGE.includes("Matching names do not prove"));
  check(
    "Global nav does not add a merge destination",
    APP_NAV.every((item) => item.href !== CUSTOMER_MERGE_ROUTE) &&
      !readSrc("src/lib/nav.ts").includes("duplicates"),
  );
  check(
    "Ops require OWNER and lock both customers in one serializable transaction",
    readSrc("src/lib/customer-merge-ops.ts").includes('requireBusinessRole(access, "OWNER")') &&
      readSrc("src/lib/customer-merge-ops.ts").includes("FOR UPDATE") &&
      readSrc("src/lib/customer-merge-ops.ts").includes("Serializable"),
  );
  check(
    "Merge remaps jobs, estimates, invoices, properties, and communications",
    readSrc("src/lib/customer-merge-ops.ts").includes("tx.job.updateMany") &&
      readSrc("src/lib/customer-merge-ops.ts").includes("tx.estimate.updateMany") &&
      readSrc("src/lib/customer-merge-ops.ts").includes("tx.invoice.updateMany") &&
      readSrc("src/lib/customer-merge-ops.ts").includes("tx.property.updateMany") &&
      readSrc("src/lib/customer-merge-ops.ts").includes("tx.customerCommunication.updateMany"),
  );
  check(
    "Feature does not send email or SMS",
    !/sendEmail|sendMail|sendSms|resend|attemptCustomerSms/i.test(featureSource),
  );
  check(
    "Customers list still exposes New Customer",
    readSrc("src/app/(app)/customers/page.tsx").includes('<NewCustomerForm label="New Customer" />'),
  );
  check("Confirm form requires explicit same-customer confirmation", readSrc("src/components/customers/merge-customers-form.tsx").includes('name="confirmSameCustomer"'));

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

  const alpha = await seedBusiness("alpha");
  const beta = await seedBusiness("beta");

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

  const keepLinks = await createLinkedRecords(alpha.business.id, keep.id, "keep");
  const absorbLinks = await createLinkedRecords(alpha.business.id, absorb.id, "absorb");
  await createLinkedRecords(beta.business.id, betaTwin.id, "beta");

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

  console.log("\nCONCURRENT — overlapping merges do not split relations");
  const [first, second] = await Promise.allSettled([
    mergeConfirmedCustomers(prisma, alpha.owner, {
      keepCustomerId: keep.id,
      absorbCustomerId: absorb.id,
      confirmedSameCustomer: true,
    }),
    mergeConfirmedCustomers(prisma, alpha.owner, {
      keepCustomerId: keep.id,
      absorbCustomerId: absorb.id,
      confirmedSameCustomer: true,
    }),
  ]);
  const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
  const rejected = [first, second].filter((result) => result.status === "rejected");
  check("Exactly one concurrent merge succeeds", fulfilled.length === 1 && rejected.length === 1);
  check(
    "The losing concurrent merge fails closed",
    rejected[0].status === "rejected" &&
      (rejected[0].reason instanceof CustomerMergeError ||
        (typeof rejected[0].reason?.message === "string" &&
          /could not serialize|P2034|Unique constraint|Record to delete does not exist/i.test(
            rejected[0].reason.message,
          ))),
  );

  const survivor = await prisma.customer.findUnique({ where: { id: keep.id } });
  const absorbedGone = await prisma.customer.findUnique({ where: { id: absorb.id } });
  const movedJobs = await prisma.job.findMany({
    where: { id: { in: [keepLinks.job.id, absorbLinks.job.id] } },
  });
  const movedEstimates = await prisma.estimate.findMany({
    where: { id: { in: [keepLinks.estimate.id, absorbLinks.estimate.id] } },
  });
  const movedInvoices = await prisma.invoice.findMany({
    where: { id: { in: [keepLinks.invoice.id, absorbLinks.invoice.id] } },
  });
  const movedProperties = await prisma.property.findMany({
    where: { id: { in: [keepLinks.property.id, absorbLinks.property.id] } },
  });
  const movedMessages = await prisma.customerCommunication.findMany({
    where: { id: { in: [keepLinks.communication.id, absorbLinks.communication.id] } },
  });
  const movedThreads = await prisma.communicationThread.findMany({
    where: { businessId: alpha.business.id, customerId: keep.id },
  });
  const audit = await prisma.customerMerge.findMany({
    where: { businessId: alpha.business.id },
  });

  console.log("\nPRESERVE — relations and stricter consent stay on the survivor");
  check("Survivor remains", survivor?.id === keep.id);
  check("Absorbed customer is deleted", absorbedGone === null);
  check(
    "Both jobs now belong to the survivor",
    movedJobs.length === 2 && movedJobs.every((row) => row.customerId === keep.id),
  );
  check(
    "Both estimates now belong to the survivor",
    movedEstimates.length === 2 && movedEstimates.every((row) => row.customerId === keep.id),
  );
  check(
    "Both invoices now belong to the survivor",
    movedInvoices.length === 2 && movedInvoices.every((row) => row.customerId === keep.id),
  );
  check(
    "Both properties now belong to the survivor",
    movedProperties.length === 2 && movedProperties.every((row) => row.customerId === keep.id),
  );
  check(
    "Both communications now belong to the survivor",
    movedMessages.length === 2 && movedMessages.every((row) => row.customerId === keep.id),
  );
  check(
    "Customer-level threads collapsed onto the survivor",
    movedThreads.length === 1 &&
      movedThreads[0].customerId === keep.id &&
      movedThreads[0].subjectId === keep.id,
  );
  check("Stricter SMS consent is REVOKED", survivor?.smsConsentStatus === "REVOKED");
  check(
    "Merge audit records the absorbed snapshot",
    audit.length === 1 &&
      audit[0].survivorCustomerId === keep.id &&
      audit[0].absorbedCustomerId === absorb.id &&
      audit[0].matchReasons.includes("email"),
  );
  check("Beta twin is untouched", (await prisma.customer.findUnique({ where: { id: betaTwin.id } }))?.email === "ada-merge@example.com");

  const ownedPair = await loadOwnedMergePair(prisma, alpha.owner, keep.id, nameOnly.id);
  check(
    "Remaining name-only customer still has no shared identifier",
    ownedPair.reasons.length === 0,
  );

  const leftoverReview = await loadDuplicateReview(prisma, alpha.owner);
  check("Successful merge clears the email/phone pair", leftoverReview.pairs.length === 0);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\ncustomer-merge check failed: ${failures} failure(s)`);
  process.exit(1);
}

console.log("\ncustomer-merge check passed.");
