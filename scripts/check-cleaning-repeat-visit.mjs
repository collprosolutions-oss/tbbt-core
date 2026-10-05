/**
 * Existing Cleaning customer request-another-visit from a public
 * project-token page.
 *
 * Dedicated database: tbbt_cleaning_repeat_visit_test
 *
 * Proves tenant isolation, replay/duplicate handling, and old-form
 * submission against the website-published intake snapshot. Submit
 * creates a ServiceRequest for owner review and never a Job, charge,
 * or message.
 *
 * Run with:
 *   npm run test:cleaning-repeat-visit
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for Cleaning repeat-visit checks.");
  process.exit(generateEarly.status ?? 1);
}

const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { ensurePrimaryBusinessTrade } = await import("@/lib/business-trades");
const { normalizePhone } = await import("@/lib/customer-identity");
const { smsConsentAfterOwnerPhoneEdit } = await import("@/lib/customer-messaging/opt-in");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { PUBLIC_INTAKE_REFRESH_FORM } = await import("@/lib/intake-snapshot");
const { INTAKE_CONDITION_STATUS_DRAFT } = await import("@/lib/intake-conditionals");
const {
  publishIntakeConditionDraft,
  saveIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");
const {
  loadPublicWebsiteIntakeOverlays,
  loadPublicWebsiteView,
  publishWebsite,
} = await import("@/lib/website-engine");
const {
  CLEANING_REPEAT_VISIT_OWNER_REVIEW_MESSAGE,
  CLEANING_REPEAT_VISIT_RECEIVED_MESSAGE,
  CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE,
  cleaningRepeatVisitEligible,
  publicRepeatVisitPath,
} = await import("@/lib/cleaning-repeat-visit");
const { loadCleaningRepeatVisitPublicView } = await import(
  "@/lib/cleaning-repeat-visit-data"
);
const {
  countBusinessCustomerMessages,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  createCleaningCustomerRepeatVisitRequest,
} = await import("@/lib/cleaning-repeat-visit-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Cleaning repeat-visit check.");
  process.exit(1);
}

const testDbName = "tbbt_cleaning_repeat_visit_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe|\$executeRaw\b/;
const featureFiles = [
  "src/lib/cleaning-repeat-visit.ts",
  "src/lib/cleaning-repeat-visit-ops.ts",
  "src/lib/cleaning-repeat-visit-data.ts",
  "src/app/actions/cleaning-repeat-visit.ts",
  "src/app/p/[token]/request-visit/page.tsx",
  "src/components/portal/request-another-visit-card.tsx",
  "src/lib/public-intake.ts",
];

const opsSrc = read("src/lib/cleaning-repeat-visit-ops.ts");
const dataSrc = read("src/lib/cleaning-repeat-visit-data.ts");
const actionSrc = read("src/app/actions/cleaning-repeat-visit.ts");
const pageSrc = read("src/app/p/[token]/request-visit/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const formSrc = read("src/components/public/request-flow.tsx");
const cardSrc = read("src/components/portal/request-another-visit-card.tsx");
const requestPageSrc = read("src/app/(app)/requests/[requestId]/page.tsx");
const intakeSrc = read("src/lib/public-intake.ts");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20260928170000_service_request_repeat_visit_source/migration.sql",
);

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const cleaningDraftV1 = {
  version: 1,
  status: INTAKE_CONDITION_STATUS_DRAFT,
  tradeCode: "CLEANING",
  baseSchemaKey: "cleaning.public",
  baseSchemaVersion: 2,
  questions: [{ key: "fridge_notes", type: "NOTES", label: "Fridge notes" }],
  rules: [
    {
      id: "show-fridge",
      questionKey: "fridge_notes",
      when: { field: "addons", op: "INCLUDES", value: "INSIDE_FRIDGE" },
      action: "SHOW",
    },
  ],
};

const cleaningDraftV2 = {
  ...cleaningDraftV1,
  questions: [
    ...cleaningDraftV1.questions,
    { key: "oven_notes", type: "NOTES", label: "Oven notes" },
  ],
  rules: [
    ...cleaningDraftV1.rules,
    {
      id: "show-oven",
      questionKey: "oven_notes",
      when: { field: "addons", op: "INCLUDES", value: "INSIDE_OVEN" },
      action: "SHOW",
    },
  ],
};

function cleaningAnswers(extra = {}) {
  return {
    bedrooms: 3,
    bathrooms: 2,
    homeSize: "1500_2000",
    frequency: "WEEKLY",
    ...extra,
  };
}

console.log("\nSTATIC — public token page, snapshot freeze, no Job/charge/message");
check(
  "Cleaning-only eligibility and public project-token path",
  cleaningRepeatVisitEligible("CLEANING") === true &&
    cleaningRepeatVisitEligible("HANDYMAN") === false &&
    publicRepeatVisitPath("abcToken").includes("/p/abcToken/request-visit"),
);
check(
  "Submit path creates a ServiceRequest and never a Job, charge, or message",
  opsSrc.includes("createPublicServiceRequest") &&
    opsSrc.includes("existingCustomer") &&
    opsSrc.includes("repeatVisitSourceJobId") &&
    !opsSrc.includes("job.create") &&
    !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyBusinessNewPublicRequest") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("notifyBusinessNewPublicRequest") &&
    !actionSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("job.create"),
);
check(
  "Token-only ownership; browser businessId/customerId/jobId are never authorization",
  dataSrc.includes("findLiveJobByProjectToken") &&
    opsSrc.includes("findLiveJobByProjectToken") &&
    pageSrc.includes("loadCleaningRepeatVisitPublicView") &&
    !actionSrc.includes('readString(formData, "businessId")') &&
    !actionSrc.includes('readString(formData, "customerId")') &&
    !actionSrc.includes('readString(formData, "jobId")') &&
    !pageSrc.includes('formData.get("businessId")') &&
    !pageSrc.includes('formData.get("jobId")'),
);
check(
  "Public form freezes the exact displayed website intake snapshot",
  pageSrc.includes("loadPublicWebsiteIntakeOverlays") &&
    formSrc.includes('formData.set("tenantIntakeSnapshotId"') &&
    formSrc.includes("submitCleaningRepeatVisitRequest") === false &&
    pageSrc.includes("submitCleaningRepeatVisitRequest") &&
    pageSrc.includes("PUBLIC_INTAKE_REFRESH_FORM") &&
    pageSrc.includes('lockedTradeCode="CLEANING"'),
);
check(
  "Portal CTA and owner review stay on the existing request path",
  portalSrc.includes("RequestAnotherVisitCard") &&
    cardSrc.includes("Request another visit") &&
    requestPageSrc.includes("CLEANING_REPEAT_VISIT_OWNER_REVIEW_MESSAGE") &&
    requestPageSrc.includes("CreateEstimateButton") &&
    CLEANING_REPEAT_VISIT_OWNER_REVIEW_MESSAGE.includes("Review this request") &&
    CLEANING_REPEAT_VISIT_RECEIVED_MESSAGE.includes("review"),
);
check(
  "One customer request per source job, distinct from OWNER next-booking Jobs",
  schemaSrc.includes("repeatVisitSourceJobId String? @unique") &&
    schemaSrc.includes("ServiceRequestRepeatVisitSource") &&
    schemaSrc.includes("nextBookingSourceJobId String? @unique") &&
    migrationSrc.includes("repeatVisitSourceJobId") &&
    migrationSrc.includes("ServiceRequest_repeatVisitSourceJobId_key") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
check(
  "Public read model is mutation-free and avoids private job fields",
  !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc) &&
    !dataSrc.includes("propertyAccessInstructions") &&
    !dataSrc.includes("unitPrice") &&
    !dataSrc.includes("paymentMethod") &&
    !dataSrc.includes("internalNotes"),
);
check(
  "No eval, Function, or raw SQL in the dedicated files",
  featureFiles.every((file) => !DANGEROUS.test(read(file))),
);
check(
  "Unavailable copy does not leak private job data",
  CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE === "This project link is not available.",
);
check(
  "existingCustomer path rechecks normalized phones and grants consent only on an atomic stored-phone write",
  intakeSrc.includes("boundCustomerId") &&
    intakeSrc.includes("normalizePhone(stored.phone) === normalizePhone(phone)") &&
    intakeSrc.includes("select: { phone: true }") &&
    intakeSrc.includes("updateMany") &&
    intakeSrc.includes("phone: stored.phone") &&
    !intakeSrc.includes("data: { phone"),
);
check(
  "Token-bound repeat visit may restore Review and submit without submitted email/phone",
  formSrc.includes("projectToken") &&
    formSrc.includes("hasPublicIntakeContact") &&
    formSrc.includes("PUBLIC_INTAKE_CONTACT_REQUIRED") &&
    /!projectToken && !hasPublicIntakeContact/.test(formSrc) &&
    formSrc.includes('restoredStep === "review"') &&
    pageSrc.includes("projectToken={token}") &&
    pageSrc.includes("initialContact={view.contact}"),
);

try {
  console.log("\nDB — tenant isolation, replay/duplicate, old-form snapshot");
  const suffix = randomUUID().slice(0, 8);
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Repeat Clean",
      slug: `alpha-rv-${suffix}`,
      tradeCode: "CLEANING",
    },
  });
  const cleanB = await prisma.business.create({
    data: {
      name: "Beta Repeat Clean",
      slug: `beta-rv-${suffix}`,
      tradeCode: "CLEANING",
    },
  });
  const handyC = await prisma.business.create({
    data: {
      name: "Gamma Repeat Handy",
      slug: `gamma-rv-${suffix}`,
      tradeCode: "HANDYMAN",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, cleanB.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, handyC.id, "HANDYMAN");

  const ownerAUser = await prisma.user.create({
    data: { name: "Owner A", email: `rva-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerAMembership = await prisma.membership.create({
    data: { userId: ownerAUser.id, businessId: cleanA.id, role: "OWNER" },
  });
  const ownerA = makeAccess(cleanA.id, "OWNER", ownerAMembership.id);

  const catalogA = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanA.id,
      name: "Standard House Cleaning",
      category: "House Cleaning",
      tradeCode: "CLEANING",
      active: true,
      recurrenceEligible: true,
    },
  });
  const catalogB = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanB.id,
      name: "Beta House Cleaning",
      category: "House Cleaning",
      tradeCode: "CLEANING",
      active: true,
    },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyC.id,
      name: "TV Mounting",
      category: "Mounting",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV1,
  });
  const snapV1 = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "rv-intake-v1",
  });
  await publishWebsite(prisma, ownerA, { idempotencyKey: "rv-web-v1" });
  const viewV1 = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysV1 = await loadPublicWebsiteIntakeOverlays(prisma, viewV1, cleanA.id, [
    "CLEANING",
  ]);

  async function createCleaningJob(businessId, options = {}) {
    const {
      tradeCode = "CLEANING",
      includeCustomer = true,
      catalogItemId = null,
    } = options;
    const customer = includeCustomer
      ? await prisma.customer.create({
          data: {
            businessId,
            name: `${tradeCode} Customer`,
            email: `${tradeCode}-${randomUUID().slice(0, 6)}@example.com`,
            phone: "5551110000",
          },
        })
      : null;
    const property = customer
      ? await prisma.property.create({
          data: {
            businessId,
            customerId: customer.id,
            addressLine1: "100 Pine St",
            city: "Reno",
            region: "NV",
            postalCode: "89501",
          },
        })
      : null;
    const request = await prisma.serviceRequest.create({
      data: {
        businessId,
        customerId: customer?.id,
        propertyId: property?.id,
        description: `${tradeCode} visit`,
        tradeCode,
        serviceIntent: "ONE_TIME",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId,
        customerId: customer?.id,
        propertyId: property?.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 180,
      },
    });
    if (catalogItemId) {
      await prisma.lineItem.create({
        data: {
          businessId,
          estimateId: estimate.id,
          serviceCatalogItemId: catalogItemId,
          description: "Standard clean",
          quantity: 1,
          unitPrice: 180,
          total: 180,
          type: "LABOR",
        },
      });
    }
    const job = await prisma.job.create({
      data: {
        businessId,
        customerId: customer?.id,
        propertyId: property?.id,
        estimateId: estimate.id,
        projectToken: randomUUID(),
        status: "COMPLETED",
        scheduledAt: new Date("2026-09-20T16:00:00.000Z"),
        serviceIntent: "ONE_TIME",
      },
    });
    return { job, customer, property };
  }

  const alpha = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaTwo = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaCatalogIsolation = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaMissingSnap = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaSms = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaSmsRace = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaBlankContact = await createCleaningJob(cleanA.id, { catalogItemId: catalogA.id });
  const alphaNoCustomer = await createCleaningJob(cleanA.id, { includeCustomer: false });
  const beta = await createCleaningJob(cleanB.id, { catalogItemId: catalogB.id });
  const handy = await createCleaningJob(handyC.id, { tradeCode: "HANDYMAN" });

  const publicView = await loadCleaningRepeatVisitPublicView(prisma, alpha.job.projectToken);
  const handyView = await loadCleaningRepeatVisitPublicView(prisma, handy.job.projectToken);
  const missingView = await loadCleaningRepeatVisitPublicView(prisma, randomUUID());
  const noCustomerView = await loadCleaningRepeatVisitPublicView(
    prisma,
    alphaNoCustomer.job.projectToken,
  );
  check(
    "Public view is ready only for same-business Cleaning customers",
    publicView.status === "ready" &&
      publicView.businessId === cleanA.id &&
      publicView.customerId === alpha.customer.id &&
      publicView.slug === cleanA.slug &&
      !("jobId" in publicView) &&
      handyView.status === "unavailable" &&
      missingView.status === "unavailable" &&
      noCustomerView.status === "unavailable",
  );

  const jobsBefore = await countBusinessJobs(prisma, cleanA.id);
  const invoicesBefore = await countBusinessInvoices(prisma, cleanA.id);
  const paymentsBefore = await countBusinessPayments(prisma, cleanA.id);
  const messagesBefore = await countBusinessCustomerMessages(prisma, cleanA.id);
  const requestsBefore = await prisma.serviceRequest.count({ where: { businessId: cleanA.id } });

  const firstSubmit = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alpha.job.projectToken,
    slug: cleanA.slug,
    name: alpha.customer.name,
    email: alpha.customer.email,
    phone: alpha.customer.phone,
    address: "100 Pine St",
    streetAddress: "100 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Please come again next week",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Opened on the published form",
    }),
    submissionId: `rv-first-${suffix}`,
  });
  const firstRow = firstSubmit.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: firstSubmit.requestId } })
    : null;
  const jobsAfter = await countBusinessJobs(prisma, cleanA.id);
  const invoicesAfter = await countBusinessInvoices(prisma, cleanA.id);
  const paymentsAfter = await countBusinessPayments(prisma, cleanA.id);
  const messagesAfter = await countBusinessCustomerMessages(prisma, cleanA.id);
  const requestsAfter = await prisma.serviceRequest.count({ where: { businessId: cleanA.id } });
  check(
    "Submit creates one OPEN owner-review ServiceRequest and freezes the displayed snapshot",
    firstSubmit.ok === true &&
      firstSubmit.alreadyExists === false &&
      firstRow?.businessId === cleanA.id &&
      firstRow?.customerId === alpha.customer.id &&
      firstRow?.status === "OPEN" &&
      firstRow?.tradeCode === "CLEANING" &&
      firstRow?.repeatVisitSourceJobId === alpha.job.id &&
      firstRow?.tenantIntakeSnapshotId === snapV1.id &&
      firstRow?.tenantIntakeSnapshotVersion === snapV1.versionNumber &&
      requestsAfter === requestsBefore + 1,
  );
  check(
    "Submit does not create or schedule a Job, charge, or message",
    jobsAfter === jobsBefore &&
      invoicesAfter === invoicesBefore &&
      paymentsAfter === paymentsBefore &&
      messagesAfter === messagesBefore,
  );

  const replay = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alpha.job.projectToken,
    slug: cleanA.slug,
    name: "Changed Name",
    email: "other@example.com",
    phone: "5550001111",
    address: "100 Pine St",
    streetAddress: "100 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Replay",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
    submissionId: `rv-replay-${suffix}`,
  });
  const requestsAfterReplay = await prisma.serviceRequest.count({
    where: { businessId: cleanA.id },
  });
  check(
    "Replay / duplicate submit returns the existing request for that source job",
    replay.ok === true &&
      replay.alreadyExists === true &&
      replay.requestId === firstSubmit.requestId &&
      requestsAfterReplay === requestsAfter,
  );

  const crossSlug = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alpha.job.projectToken,
    slug: cleanB.slug,
    name: alpha.customer.name,
    email: alpha.customer.email,
    phone: alpha.customer.phone,
    address: "100 Pine St",
    notes: "cross slug",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
  });
  const foreignCatalog = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alphaCatalogIsolation.job.projectToken,
    slug: cleanA.slug,
    name: alpha.customer.name,
    email: alpha.customer.email,
    phone: alpha.customer.phone,
    address: "100 Pine St",
    notes: "foreign catalog",
    catalogItemIds: [catalogB.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
  });
  const otherToken = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: beta.job.projectToken,
    slug: cleanA.slug,
    name: "Beta",
    email: "beta@example.com",
    phone: "5552220000",
    address: "9 Oak",
    notes: "other tenant",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
  });
  const handySubmit = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: handy.job.projectToken,
    slug: handyC.slug,
    name: "Handy",
    email: "handy@example.com",
    phone: "5553330000",
    address: "1 Main",
    notes: "handy",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Another visit",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: { frequency: "ONE_TIME" },
  });
  const requestsAfterIsolation = await prisma.serviceRequest.count({
    where: { businessId: cleanA.id },
  });
  const betaRequests = await prisma.serviceRequest.count({
    where: { businessId: cleanB.id, repeatVisitSourceJobId: { not: null } },
  });
  check(
    "Tenant isolation rejects cross-slug, foreign catalog, other-tenant token, and Handyman",
    crossSlug.ok === false &&
      foreignCatalog.ok === false &&
      otherToken.ok === false &&
      handySubmit.ok === false &&
      requestsAfterIsolation === requestsAfterReplay &&
      betaRequests === 0,
  );

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV2,
  });
  const snapV2 = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "rv-intake-v2",
  });
  await publishWebsite(prisma, ownerA, { idempotencyKey: "rv-web-v2" });
  const viewV2 = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysV2 = await loadPublicWebsiteIntakeOverlays(prisma, viewV2, cleanA.id, [
    "CLEANING",
  ]);

  const oldForm = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alphaTwo.job.projectToken,
    slug: cleanA.slug,
    name: alphaTwo.customer.name,
    email: alphaTwo.customer.email,
    phone: alphaTwo.customer.phone,
    address: "100 Pine St",
    streetAddress: "100 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Opened before website republish",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Old form still valid",
    }),
    submissionId: `rv-old-${suffix}`,
  });
  const oldRow = oldForm.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: oldForm.requestId } })
    : null;
  check(
    "Already-opened V1 form still submits after the website is republished",
    overlaysV1.ok === true &&
      overlaysV1.overlays.CLEANING?.snapshotId === snapV1.id &&
      overlaysV2.ok === true &&
      overlaysV2.overlays.CLEANING?.snapshotId === snapV2.id &&
      oldForm.ok === true &&
      oldRow?.tenantIntakeSnapshotId === snapV1.id &&
      oldRow?.tenantIntakeSnapshotVersion === snapV1.versionNumber &&
      oldRow?.repeatVisitSourceJobId === alphaTwo.job.id &&
      oldRow?.status === "OPEN",
  );

  const missingSnap = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alphaMissingSnap.job.projectToken,
    slug: cleanA.slug,
    name: alphaTwo.customer.name,
    email: alphaTwo.customer.email,
    phone: alphaTwo.customer.phone,
    address: "100 Pine St",
    notes: "missing snap",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: `missing_${randomUUID().replaceAll("-", "")}`,
    intakeAnswers: cleaningAnswers(),
  });
  check(
    "Missing snapshot id fails closed instead of saving a later live pointer",
    missingSnap.ok === false &&
      (missingSnap.error === PUBLIC_INTAKE_REFRESH_FORM ||
        Boolean(missingSnap.error)),
  );

  const blankStored = await prisma.customer.findFirst({
    where: { id: alphaBlankContact.customer.id, businessId: cleanA.id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
      smsConsentUpdatedAt: true,
    },
  });
  const customersBeforeBlank = await prisma.customer.count({ where: { businessId: cleanA.id } });
  const blankRepeat = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alphaBlankContact.job.projectToken,
    slug: cleanA.slug,
    name: alphaBlankContact.customer.name,
    email: "",
    phone: "",
    address: "100 Pine St",
    streetAddress: "100 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Repeat visit with blank submitted contact",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
    submissionId: `rv-blank-${suffix}`,
    smsOptIn: true,
  });
  const blankRepeatRequest = blankRepeat.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: blankRepeat.requestId },
        select: { id: true, customerId: true, status: true, repeatVisitSourceJobId: true },
      })
    : null;
  const blankAfter = await prisma.customer.findFirst({
    where: { id: alphaBlankContact.customer.id, businessId: cleanA.id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
      smsConsentUpdatedAt: true,
    },
  });
  const customersAfterBlank = await prisma.customer.count({ where: { businessId: cleanA.id } });
  check(
    "Existing-customer repeat visit with blank submitted email and phone still succeeds",
    blankRepeat.ok === true &&
      blankRepeatRequest?.status === "OPEN" &&
      blankRepeatRequest?.repeatVisitSourceJobId === alphaBlankContact.job.id,
  );
  check(
    "Blank-contact repeat visit stays attached to the existing customer",
    blankRepeatRequest?.customerId === alphaBlankContact.customer.id,
  );
  check(
    "Blank-contact repeat visit does not create a duplicate customer",
    customersAfterBlank === customersBeforeBlank,
  );
  check(
    "Blank submitted repeat-visit contact does not erase or rewrite stored email/phone",
    blankAfter?.name === blankStored?.name &&
      blankAfter?.email === blankStored?.email &&
      blankAfter?.phone === blankStored?.phone &&
      Boolean(blankAfter?.email) &&
      Boolean(blankAfter?.phone),
  );
  check(
    "Blank repeat-visit contact with SMS opt-in checked does not grant consent",
    blankAfter?.smsConsentStatus === "UNKNOWN" &&
      blankAfter?.smsConsentUpdatedAt?.toISOString() ===
        blankStored?.smsConsentUpdatedAt?.toISOString(),
  );

  const consentFrozenAt = new Date("2026-01-15T12:00:00.000Z");
  const storedSmsPhone = "5551110000";
  const submittedSmsPhone = "5559998888";
  await prisma.customer.update({
    where: { id: alphaSms.customer.id },
    data: {
      phone: storedSmsPhone,
      smsConsentStatus: "UNKNOWN",
      smsConsentUpdatedAt: consentFrozenAt,
    },
  });
  const smsMismatch = await createCleaningCustomerRepeatVisitRequest(prisma, {
    token: alphaSms.job.projectToken,
    slug: cleanA.slug,
    name: alphaSms.customer.name,
    email: alphaSms.customer.email,
    phone: submittedSmsPhone,
    address: "100 Pine St",
    streetAddress: "100 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Different phone with SMS opt-in checked",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
    submissionId: `rv-sms-${suffix}`,
    smsOptIn: true,
  });
  const smsCustomer = await prisma.customer.findFirst({
    where: { id: alphaSms.customer.id, businessId: cleanA.id },
    select: { id: true, phone: true, smsConsentStatus: true, smsConsentUpdatedAt: true },
  });
  const smsRequest = smsMismatch.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: smsMismatch.requestId },
        select: { id: true, customerId: true, status: true, repeatVisitSourceJobId: true },
      })
    : null;
  check(
    "Different submitted phone with SMS opt-in checked does not grant consent or rewrite the stored phone",
    normalizePhone(storedSmsPhone) !== normalizePhone(submittedSmsPhone) &&
      smsMismatch.ok === true &&
      smsRequest?.status === "OPEN" &&
      smsRequest?.customerId === alphaSms.customer.id &&
      smsRequest?.repeatVisitSourceJobId === alphaSms.job.id &&
      smsCustomer?.phone === storedSmsPhone &&
      smsCustomer?.smsConsentStatus === "UNKNOWN" &&
      smsCustomer?.smsConsentUpdatedAt?.toISOString() === consentFrozenAt.toISOString(),
  );

  const raceStoredPhone = "5551110000";
  const raceOwnerPhone = "5552223333";
  const raceConsentFrozenAt = new Date("2026-01-15T12:00:00.000Z");
  await prisma.customer.update({
    where: { id: alphaSmsRace.customer.id },
    data: {
      phone: raceStoredPhone,
      smsConsentStatus: "UNKNOWN",
      smsConsentUpdatedAt: raceConsentFrozenAt,
    },
  });
  let releaseConsentWrite;
  const consentWriteGate = new Promise((resolve) => {
    releaseConsentWrite = resolve;
  });
  let notifyConsentReachedWrite;
  const consentReachedWrite = new Promise((resolve) => {
    notifyConsentReachedWrite = resolve;
  });
  let consentWriteCount = null;
  const racingDb = prisma.$extends({
    query: {
      customer: {
        async updateMany({ args, query }) {
          if (args.data?.smsConsentStatus === "GRANTED") {
            notifyConsentReachedWrite();
            await consentWriteGate;
            const updated = await query(args);
            consentWriteCount = updated.count;
            return updated;
          }
          return query(args);
        },
      },
    },
  });
  const raceSubmit = createCleaningCustomerRepeatVisitRequest(racingDb, {
    token: alphaSmsRace.job.projectToken,
    slug: cleanA.slug,
    name: alphaSmsRace.customer.name,
    email: alphaSmsRace.customer.email,
    phone: raceStoredPhone,
    address: "100 Pine St",
    streetAddress: "100 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Matching phone with SMS opt-in, owner edits first",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: snapV1.id,
    intakeAnswers: cleaningAnswers(),
    submissionId: `rv-sms-race-${suffix}`,
    smsOptIn: true,
  });
  await Promise.race([
    consentReachedWrite,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("bound SMS consent write was never reached")), 8000);
    }),
  ]);
  const ownerConsentReset = smsConsentAfterOwnerPhoneEdit(raceStoredPhone, raceOwnerPhone);
  await prisma.customer.update({
    where: { id: alphaSmsRace.customer.id },
    data: {
      phone: raceOwnerPhone,
      ...(ownerConsentReset ?? {}),
    },
  });
  const ownerAfterEdit = await prisma.customer.findFirst({
    where: { id: alphaSmsRace.customer.id, businessId: cleanA.id },
    select: { phone: true, smsConsentStatus: true, smsConsentUpdatedAt: true },
  });
  releaseConsentWrite();
  const raceResult = await raceSubmit;
  const raceCustomer = await prisma.customer.findFirst({
    where: { id: alphaSmsRace.customer.id, businessId: cleanA.id },
    select: { id: true, phone: true, smsConsentStatus: true, smsConsentUpdatedAt: true },
  });
  const raceRequest = raceResult.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: raceResult.requestId },
        select: { id: true, customerId: true, status: true, repeatVisitSourceJobId: true },
      })
    : null;
  check(
    "Owner phone edit that commits first leaves the consent write matching zero rows and ungranted",
    normalizePhone(raceStoredPhone) !== normalizePhone(raceOwnerPhone) &&
      ownerAfterEdit?.phone === raceOwnerPhone &&
      ownerAfterEdit?.smsConsentStatus === "UNKNOWN" &&
      raceResult.ok === true &&
      raceRequest?.status === "OPEN" &&
      raceRequest?.customerId === alphaSmsRace.customer.id &&
      raceRequest?.repeatVisitSourceJobId === alphaSmsRace.job.id &&
      consentWriteCount === 0 &&
      raceCustomer?.phone === raceOwnerPhone &&
      raceCustomer?.smsConsentStatus === "UNKNOWN" &&
      raceCustomer?.smsConsentUpdatedAt?.toISOString() ===
        ownerAfterEdit?.smsConsentUpdatedAt?.toISOString() &&
      raceCustomer?.smsConsentUpdatedAt?.toISOString() !== raceConsentFrozenAt.toISOString(),
  );

  const boundCustomer = await prisma.serviceRequest.findMany({
    where: { businessId: cleanA.id, repeatVisitSourceJobId: { not: null } },
    select: { customerId: true, repeatVisitSourceJobId: true },
  });
  check(
    "Bound requests stay on the token customer and never create a second customer",
    boundCustomer.every((row) =>
      [
        alpha.customer.id,
        alphaTwo.customer.id,
        alphaSms.customer.id,
        alphaSmsRace.customer.id,
        alphaBlankContact.customer.id,
      ].includes(row.customerId),
    ),
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - live Cleaning repeat-visit proofs");
  console.error(error);
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
