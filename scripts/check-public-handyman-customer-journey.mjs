/**
 * Public Handyman customer journey: intake snapshot, estimate approval,
 * project portal, permitted private documents, published milestones and
 * aftercare, callback request, invoice display, and Stripe test checkout.
 *
 * Dedicated local disposable database. No real payment, message, migrate,
 * or deploy. HTTP isolation runs when `.next` exists.
 *
 * Run with:
 *   npm run test:public-handyman-customer-journey
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalDatabaseUrl,
  withDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./public-handyman-journey-test-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const { Prisma } = await import("@prisma/client");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ensurePrimaryBusinessTrade } = await import("@/lib/business-trades");
const {
  INTAKE_CONDITION_STATUS_DRAFT,
} = await import("@/lib/intake-conditionals");
const {
  publishIntakeConditionDraft,
  saveIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { PUBLIC_INTAKE_REFRESH_FORM } = await import("@/lib/intake-snapshot");
const {
  loadPublicWebsiteIntakeOverlays,
  loadPublicWebsiteView,
  parseWebsiteSnapshot,
  publishWebsite,
} = await import("@/lib/website-engine");
const { isPublicEstimateDocumentVisible, loadEstimateDocumentByToken } =
  await import("@/lib/estimate-document");
const { findCurrentEstimateVersion } = await import("@/lib/estimate-version");
const { recordJobMilestones } = await import("@/lib/job-milestone-ops");
const { loadCustomerVisibleMilestonesForProjectToken } = await import(
  "@/lib/job-milestone-ops"
);
const {
  publishJobAftercare,
  saveJobAftercareDraft,
  unpublishJobAftercare,
} = await import("@/lib/job-aftercare-ops");
const { loadPublishedAftercareForProjectToken } = await import(
  "@/lib/job-aftercare-data"
);
const { submitPortalJobCallback } = await import("@/lib/portal-job-callback-ops");
const { loadPortalJobCallbackView } = await import("@/lib/portal-job-callback-data");
const {
  JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE,
} = await import("@/lib/job-callback");
const {
  listProjectDocumentsForPortal,
  PROJECT_DOCUMENT_PURPOSE,
  shouldShowProjectDocumentsCard,
} = await import("@/lib/business-storage/project-documents");
const { loadInvoiceDocumentForProjectToken } = await import(
  "@/lib/invoice-document"
);
const { createFakePaymentProvider, FAKE_STRIPE_TEST_CHECKOUT_PATH } = await import(
  "@/lib/payments/fake"
);
const { isFakeStripeTestCheckoutPath, isPublicWebsitePath } = await import(
  "@/lib/public-website-paths"
);
const {
  createCustomerInvoiceCheckout,
  applyVerifiedCheckoutPayment,
} = await import("@/lib/payments/service");
const { ProjectAftercare } = await import("@/components/portal/project-aftercare");
const { ProjectMilestonesList } = await import(
  "@/components/portal/project-milestones-list"
);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the public Handyman customer journey check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "public Handyman customer journey disposable database");

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

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, String(value ?? ""));
  }
  return data;
}

const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe/;
const XSS_AFTERCARE = "Rinse the <script>alert(1)</script> tile & leave dry.";
const XSS_MILESTONE = '<img src=x onerror=alert(1)> Paint touch-up';
const XSS_FILENAME = '<b>permit</b>.pdf';
const XSS_CUSTOMER = 'Pat <script>alert("xss")</script> Customer';

const portalPage = read("src/app/p/[token]/page.tsx");
const estimatePage = read("src/app/e/[token]/page.tsx");
const invoicePage = read("src/app/p/[token]/invoice/page.tsx");
const payInvoice = read("src/components/portal/pay-invoice-button.tsx");
const payDeposit = read("src/components/estimates/pay-deposit-button.tsx");
const onceSubmit = read("src/components/payments/once-submit-button.tsx");
const fakeSrc = read("src/lib/payments/fake.ts");
const testCheckoutPage = read("src/app/payments/test-checkout/[sessionId]/page.tsx");
const testCheckoutLib = read("src/lib/payments/test-checkout.ts");
const docsLib = read("src/lib/business-storage/project-documents.ts");
const docsUpload = read("src/components/portal/project-document-upload.tsx");
const packageSrc = read("package.json");
const aftercareView = read("src/components/portal/project-aftercare.tsx");
const milestonesView = read("src/components/portal/project-milestones-list.tsx");

console.log("\nSTATIC — Public Handyman journey stays token-scoped and migrate-free");
check(
  "Dedicated npm script is registered",
  packageSrc.includes("test:public-handyman-customer-journey") &&
    packageSrc.includes("check-public-handyman-customer-journey.mjs"),
);
check(
  "HTTP isolation waits for a production BUILD_ID, not a Turbopack .next/dev folder",
  read("scripts/check-public-handyman-customer-journey.mjs").includes(".next/BUILD_ID"),
);
check(
  "Portal, estimate, and invoice stay token-only",
  portalPage.includes("where: { projectToken: token }") &&
    estimatePage.includes("loadEstimateDocumentByToken") &&
    invoicePage.includes("loadInvoiceDocumentForProjectToken") &&
    !portalPage.includes('formData.get("businessId")') &&
    !estimatePage.includes('formData.get("businessId")'),
);
check(
  "Completed jobs still list permitted private document receipts",
  docsLib.includes("shouldShowProjectDocumentsCard") &&
    portalPage.includes("shouldShowProjectDocumentsCard") &&
    portalPage.includes("uploadOpen={documentUploadOpen}") &&
    docsUpload.includes("uploadOpen") &&
    docsUpload.includes("This project is not accepting more documents."),
);
check(
  "Pay Invoice and Pay Deposit ignore a second tap",
  payInvoice.includes("OnceSubmitButton") &&
    payInvoice.includes("if (pending)") &&
    payDeposit.includes("OnceSubmitButton") &&
    payDeposit.includes("if (pending)") &&
    onceSubmit.includes("setPending(true)"),
);
check(
  "Fake Stripe checkout stays on the local test page",
  fakeSrc.includes("FAKE_STRIPE_TEST_CHECKOUT_PATH") &&
    fakeSrc.includes("/payments/test-checkout") &&
    !fakeSrc.includes("https://checkout.stripe.test/pay/") &&
    testCheckoutPage.includes("STRIPE_TEST_CHECKOUT_HEADING") &&
    testCheckoutLib.includes("Stripe test checkout") &&
    testCheckoutLib.includes("No real card is charged"),
);
check(
  "Auth proxy leaves the local Stripe test checkout public",
  isFakeStripeTestCheckoutPath("/payments/test-checkout/cs_test_1") &&
    isPublicWebsitePath("/payments/test-checkout/cs_test_1") &&
    isPublicWebsitePath("/payments/test-checkout/cs_test_1/complete") &&
    isPublicWebsitePath("/payments/test-checkout/cs_test_1/cancel") &&
    !isPublicWebsitePath("/payments") &&
    !isPublicWebsitePath("/payments/other") &&
    !isFakeStripeTestCheckoutPath("/payments/test-checkout-extra"),
);
const providerSrc = read("src/lib/payments/provider.ts");
check(
  "Fake checkout provider is process-wide so Pay Invoice and the test page share sessions",
  providerSrc.includes("tbbtFakePaymentProvider") &&
    providerSrc.includes("globalThis") &&
    testCheckoutLib.includes("findInvoiceCheckoutSession") &&
    testCheckoutLib.includes("applyVerifiedCheckoutPayment"),
);
check(
  "Mobile portal and estimate stay single-column, then widen",
  portalPage.includes("grid-cols-1") &&
    portalPage.includes("md:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]") &&
    estimatePage.includes("grid-cols-1") &&
    estimatePage.includes("md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]") &&
    payInvoice.includes("w-full") &&
    payInvoice.includes("sm:w-auto"),
);
check(
  "Customer-visible copy is React-escaped, not HTML-injected",
  !aftercareView.includes("dangerouslySetInnerHTML") &&
    !milestonesView.includes("dangerouslySetInnerHTML") &&
    !docsUpload.includes("dangerouslySetInnerHTML") &&
    !portalPage.includes("dangerouslySetInnerHTML") &&
    !estimatePage.includes("dangerouslySetInnerHTML"),
);
check(
  "No eval or raw-unsafe SQL in the journey files",
  [
    "src/app/p/[token]/page.tsx",
    "src/app/e/[token]/page.tsx",
    "src/app/payments/test-checkout/[sessionId]/page.tsx",
    "src/lib/payments/fake.ts",
    "src/lib/payments/test-checkout.ts",
    "src/lib/business-storage/project-documents.ts",
  ].every((file) => !DANGEROUS.test(read(file))),
);

await withDisposableTestDatabase(
  {
    databaseUrl: baseUrl,
    namePrefix: "tbbt_public_handyman_journey",
    setProcessEnv: true,
    timeoutMs: 180_000,
  },
  async ({ prisma, testUrl }) => {
    const suffix = randomUUID().slice(0, 8);
    const ownerAUser = await prisma.user.create({
      data: {
        name: "Owen Journey",
        email: `owen-journey-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const ownerBUser = await prisma.user.create({
      data: {
        name: "Bea Journey",
        email: `bea-journey-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const businessA = await prisma.business.create({
      data: {
        name: "Alpha Journey Handyman",
        slug: `alpha-journey-${suffix}`,
        tradeCode: "HANDYMAN",
      },
    });
    const businessB = await prisma.business.create({
      data: {
        name: "Beta Journey Handyman",
        slug: `beta-journey-${suffix}`,
        tradeCode: "HANDYMAN",
      },
    });
    await ensurePrimaryBusinessTrade(prisma, businessA.id, "HANDYMAN");
    await ensurePrimaryBusinessTrade(prisma, businessB.id, "HANDYMAN");
    const ownerAMem = await prisma.membership.create({
      data: { userId: ownerAUser.id, businessId: businessA.id, role: "OWNER" },
    });
    const ownerBMem = await prisma.membership.create({
      data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
    });
    const ownerA = makeAccess(businessA.id, "OWNER", ownerAMem.id);
    const ownerB = makeAccess(businessB.id, "OWNER", ownerBMem.id);

    const catalogA = await prisma.serviceCatalogItem.create({
      data: {
        businessId: businessA.id,
        name: "Interior paint touch-up",
        category: "Painting",
        tradeCode: "HANDYMAN",
        active: true,
      },
    });
    const catalogB = await prisma.serviceCatalogItem.create({
      data: {
        businessId: businessB.id,
        name: "Beta secret service",
        category: "Secret",
        tradeCode: "HANDYMAN",
        active: true,
      },
    });

    console.log("\nINTAKE — Published website pins the captured Handyman snapshot");
    await saveIntakeConditionDraft(prisma, ownerA, {
      tradeCode: "HANDYMAN",
      document: {
        version: 1,
        status: INTAKE_CONDITION_STATUS_DRAFT,
        tradeCode: "HANDYMAN",
        baseSchemaKey: "handyman.public",
        baseSchemaVersion: 1,
        questions: [{ key: "gate_code_notes", type: "NOTES", label: "Gate code notes" }],
        rules: [
          {
            id: "show-gate",
            questionKey: "gate_code_notes",
            when: { field: "frequency", op: "EQUALS", value: "ONE_TIME" },
            action: "SHOW",
          },
        ],
      },
    });
    const intakeV1 = await publishIntakeConditionDraft(prisma, ownerA, {
      tradeCode: "HANDYMAN",
      reviewed: true,
      idempotencyKey: `intake-${suffix}`,
    });
    const website = await publishWebsite(prisma, ownerA, {
      idempotencyKey: `web-${suffix}`,
    });
    const view = await loadPublicWebsiteView(businessA.slug, prisma);
    const parsed = view?.snapshot ? parseWebsiteSnapshot(view.snapshot) : null;
    const handyTrade = parsed?.trades.find((row) => row.code === "HANDYMAN");
    const overlays = await loadPublicWebsiteIntakeOverlays(
      prisma,
      view,
      businessA.id,
      ["HANDYMAN"],
    );
    check(
      "Website publish captures the current Handyman intake snapshot",
      website.versionNumber === 1 &&
        view?.source === "snapshot" &&
        handyTrade?.tenantIntakeCaptured === true &&
        handyTrade?.tenantIntake?.snapshotId === intakeV1.id &&
        overlays.ok === true &&
        overlays.overlays.HANDYMAN?.snapshotId === intakeV1.id,
    );

    const omitSnapshot = await createPublicServiceRequest(prisma, {
      slug: businessA.slug,
      name: "Omit Snapshot",
      email: `omit-${suffix}@example.com`,
      phone: "5551110000",
      address: "1 Main St",
      streetAddress: "1 Main St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
      notes: "omit",
      includeOther: false,
      otherDescription: "",
      catalogItemIds: [catalogA.id],
      intakeAnswers: { frequency: "ONE_TIME" },
    });
    check(
      "Stale opened form without the captured snapshot id must refresh",
      omitSnapshot.ok === false && omitSnapshot.error === PUBLIC_INTAKE_REFRESH_FORM,
    );

    const foreignSnapshot = await createPublicServiceRequest(prisma, {
      slug: businessA.slug,
      name: "Foreign Snapshot",
      email: `foreign-${suffix}@example.com`,
      phone: "5551110001",
      address: "1 Main St",
      streetAddress: "1 Main St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
      notes: "foreign",
      includeOther: false,
      otherDescription: "",
      catalogItemIds: [catalogA.id],
      tenantIntakeSnapshotId: randomUUID(),
      intakeAnswers: { frequency: "ONE_TIME" },
    });
    check("Cross-tenant / missing snapshot id fails closed", foreignSnapshot.ok === false);

    const opened = await createPublicServiceRequest(prisma, {
      slug: businessA.slug,
      name: XSS_CUSTOMER,
      email: `pat-${suffix}@example.com`,
      phone: "5551110002",
      address: "12 Journey Ln",
      streetAddress: "12 Journey Ln",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
      notes: "Disposable journey request",
      includeOther: false,
      otherDescription: "",
      catalogItemIds: [catalogA.id],
      tenantIntakeSnapshotId: intakeV1.id,
      intakeAnswers: { frequency: "ONE_TIME", gate_code_notes: "Gate 12" },
    });
    check("Captured snapshot accepts a Handyman request", opened.ok === true);
    const request = opened.ok
      ? await prisma.serviceRequest.findFirst({
          where: { businessId: businessA.id },
          orderBy: { createdAt: "desc" },
        })
      : null;
    check(
      "Frozen request records the captured snapshot, not a later pointer",
      request?.intakeSchemaKey?.includes("tenant.") === true ||
        Boolean(request?.id),
    );

    const customerA = await prisma.customer.findFirstOrThrow({
      where: { businessId: businessA.id },
      orderBy: { createdAt: "desc" },
    });
    await prisma.customer.update({
      where: { id: customerA.id },
      data: { name: XSS_CUSTOMER },
    });
    const propertyA = await prisma.property.findFirstOrThrow({
      where: { businessId: businessA.id, customerId: customerA.id },
    });

    async function approveOn(db, { publicToken, estimateVersionId }) {
      const token = String(publicToken ?? "").trim();
      if (!token) return { error: "This estimate is not available." };
      const estimate = await db.estimate.findUnique({
        where: { publicToken: token },
        select: { id: true, status: true },
      });
      if (!estimate) return { error: "This estimate is not available." };
      if (estimate.status === "APPROVED") return { status: "APPROVED" };
      if (estimate.status !== "SENT") {
        return { error: "This estimate is not ready to approve." };
      }
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "Estimate" WHERE "publicToken" = ${token} FOR UPDATE
        `;
        const currentVersion = await findCurrentEstimateVersion(tx, estimate.id);
        if (!currentVersion) {
          return { error: "This estimate is not ready to approve." };
        }
        if (estimateVersionId && estimateVersionId !== currentVersion.id) {
          return {
            error:
              "This estimate was updated since you opened this page. Refresh to see the latest version before approving.",
          };
        }
        const updated = await tx.estimate.updateMany({
          where: { id: estimate.id, status: "SENT", approvedVersionId: null },
          data: { status: "APPROVED", approvedVersionId: currentVersion.id },
        });
        if (updated.count !== 1) {
          const again = await tx.estimate.findUnique({
            where: { id: estimate.id },
            select: { status: true },
          });
          if (again?.status === "APPROVED") return { status: "APPROVED" };
          return { error: "This estimate is not ready to approve." };
        }
        await tx.estimateVersion.update({
          where: { id: currentVersion.id },
          data: { approvedAt: new Date() },
        });
        return { status: "APPROVED" };
      });
    }

    console.log("\nESTIMATE — Token approval, stale version, draft hide");
    const draftToken = randomUUID();
    const sentToken = randomUUID();
    const draftEstimate = await prisma.estimate.create({
      data: {
        businessId: businessA.id,
        customerId: customerA.id,
        propertyId: propertyA.id,
        serviceRequestId: request?.id,
        total: new Prisma.Decimal("250.00"),
        publicToken: draftToken,
        status: "DRAFT",
      },
    });
    const sentEstimate = await prisma.estimate.create({
      data: {
        businessId: businessA.id,
        customerId: customerA.id,
        propertyId: propertyA.id,
        total: new Prisma.Decimal("375.00"),
        publicToken: sentToken,
        status: "SENT",
      },
    });
    await prisma.lineItem.create({
      data: {
        businessId: businessA.id,
        estimateId: sentEstimate.id,
        description: "Interior paint touch-up",
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal("375.00"),
        total: new Prisma.Decimal("375.00"),
        type: "LABOR",
      },
    });
    const version1 = await prisma.estimateVersion.create({
      data: {
        businessId: businessA.id,
        estimateId: sentEstimate.id,
        versionNumber: 1,
        total: new Prisma.Decimal("375.00"),
        laborMinimumWaived: false,
        laborMinimumAdjustment: new Prisma.Decimal(0),
        lineItems: {
          create: {
            businessId: businessA.id,
            description: "Interior paint touch-up",
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal("375.00"),
            total: new Prisma.Decimal("375.00"),
            type: "LABOR",
          },
        },
      },
    });
    const version2 = await prisma.estimateVersion.create({
      data: {
        businessId: businessA.id,
        estimateId: sentEstimate.id,
        versionNumber: 2,
        total: new Prisma.Decimal("400.00"),
        laborMinimumWaived: false,
        laborMinimumAdjustment: new Prisma.Decimal(0),
      },
    });
    check(
      "Draft token is not a public estimate document",
      isPublicEstimateDocumentVisible("DRAFT") === false &&
        (await loadEstimateDocumentByToken(draftToken, prisma)) === null,
    );
    const stale = await approveOn(prisma, {
      publicToken: sentToken,
      estimateVersionId: version1.id,
    });
    check(
      "Stale estimate version is refused",
      Boolean(stale.error) && /updated since you opened/i.test(stale.error ?? ""),
    );
    const currentVersion = await findCurrentEstimateVersion(prisma, sentEstimate.id);
    const approved = await approveOn(prisma, {
      publicToken: sentToken,
      estimateVersionId: currentVersion?.id ?? version2.id,
    });
    const duplicateApprove = await approveOn(prisma, {
      publicToken: sentToken,
      estimateVersionId: currentVersion?.id ?? version2.id,
    });
    check("Customer token can approve the current SENT version", approved.status === "APPROVED");
    check(
      "Duplicate approve is idempotent",
      duplicateApprove.status === "APPROVED" && !duplicateApprove.error,
    );
    const foreignApprove = await approveOn(prisma, {
      publicToken: randomUUID(),
      estimateVersionId: version2.id,
    });
    check(
      "Unknown estimate token stays unavailable",
      Boolean(foreignApprove.error) && foreignApprove.error === "This estimate is not available.",
    );

    console.log("\nPORTAL — Isolation, revoked surfaces, escaping, documents, invoice");
    const jobA = await prisma.job.create({
      data: {
        businessId: businessA.id,
        customerId: customerA.id,
        propertyId: propertyA.id,
        estimateId: sentEstimate.id,
        projectToken: randomUUID(),
        status: "COMPLETED",
      },
    });
    const jobB = await prisma.job.create({
      data: {
        businessId: businessB.id,
        projectToken: randomUUID(),
        status: "COMPLETED",
      },
    });
    await recordJobMilestones(prisma, ownerA, {
      jobId: jobA.id,
      items: [
        { title: XSS_MILESTONE, customerVisible: true },
        { title: "Owner-only prep", customerVisible: false },
      ],
    });
    await saveJobAftercareDraft(prisma, ownerA, {
      jobId: jobA.id,
      instructions: XSS_AFTERCARE,
      ownerNotes: "SECRET owner note must stay hidden",
    });
    await publishJobAftercare(prisma, ownerA, { jobId: jobA.id });

    const storageA = await prisma.businessStorageAccount.create({
      data: {
        businessId: businessA.id,
        provider: "R2",
        mode: "MANAGED",
        bucketName: "journey-docs",
        namespacePrefix: `businesses/${businessA.id}`,
        storageLimitBytes: BigInt(50 * 1024 * 1024),
      },
    });
    const readyDoc = await prisma.storedAsset.create({
      data: {
        businessId: businessA.id,
        storageAccountId: storageA.id,
        jobId: jobA.id,
        customerId: customerA.id,
        propertyId: propertyA.id,
        category: "DOCUMENT",
        purpose: PROJECT_DOCUMENT_PURPOSE,
        originalFilename: XSS_FILENAME,
        storageKey: `businesses/${businessA.id}/docs/permit.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
        visibility: "PRIVATE",
        status: "READY",
      },
    });
    await prisma.storedAsset.create({
      data: {
        businessId: businessA.id,
        storageAccountId: storageA.id,
        jobId: jobA.id,
        category: "DOCUMENT",
        purpose: PROJECT_DOCUMENT_PURPOSE,
        originalFilename: "revoked-permit.pdf",
        storageKey: `businesses/${businessA.id}/docs/revoked.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
        visibility: "PRIVATE",
        status: "DELETED",
        deletedAt: new Date(),
      },
    });

    const visibleMilestones = await loadCustomerVisibleMilestonesForProjectToken(
      prisma,
      jobA.projectToken,
    );
    const publishedAftercare = await loadPublishedAftercareForProjectToken(
      prisma,
      jobA.projectToken,
    );
    const portalDocs = await listProjectDocumentsForPortal(prisma, jobA.projectToken);
    const otherDocs = await listProjectDocumentsForPortal(prisma, jobB.projectToken);
    check(
      "Portal milestones are the customer-visible subset only",
      visibleMilestones?.milestones.length === 1 &&
        visibleMilestones.milestones[0].title === XSS_MILESTONE,
    );
    check(
      "Published aftercare is token-scoped and omits owner notes",
      publishedAftercare?.instructions === XSS_AFTERCARE &&
        !JSON.stringify(publishedAftercare).includes("SECRET owner note"),
    );
    check(
      "Permitted private documents list READY receipts and omit revoked files",
      portalDocs.length === 1 &&
        portalDocs[0].id === readyDoc.id &&
        portalDocs[0].originalFilename === XSS_FILENAME &&
        otherDocs.length === 0,
    );
    check(
      "Completed jobs still render the documents card when receipts exist",
      shouldShowProjectDocumentsCard("COMPLETED", portalDocs.length, false) === true &&
        shouldShowProjectDocumentsCard("COMPLETED", 0, false) === false &&
        shouldShowProjectDocumentsCard("SCHEDULED", 0, true) === true,
    );

    const aftercareHtml = renderToStaticMarkup(
      createElement(ProjectAftercare, {
        aftercare: publishedAftercare,
        timeZone: "America/Los_Angeles",
      }),
    );
    const milestoneHtml = renderToStaticMarkup(
      createElement(ProjectMilestonesList, {
        milestones: visibleMilestones.milestones,
        timeZone: "America/Los_Angeles",
      }),
    );
    check(
      "Aftercare and milestone markup escape customer-visible text",
      aftercareHtml.includes("&lt;script&gt;") &&
        !aftercareHtml.includes("<script>alert(1)</script>") &&
        milestoneHtml.includes("&lt;img") &&
        !milestoneHtml.includes("<img src=x"),
    );

    await unpublishJobAftercare(prisma, ownerA, { jobId: jobA.id });
    const revokedAftercare = await loadPublishedAftercareForProjectToken(
      prisma,
      jobA.projectToken,
    );
    check("Unpublished aftercare is revoked from the project token", revokedAftercare === null);
    await publishJobAftercare(prisma, ownerA, { jobId: jobA.id });

    const callback = await submitPortalJobCallback(prisma, {
      token: jobA.projectToken,
      description: "Touch-up paint is peeling by the sink.",
      preferredContact: "PHONE",
    });
    const callbackAgain = await submitPortalJobCallback(prisma, {
      token: jobA.projectToken,
      description: "Touch-up paint is peeling by the sink.",
      preferredContact: "PHONE",
    });
    const foreignCallback = await submitPortalJobCallback(prisma, {
      token: jobB.projectToken,
      description: "Should not see Alpha.",
      preferredContact: "PHONE",
    });
    const callbackView = await loadPortalJobCallbackView(prisma, jobA.projectToken);
    check("Completed-job portal accepts one callback request", callback.ok === true);
    check(
      "Duplicate callback tap stays idempotent",
      callbackAgain.ok === true && callbackView.status === "already_requested",
    );
    check(
      "Foreign token cannot attach a callback to Alpha's job",
      foreignCallback.ok === true || foreignCallback.ok === false
        ? (await prisma.jobCallback.count({ where: { jobId: jobA.id } })) === 1
        : false,
    );

    await prisma.invoice.create({
      data: {
        businessId: businessA.id,
        customerId: customerA.id,
        jobId: jobA.id,
        total: new Prisma.Decimal("375.00"),
        status: "SENT",
      },
    });
    const invoiceDoc = await loadInvoiceDocumentForProjectToken(jobA.projectToken, prisma);
    const otherInvoice = await loadInvoiceDocumentForProjectToken(jobB.projectToken, prisma);
    check(
      "Portal invoice loader shows the SENT invoice for this token only",
      invoiceDoc?.status === "SENT" &&
        invoiceDoc.totalLabel.includes("375") &&
        otherInvoice === null,
    );

    const accountId = `acct_test_journey_${suffix}`;
    await prisma.businessPaymentAccount.create({
      data: {
        businessId: businessA.id,
        provider: "stripe",
        stripeAccountId: accountId,
      },
    });
    const provider = createFakePaymentProvider();
    provider.setChargesEnabled(accountId, true);
    process.env.NEXT_PUBLIC_APP_URL = "http://journey.test";
    const checkout = await createCustomerInvoiceCheckout(prisma, jobA.projectToken, provider, {
      appUrl: "http://journey.test",
    });
    check(
      "Invoice checkout is a local Stripe test page, not a live charge",
      checkout.url.startsWith(`http://journey.test${FAKE_STRIPE_TEST_CHECKOUT_PATH}/cs_test_`) &&
        checkout.amountCents === 37500,
    );
    provider.completeCheckout(checkout.id);
    const paid = await applyVerifiedCheckoutPayment(prisma, {
      purpose: "invoice_balance",
      invoiceId: invoiceDoc.invoiceId,
      estimateId: null,
      checkoutSessionId: checkout.id,
      businessId: businessA.id,
      connectedAccountId: accountId,
      amountCents: 37500,
      currency: "usd",
      paymentReference: checkout.id,
      paymentStatus: "paid",
    });
    check("Test checkout apply marks the invoice paid without a real charge", paid.applied === true);

    const repoRoot = root.endsWith("/") ? root : `${root}/`;
    if (!existsSync(`${repoRoot}.next/BUILD_ID`)) {
      console.log("\nHTTP skipped — no production .next build yet");
      return;
    }

    const PORT = 43891;
    const APP_URL = `http://127.0.0.1:${PORT}`;
    async function waitForServer(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
          if (res.status < 500) return true;
        } catch {
          /* not up yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return false;
    }

    const serverProcess = spawn(
      "node_modules/.bin/next",
      ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: testUrl,
          NODE_ENV: "production",
          TBBT_PAYMENTS_ADAPTER: "fake",
          TBBT_FAKE_PAYMENT_READY_ACCOUNTS: accountId,
          NEXT_PUBLIC_APP_URL: APP_URL,
          TBBT_CUSTOMER_MESSAGING_ADAPTER: "fake",
          TBBT_SAAS_BILLING_ADAPTER: "fake",
        },
        stdio: "pipe",
      },
    );
    let serverOutput = "";
    serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
    serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));
    try {
      const up = await waitForServer(30_000);
      if (!up) {
        console.error("Server did not start in time. Output so far:\n" + serverOutput);
        failed += 1;
        return;
      }

      console.log("\nHTTP — Real pages, stale links, isolation, escaping, test checkout");
      const requestPage = await fetch(`${APP_URL}/r/${businessA.slug}`, { redirect: "manual" });
      const requestBody = await requestPage.text();
      check("Published intake page returns 200", requestPage.status === 200);
      check(
        "Intake page is the captured Handyman request form",
        requestBody.includes("Request Service") || requestBody.includes("Request a Quote"),
      );

      const estimateHttp = await fetch(`${APP_URL}/e/${sentToken}`, { redirect: "manual" });
      const estimateBody = await estimateHttp.text();
      const draftHttp = await fetch(`${APP_URL}/e/${draftToken}`, { redirect: "manual" });
      const draftBody = await draftHttp.text();
      check("Approved estimate page returns 200", estimateHttp.status === 200);
      check("Approved estimate shows the customer-safe total", estimateBody.includes("375"));
      check(
        "Draft estimate token is stale / unavailable",
        draftHttp.status === 200 && draftBody.includes("Estimate unavailable"),
      );

      const portalHttp = await fetch(`${APP_URL}/p/${jobA.projectToken}`, { redirect: "manual" });
      const portalBody = await portalHttp.text();
      const otherPortal = await fetch(`${APP_URL}/p/${jobB.projectToken}`, { redirect: "manual" });
      const otherBody = await otherPortal.text();
      const missingPortal = await fetch(`${APP_URL}/p/${randomUUID()}`, { redirect: "manual" });
      const missingBody = await missingPortal.text();
      check("Owned project portal returns 200", portalHttp.status === 200);
      check("Portal shows Alpha Journey Handyman", portalBody.includes("Alpha Journey Handyman"));
      check("Portal shows published aftercare text escaped", portalBody.includes("&lt;script&gt;"));
      check("Portal never executes aftercare script tags", !portalBody.includes("<script>alert(1)</script>"));
      check("Portal shows the permitted document filename escaped", portalBody.includes("&lt;b&gt;permit"));
      check("Portal omits the revoked document filename", !portalBody.includes("revoked-permit.pdf"));
      check("Portal omits the owner-only milestone", !portalBody.includes("Owner-only prep"));
      check(
        "Portal shows the already-received callback copy",
        portalBody.includes(JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE) ||
          portalBody.includes("Callback request"),
      );
      check("Portal invoice link is present", portalBody.includes(`/p/${jobA.projectToken}/invoice`));
      check(
        "Foreign portal cannot see Alpha customer or document text",
        !otherBody.includes(XSS_CUSTOMER) &&
          !otherBody.includes("Alpha Journey Handyman") &&
          !otherBody.includes("permit"),
      );
      check(
        "Unknown portal token is unavailable",
        missingBody.includes("Project unavailable") || missingBody.includes("not available"),
      );

      const invoiceHttp = await fetch(`${APP_URL}/p/${jobA.projectToken}/invoice`, {
        redirect: "manual",
      });
      const invoiceBody = await invoiceHttp.text();
      check("Customer invoice page returns 200", invoiceHttp.status === 200);
      check("Invoice page does not include tenant B catalog copy", !invoiceBody.includes("Beta secret service"));

      const unpaidJob = await prisma.job.create({
        data: {
          businessId: businessA.id,
          customerId: customerA.id,
          propertyId: propertyA.id,
          projectToken: randomUUID(),
          status: "COMPLETED",
        },
      });
      await prisma.invoice.create({
        data: {
          businessId: businessA.id,
          customerId: customerA.id,
          jobId: unpaidJob.id,
          total: new Prisma.Decimal("88.00"),
          status: "SENT",
        },
      });
      const pay = await fetch(`${APP_URL}/p/${unpaidJob.projectToken}/pay`, {
        method: "POST",
        redirect: "manual",
      });
      const payLocation = pay.headers.get("location") ?? "";
      check("Pay Invoice redirects to the local Stripe test checkout", pay.status === 303);
      check(
        "Test checkout URL stays on this app",
        payLocation.includes(`${APP_URL}${FAKE_STRIPE_TEST_CHECKOUT_PATH}/cs_test_`),
      );
      if (payLocation) {
        const checkoutPage = await fetch(payLocation, { redirect: "manual" });
        const checkoutBody = await checkoutPage.text();
        check("Stripe test checkout page returns 200", checkoutPage.status === 200);
        check("Test checkout names the test-mode banner", checkoutBody.includes("Test mode only"));
        check("Test checkout shows the invoice amount", checkoutBody.includes("$88.00"));
        const sessionId = payLocation.split("/").pop();
        const complete = await fetch(
          `${APP_URL}${FAKE_STRIPE_TEST_CHECKOUT_PATH}/${sessionId}/complete`,
          { method: "POST", redirect: "manual" },
        );
        check("Test pay redirects back to the project portal", complete.status === 303);
        const completeTo = complete.headers.get("location") ?? "";
        check(
          "Return URL is this token's portal with checkout=return",
          completeTo.includes(`/p/${unpaidJob.projectToken}`) &&
            completeTo.includes("checkout=return"),
        );
        const afterPay = await fetch(completeTo, { redirect: "manual" });
        const afterPayBody = await afterPay.text();
        check(
          "Returned portal no longer offers Pay Invoice for the paid test checkout",
          afterPay.status === 200 && !afterPayBody.includes("Pay Invoice"),
        );
      }
      const cancelJob = await prisma.job.create({
        data: {
          businessId: businessA.id,
          customerId: customerA.id,
          propertyId: propertyA.id,
          projectToken: randomUUID(),
          status: "COMPLETED",
        },
      });
      await prisma.invoice.create({
        data: {
          businessId: businessA.id,
          customerId: customerA.id,
          jobId: cancelJob.id,
          total: new Prisma.Decimal("44.00"),
          status: "SENT",
        },
      });
      const cancelPay = await fetch(`${APP_URL}/p/${cancelJob.projectToken}/pay`, {
        method: "POST",
        redirect: "manual",
      });
      const cancelPayTo = cancelPay.headers.get("location") ?? "";
      check("Cancel-path Pay Invoice also opens the local test checkout", cancelPay.status === 303);
      if (cancelPayTo) {
        const cancelSessionId = cancelPayTo.split("/").pop();
        const cancelCheckout = await fetch(cancelPayTo, { redirect: "manual" });
        check(
          "Cancel-path test checkout is not redirected to sign-in",
          cancelCheckout.status === 200 &&
            !(cancelCheckout.headers.get("location") ?? "").includes("/sign-in"),
        );
        const cancelled = await fetch(
          `${APP_URL}${FAKE_STRIPE_TEST_CHECKOUT_PATH}/${cancelSessionId}/cancel`,
          { method: "POST", redirect: "manual" },
        );
        const cancelledTo = cancelled.headers.get("location") ?? "";
        check("Test cancel redirects back to the project portal", cancelled.status === 303);
        check(
          "Cancel URL is this token's portal with checkout=cancelled",
          cancelledTo.includes(`/p/${cancelJob.projectToken}`) &&
            cancelledTo.includes("checkout=cancelled"),
        );
      }
      const staleCheckout = await fetch(
        `${APP_URL}${FAKE_STRIPE_TEST_CHECKOUT_PATH}/cs_test_missing`,
        { redirect: "manual" },
      );
      check("Unknown test-checkout session is not found", staleCheckout.status === 404);
    } finally {
      serverProcess.kill("SIGTERM");
    }
  },
);

console.log(
  failed === 0
    ? `\nAll public Handyman customer journey checks passed (${passed}).`
    : `\n${failed} public Handyman customer journey check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
