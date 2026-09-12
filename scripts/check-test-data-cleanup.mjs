/**
 * Founder/owner Clear Test Data: deletes operational records, preserves
 * tenant configuration, never runs from public routes or deploy.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-test-data-cleanup.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CLEAR_TEST_DATA_CONFIRMATION,
  executeOperationalTestDataCleanup,
  previewOperationalTestData,
  TestDataCleanupError,
} = await import("@/lib/test-data-cleanup");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const cleanupSrc = readRepo("src/lib/test-data-cleanup.ts");
const actionSrc = readRepo("src/app/actions/test-data-cleanup.ts");
const settingsPage = readRepo("src/app/(app)/settings/page.tsx");
const settingsWorkspace = readRepo("src/components/settings/settings-workspace.tsx");
const migrateRunner = readRepo("scripts/run-production-migrate.mjs");
const intakeAction = readRepo("src/app/actions/intake.ts");

console.log("\nSTATIC — cleanup is founder/owner-only and never automatic");
check(
  "Confirmation phrase is CLEAR TEST DATA",
  cleanupSrc.includes('CLEAR_TEST_DATA_CONFIRMATION = "CLEAR TEST DATA"'),
);
check(
  "Execute requires the exact confirmation phrase",
  cleanupSrc.includes("input.confirmation !== CLEAR_TEST_DATA_CONFIRMATION"),
);
check(
  "Server action requires founder access and OWNER role",
  actionSrc.includes("requireFounderAccess") &&
    actionSrc.includes('requireBusinessRole(access, "OWNER")'),
);
check(
  "Settings UI is gated to founder OWNER and only on Data / Export",
  settingsPage.includes("canClearTestData") &&
    settingsPage.includes('role === "OWNER"') &&
    settingsWorkspace.includes("ClearTestDataForm"),
);
check(
  "Public intake cannot call cleanup",
  !intakeAction.includes("executeOperationalTestDataCleanup") &&
    !intakeAction.includes("clearOperationalTestData"),
);
check(
  "Production migrate does not run cleanup",
  !migrateRunner.includes("executeOperationalTestDataCleanup") &&
    !migrateRunner.includes("clearOperationalTestData"),
);
check(
  "Stripe connected-account rows are not deleted",
  cleanupSrc.includes("Stripe Connect connected-account configuration") &&
    !cleanupSrc.includes("businessPaymentAccount.deleteMany"),
);
check(
  "Website images and catalog are not deleted",
  !cleanupSrc.includes("publicSiteImage.deleteMany") &&
    !cleanupSrc.includes("serviceCatalogItem.deleteMany") &&
    !cleanupSrc.includes("businessSettings.deleteMany"),
);

const testDbName = `tbbt_test_data_cleanup_${randomUUID().slice(0, 8)}`;
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for test-data-cleanup database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

async function seedBusiness(slug, name) {
  const business = await prisma.business.create({
    data: {
      name,
      slug,
      tradeCode: "HANDYMAN",
      laborMinimumEnabled: true,
      laborMinimumAmount: new Prisma.Decimal("95.00"),
      publicPhone: "239-357-8199",
      publicEmail: "hello@example.com",
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `${slug}-owner@example.com`,
      passwordHash: "hash",
      name: `${name} Owner`,
      isFounder: slug === "collpro-reno",
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER" },
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Mailbox Replacement",
      category: "Exterior Repairs",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(175),
      active: true,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      approvedPublicAboutCopy: "Keep this About story.",
      workStartMinutes: 480,
    },
  });
  await prisma.businessUnavailableDate.create({
    data: { businessId: business.id, date: "2026-12-25" },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: business.id,
      provider: "stripe",
      stripeAccountId: `acct_keep_${slug}`,
    },
  });
  const storage = await prisma.businessStorageAccount.create({
    data: {
      businessId: business.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-test",
      namespacePrefix: `businesses/${business.id}`,
      storageLimitBytes: BigInt(1024 * 1024 * 1024),
    },
  });
  const websiteAsset = await prisma.storedAsset.create({
    data: {
      businessId: business.id,
      storageAccountId: storage.id,
      category: "WEBSITE_IMAGE",
      originalFilename: "hero.jpg",
      storageKey: `${business.id}/website/hero.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 12,
      visibility: "PUBLIC",
      status: "READY",
    },
  });
  await prisma.publicSiteImage.create({
    data: {
      businessId: business.id,
      page: "home",
      slot: "hero",
      storedAssetId: websiteAsset.id,
      imageUrl: `/api/storage/public/${websiteAsset.id}`,
    },
  });
  await prisma.knowledgeEntry.create({
    data: {
      businessId: business.id,
      title: "How we quote mailbox posts",
      category: "SERVICES_PRICING",
      body: "Keep this knowledge.",
      sourceType: "OWNER_CREATED",
      trustState: "NEEDS_REVIEW",
      createdByMembershipId: membership.id,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Tim trump",
      email: `${slug}-tim@example.com`,
      phone: "239-555-0100",
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: "88 Harbor Ave",
      city: "Cape Coral",
      region: "FL",
      postalCode: "33904",
    },
  });
  const request = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      summary: "Mailbox Replacement",
      description: "Test request",
      serviceCatalogItemId: catalog.id,
    },
  });
  await prisma.serviceRequestItem.create({
    data: {
      businessId: business.id,
      serviceRequestId: request.id,
      serviceCatalogItemId: catalog.id,
      quantity: 1,
      sortOrder: 0,
    },
  });
  const customerPhoto = await prisma.storedAsset.create({
    data: {
      businessId: business.id,
      storageAccountId: storage.id,
      category: "CUSTOMER_PHOTO",
      originalFilename: "mailbox.jpg",
      storageKey: `${business.id}/customer/mailbox.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 20,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  await prisma.serviceRequestPhoto.create({
    data: {
      businessId: business.id,
      serviceRequestId: request.id,
      url: `/api/storage/private/${customerPhoto.id}`,
      storedAssetId: customerPhoto.id,
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      serviceRequestId: request.id,
      status: "APPROVED",
      total: new Prisma.Decimal(175),
      publicToken: randomUUID(),
    },
  });
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(175),
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      approvedAt: new Date(),
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      jobId: job.id,
      status: "PAID",
      total: new Prisma.Decimal(175),
      paymentMethod: "STRIPE",
    },
  });
  await prisma.payment.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      invoiceId: invoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(175),
      method: "STRIPE",
      stripeCheckoutSessionId: `cs_test_${slug}`,
    },
  });
  return {
    business,
    membership,
    catalog,
    websiteAsset,
    customerPhoto,
    customer,
  };
}

try {
  console.log("\nDB — cleanup scope, isolation, and confirmation");
  const collpro = await seedBusiness("collpro-reno", "CollPro Reno Handyman Services");
  const other = await seedBusiness("other-handyman", "Other Handyman");

  const preview = await previewOperationalTestData(prisma, collpro.business.id);
  check("Preview counts the CollPro customer", preview.willDelete.customers === 1);
  check("Preview counts the CollPro request", preview.willDelete.serviceRequests === 1);
  check("Preview counts the CollPro estimate", preview.willDelete.estimates === 1);
  check("Preview counts the CollPro job", preview.willDelete.jobs === 1);
  check("Preview counts the CollPro invoice", preview.willDelete.invoices === 1);
  check("Preview counts the CollPro payment", preview.willDelete.payments === 1);
  check("Preview counts the customer photo asset", preview.willDelete.operationalStoredAssets === 1);
  check(
    "Preview lists Stripe/website/catalog as preserved",
    preview.willPreserve.some((row) => row.includes("Stripe")) &&
      preview.willPreserve.some((row) => row.includes("catalog")) &&
      preview.willPreserve.some((row) => row.includes("Website")),
  );

  let rejected = false;
  try {
    await executeOperationalTestDataCleanup(prisma, {
      businessId: collpro.business.id,
      confirmation: "please delete",
      changedByMembershipId: collpro.membership.id,
    });
  } catch (error) {
    rejected = error instanceof TestDataCleanupError;
  }
  check("Wrong confirmation does not delete anything", rejected);
  check(
    "Wrong confirmation left the CollPro customer in place",
    (await prisma.customer.count({ where: { businessId: collpro.business.id } })) === 1,
  );

  const result = await executeOperationalTestDataCleanup(prisma, {
    businessId: collpro.business.id,
    confirmation: CLEAR_TEST_DATA_CONFIRMATION,
    changedByMembershipId: collpro.membership.id,
  });
  check("Confirmed cleanup reports the customer that was removed", result.willDelete.customers === 1);

  check(
    "CollPro customers were deleted",
    (await prisma.customer.count({ where: { businessId: collpro.business.id } })) === 0,
  );
  check(
    "CollPro requests were deleted",
    (await prisma.serviceRequest.count({ where: { businessId: collpro.business.id } })) === 0,
  );
  check(
    "CollPro estimates, jobs, invoices, and payments were deleted",
    (await prisma.estimate.count({ where: { businessId: collpro.business.id } })) === 0 &&
      (await prisma.job.count({ where: { businessId: collpro.business.id } })) === 0 &&
      (await prisma.invoice.count({ where: { businessId: collpro.business.id } })) === 0 &&
      (await prisma.payment.count({ where: { businessId: collpro.business.id } })) === 0,
  );
  check(
    "Customer photo stored assets were deleted",
    (await prisma.storedAsset.findUnique({ where: { id: collpro.customerPhoto.id } })) === null,
  );
  check(
    "Other tenant customer was not deleted",
    (await prisma.customer.count({ where: { businessId: other.business.id } })) === 1 &&
      (await prisma.customer.findUnique({ where: { id: other.customer.id } }))?.name === "Tim trump",
  );

  const keptBusiness = await prisma.business.findUnique({
    where: { id: collpro.business.id },
    include: {
      paymentAccount: true,
      settings: true,
      catalogItems: true,
      publicSiteImages: true,
      knowledgeEntries: true,
      storageAccount: true,
      unavailableDates: true,
    },
  });
  check("Business tenant row remains", Boolean(keptBusiness));
  check(
    "Labor minimum and public contact remain",
    keptBusiness?.laborMinimumEnabled === true &&
      keptBusiness?.laborMinimumAmount?.toString() === "95" &&
      keptBusiness?.publicPhone === "239-357-8199",
  );
  check(
    "Catalog and website content remain",
    keptBusiness?.catalogItems.length === 1 &&
      keptBusiness?.catalogItems[0].name === "Mailbox Replacement" &&
      keptBusiness?.publicSiteImages.length === 1 &&
      keptBusiness?.knowledgeEntries[0]?.title === "How we quote mailbox posts" &&
      keptBusiness?.settings?.approvedPublicAboutCopy === "Keep this About story.",
  );
  check(
    "Stripe Connect configuration remains",
    keptBusiness?.paymentAccount?.stripeAccountId === "acct_keep_collpro-reno",
  );
  check(
    "R2 storage account and website asset remain",
    Boolean(keptBusiness?.storageAccount) &&
      (await prisma.storedAsset.findUnique({ where: { id: collpro.websiteAsset.id } }))?.category ===
        "WEBSITE_IMAGE",
  );
  check(
    "Scheduling unavailable dates remain",
    keptBusiness?.unavailableDates[0]?.date === "2026-12-25",
  );
  check(
    "Ownership membership remains",
    (await prisma.membership.count({ where: { businessId: collpro.business.id } })) === 1,
  );
  check(
    "Cleanup wrote a settings audit row",
    (await prisma.settingsAuditLog.count({
      where: { businessId: collpro.business.id, settingKey: "clear_test_data" },
    })) === 1,
  );
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
  failed === 0
    ? `\nAll test-data-cleanup checks passed (${passed}).`
    : `\n${failed} test-data-cleanup check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
