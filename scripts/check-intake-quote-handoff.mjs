/**
 * Intake → quote handoff: owner-only request photos/measurements on the
 * estimate builder, calculator prefill from stored axes, HEIC/size on the
 * existing private R2 request-photo path.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-intake-quote-handoff.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  REQUEST_PHOTO_MAX_BYTES,
  MemoryStorageProvider,
  privateAssetContentDisposition,
  privateAssetPath,
} = await import("@/lib/business-storage/index");
const {
  inspectRequestPhotoUpload,
  requestPhotoMaxBytesLabel,
} = await import("@/lib/business-storage/request-photo-rules");
const { putPublicRequestPhotoFromBytes } = await import(
  "@/lib/business-storage/request-photos"
);
const { servePrivateStoredAsset } = await import(
  "@/lib/business-storage/private-serve"
);
const { servePublicStoredAsset } = await import(
  "@/lib/business-storage/public-serve"
);
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const {
  CUSTOMER_REPORTED_MEASUREMENT_LABEL,
  calculatorPrefillFromStoredMeasurement,
  convertLinearMeasurement,
  customerReportedMeasurementForCatalog,
  isBrowserPreviewableRequestPhoto,
  isRequestHeicMimeType,
  ownerVisibleRequestMeasurements,
  ownerVisibleRequestPhotos,
  toStoredIntakeMeasurement,
} = await import("@/lib/intake-quote-handoff");
const {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  formCalculatorInputs,
  startingCalculatorSnapshot,
} = await import("@/lib/estimate-calculators");
const { joinCatalogDescription, lineCalculatorSnapshot } = await import(
  "@/lib/estimate-line-scope"
);
const { buildEstimateLineCreatesFromRequestItems } = await import(
  "@/lib/request-estimate-draft"
);
const { estimateDocumentPlainText, loadEstimateDocumentByToken } = await import(
  "@/lib/estimate-document"
);
const { CUSTOMER_REPORTED_MEASUREMENT } = await import("@/lib/catalog-intake");

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

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

console.log("\nSTATIC — Owner estimate vs customer surfaces");
const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const customerPage = readRepo("src/app/e/[token]/page.tsx");
const printPage = readRepo("src/app/(invoice-document)/e/[token]/print/page.tsx");
const documentView = readRepo("src/components/estimates/estimate-document.tsx");
const jobPhoto = readRepo("src/app/actions/job-photo.ts");
const expenseAction = readRepo("src/app/actions/expenses.ts");
const storageBlob = readRepo("src/lib/storage.ts");

check(
  "Owner estimate builder renders RequestIntakeContext",
  ownerPage.includes("RequestIntakeContext") &&
    ownerPage.includes("ownerVisibleRequestPhotos") &&
    ownerPage.includes("ownerVisibleRequestMeasurements"),
);
check(
  "Customer estimate, print, and document do not import private intake context",
  !customerPage.includes("RequestIntakeContext") &&
    !customerPage.includes("ownerVisibleRequestPhotos") &&
    !printPage.includes("RequestIntakeContext") &&
    !documentView.includes("RequestIntakeContext") &&
    !documentView.includes("/api/storage/private/"),
);
check(
  "Job photos and expense receipts still use the Blob helper",
  jobPhoto.includes("@/lib/storage") &&
    expenseAction.includes("uploadExpenseReceipt") &&
    storageBlob.includes("MAX_JOB_PHOTO_UPLOAD_BYTES = 4 * 1024 * 1024"),
);
check(
  "Private photo route sends Content-Disposition",
  readRepo("src/app/api/storage/private/[assetId]/route.ts").includes(
    "Content-Disposition",
  ),
);

console.log("\nUNIT — Phone photo acceptance");
check("Intake photo limit is 12 MB", REQUEST_PHOTO_MAX_BYTES === 12 * 1024 * 1024);
check("Limit label is 12 MB", requestPhotoMaxBytesLabel() === "12 MB");
check(
  "JPEG still accepted",
  inspectRequestPhotoUpload({ type: "image/jpeg", name: "a.jpg", size: 800 }).ok === true,
);
check(
  "HEIC accepted by MIME type",
  inspectRequestPhotoUpload({
    type: "image/heic",
    name: "IMG_1001.HEIC",
    size: 5 * 1024 * 1024,
  }).ok === true &&
    inspectRequestPhotoUpload({
      type: "image/heic",
      name: "IMG_1001.HEIC",
      size: 5 * 1024 * 1024,
    }).mimeType === "image/heic",
);
check(
  "HEIF accepted by extension when type is empty",
  inspectRequestPhotoUpload({
    type: "",
    name: "IMG_1002.heif",
    size: 2 * 1024 * 1024,
  }).mimeType === "image/heif",
);
check(
  "GIF remains rejected on the request-photo path",
  inspectRequestPhotoUpload({ type: "image/gif", name: "x.gif", size: 100 }).ok === false,
);
check(
  "12 MB photo is accepted",
  inspectRequestPhotoUpload({
    type: "image/jpeg",
    name: "phone.jpg",
    size: REQUEST_PHOTO_MAX_BYTES,
  }).ok === true,
);
check(
  "Over-limit photo is rejected",
  inspectRequestPhotoUpload({
    type: "image/jpeg",
    name: "huge.jpg",
    size: REQUEST_PHOTO_MAX_BYTES + 1,
  }).ok === false,
);
check(
  "HEIC is not treated as a browser-previewable request photo",
  isRequestHeicMimeType("image/heic") &&
    isBrowserPreviewableRequestPhoto("image/heic") === false &&
    isBrowserPreviewableRequestPhoto("image/jpeg") === true,
);
check(
  "HEIC private download uses attachment disposition",
  privateAssetContentDisposition({
    mimeType: "image/heic",
    originalFilename: "IMG_1001.HEIC",
  }).startsWith("attachment;") &&
    privateAssetContentDisposition({
      mimeType: "image/jpeg",
      originalFilename: "window.jpg",
    }).startsWith("inline;"),
);

console.log("\nUNIT — Measurement mapping and overwrite protection");
check(
  "Inches convert to feet without inventing a new unit",
  convertLinearMeasurement(48, "IN", "FT") === 4 &&
    convertLinearMeasurement(4, "FT", "IN") === 48 &&
    convertLinearMeasurement(32, "IN", "IN") === 32,
);
const panelingPrefill = calculatorPrefillFromStoredMeasurement({
  measurement: {
    catalogItemId: "panel",
    source: CUSTOMER_REPORTED_MEASUREMENT,
    width: 96,
    height: 96,
    length: 12,
    quantity: 2,
    unit: "IN",
  },
  calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
});
check(
  "Matching width/height prefills existing paneling fields as feet",
  panelingPrefill.applied.wallWidthFt === 8 &&
    panelingPrefill.applied.wallHeightFt === 8,
);
check(
  "Length and quantity are not forced into paneling (no matching linear field / no takeoff)",
  panelingPrefill.applied.panelQuantity == null &&
    panelingPrefill.skipped.includes("length"),
);
const preserved = calculatorPrefillFromStoredMeasurement({
  measurement: {
    catalogItemId: "panel",
    source: CUSTOMER_REPORTED_MEASUREMENT,
    width: 96,
    height: 96,
    length: null,
    quantity: null,
    unit: "IN",
  },
  calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  existingInputs: { wallWidthFt: 12, wallHeightFt: 0 },
});
check(
  "Intentional calculator width is not overwritten",
  preserved.applied.wallWidthFt == null &&
    preserved.applied.wallHeightFt === 8 &&
    preserved.skipped.includes("width:existing"),
);
const unknown = calculatorPrefillFromStoredMeasurement({
  measurement: {
    catalogItemId: "blinds",
    source: CUSTOMER_REPORTED_MEASUREMENT,
    width: 32,
    height: 48,
    length: null,
    quantity: 1,
    unit: "IN",
  },
  calculatorId: null,
  components: [],
});
check(
  "Unknown/incompatible calculator does not receive forced measurements",
  Object.keys(unknown.applied).length === 0 &&
    unknown.skipped.includes("no-matching-calculator-fields"),
);

const emptySnapshot = startingCalculatorSnapshot({
  title: DECORATIVE_WALL_PANELING_TITLE,
  definition: {
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  },
  prefillInputs: {
    contentsHandlingLevel: "light",
    wallWidthFt: 8,
    wallHeightFt: 8,
  },
});
check(
  "startingCalculatorSnapshot keeps work-area prefill and stored dimensions",
  emptySnapshot?.inputs.contentsHandlingLevel === "light" &&
    emptySnapshot?.inputs.wallWidthFt === 8 &&
    emptySnapshot?.inputs.wallHeightFt === 8 &&
    emptySnapshot?.appliedAmount == null,
);
const formInputs = formCalculatorInputs({
  calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  snapshot: emptySnapshot,
  rates: emptySnapshot?.rates,
  components: emptySnapshot?.components,
});
check(
  "Unapplied form still shows prefilled dimensions (not reset to empty)",
  formInputs.wallWidthFt === 8 &&
    formInputs.wallHeightFt === 8 &&
    formInputs.contentsHandlingLevel === "light",
);
const overwriteSnapshot = startingCalculatorSnapshot({
  title: DECORATIVE_WALL_PANELING_TITLE,
  definition: {
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  },
  snapshot: {
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
    inputs: { wallWidthFt: 12, wallHeightFt: 10 },
  },
  prefillInputs: { wallWidthFt: 8, wallHeightFt: 8 },
});
check(
  "Existing snapshot dimensions win over later measurement prefill",
  overwriteSnapshot?.inputs.wallWidthFt === 12 &&
    overwriteSnapshot?.inputs.wallHeightFt === 10,
);

const photos = ownerVisibleRequestPhotos({
  businessId: "biz-a",
  serviceRequestId: "req-a",
  photos: [
    {
      id: "p1",
      businessId: "biz-a",
      serviceRequestId: "req-a",
      url: "/api/storage/private/asset-a",
      storedAssetId: "asset-a",
      storedAsset: {
        mimeType: "image/jpeg",
        originalFilename: "window.jpg",
        visibility: "PRIVATE",
        category: "CUSTOMER_PHOTO",
        status: "READY",
        publicPath: null,
      },
    },
    {
      id: "p-foreign",
      businessId: "biz-b",
      serviceRequestId: "req-a",
      url: "/api/storage/private/asset-b",
      storedAssetId: "asset-b",
      storedAsset: {
        mimeType: "image/jpeg",
        originalFilename: "other.jpg",
        visibility: "PRIVATE",
        category: "CUSTOMER_PHOTO",
        status: "READY",
        publicPath: null,
      },
    },
    {
      id: "p-other-request",
      businessId: "biz-a",
      serviceRequestId: "req-other",
      url: "/api/storage/private/asset-c",
      storedAssetId: "asset-c",
      storedAsset: {
        mimeType: "image/jpeg",
        originalFilename: "other-req.jpg",
        visibility: "PRIVATE",
        category: "CUSTOMER_PHOTO",
        status: "READY",
        publicPath: null,
      },
    },
    {
      id: "p-heic",
      businessId: "biz-a",
      serviceRequestId: "req-a",
      url: "/api/storage/private/asset-heic",
      storedAssetId: "asset-heic",
      storedAsset: {
        mimeType: "image/heic",
        originalFilename: "IMG_9.HEIC",
        visibility: "PRIVATE",
        category: "CUSTOMER_PHOTO",
        status: "READY",
        publicPath: null,
      },
    },
  ],
});
check("Linked request photos appear for the matching estimate/request", photos.some((photo) => photo.id === "p1"));
check("Unrelated-business request photos cannot appear", photos.every((photo) => photo.id !== "p-foreign"));
check("Photos from another request in the same business cannot appear", photos.every((photo) => photo.id !== "p-other-request"));
check(
  "HEIC owner display is download-only, not a fake preview",
  photos.find((photo) => photo.id === "p-heic")?.previewable === false &&
    photos.find((photo) => photo.id === "p1")?.previewable === true &&
    photos.find((photo) => photo.id === "p1")?.src === privateAssetPath("asset-a"),
);
check(
  "Manual estimate with no linked request shows no intake photos",
  ownerVisibleRequestPhotos({
    businessId: "biz-a",
    serviceRequestId: null,
    photos: photos.map((photo) => ({
      id: photo.id,
      businessId: "biz-a",
      serviceRequestId: "req-a",
      url: photo.src,
    })),
  }).length === 0,
);

const measurementViews = ownerVisibleRequestMeasurements({
  businessId: "biz-a",
  serviceRequestId: "req-a",
  measurements: [
    {
      businessId: "biz-a",
      serviceRequestId: "req-a",
      source: CUSTOMER_REPORTED_MEASUREMENT,
      width: 32,
      height: 48,
      length: null,
      quantity: 1,
      unit: "IN",
      serviceRequestItem: {
        serviceCatalogItem: { name: "Blind / Shade Installation" },
      },
    },
    {
      businessId: "biz-b",
      serviceRequestId: "req-a",
      source: CUSTOMER_REPORTED_MEASUREMENT,
      width: 99,
      height: 99,
      length: null,
      quantity: 1,
      unit: "IN",
      serviceRequestItem: { serviceCatalogItem: { name: "Foreign" } },
    },
  ],
});
check(
  "Customer-reported measurements appear with unit/source context",
  measurementViews.length === 1 &&
    measurementViews[0].label.includes("Width 32 in") &&
    measurementViews[0].label.includes("Height 48 in") &&
    measurementViews[0].sourceLabel === CUSTOMER_REPORTED_MEASUREMENT_LABEL,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = `tbbt_intake_quote_${randomUUID().slice(0, 8)}`;
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
  console.error("Failed to push schema for intake-quote-handoff test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const provider = new MemoryStorageProvider();
const storageDeps = {
  db: prisma,
  provider,
  bucketName: "tbbt-intake-quote",
};

try {
  console.log("\nDB — Linked estimate context, isolation, prefill, public leak");
  const business = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  const other = await prisma.business.create({
    data: { name: "Other Handyman", slug: "other-handyman", tradeCode: "HANDYMAN" },
  });
  const paneling = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: DECORATIVE_WALL_PANELING_TITLE,
      category: "Trim & Carpentry",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
      description: joinCatalogDescription("Install decorative wall paneling.", {
        calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
        intake: { workArea: true },
      }),
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });

  const ownedPhoto = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "wall.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const foreignPhoto = await putPublicRequestPhotoFromBytes(storageDeps, "other-handyman", {
    originalFilename: "other.png",
    mimeType: "image/png",
    body: pngBytes,
  });

  const created = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Quote Customer",
    email: "quote@example.com",
    phone: "555-2211",
    address: "",
    streetAddress: "90 Palm",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Feature wall.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
    photoAssetIds: [ownedPhoto.id, foreignPhoto.id],
    measurements: [{ catalogItemId: paneling.id, width: "96", height: "96", unit: "IN" }],
    workAreaAnswers: [
      {
        catalogItemId: paneling.id,
        contentsHandling: "light",
        contentsProtection: "none",
        belongingsCleanup: "none",
      },
    ],
  });
  check("Request with photos, measurements, and work-area succeeds", created.ok === true);

  const request = await prisma.serviceRequest.findUniqueOrThrow({
    where: { id: created.requestId },
    include: {
      items: { include: { serviceCatalogItem: true } },
      photos: { include: { storedAsset: true } },
      measurements: {
        include: {
          serviceRequestItem: { include: { serviceCatalogItem: true } },
        },
      },
    },
  });

  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      serviceRequestId: request.id,
      customerId: request.customerId,
      propertyId: request.propertyId,
      publicToken: randomUUID(),
      status: "DRAFT",
    },
  });

  const visiblePhotos = ownerVisibleRequestPhotos({
    businessId: estimate.businessId,
    serviceRequestId: estimate.serviceRequestId,
    photos: request.photos,
  });
  check("Linked request photos appear for the owner estimate", visiblePhotos.length === 1);
  check(
    "Foreign-business photo cannot appear on this estimate",
    visiblePhotos.every((photo) => photo.src === privateAssetPath(ownedPhoto.id)),
  );
  const otherEstimatePhotos = ownerVisibleRequestPhotos({
    businessId: other.id,
    serviceRequestId: estimate.serviceRequestId,
    photos: request.photos,
  });
  check("Another business cannot see these request photos on the estimate", otherEstimatePhotos.length === 0);

  const visibleMeasurements = ownerVisibleRequestMeasurements({
    businessId: estimate.businessId,
    serviceRequestId: estimate.serviceRequestId,
    measurements: request.measurements,
  });
  check(
    "Customer-reported measurements appear on the correct estimate",
    visibleMeasurements.length === 1 &&
      visibleMeasurements[0].label.includes("Width 96 in") &&
      visibleMeasurements[0].sourceLabel === CUSTOMER_REPORTED_MEASUREMENT_LABEL,
  );

  const stored = request.measurements.map((row) => toStoredIntakeMeasurement(row));
  check(
    "Prefill uses the customer-reported row for the catalog item",
    customerReportedMeasurementForCatalog(stored, paneling.id)?.width === 96,
  );

  const lines = buildEstimateLineCreatesFromRequestItems(
    business.id,
    request.items,
    { answers: [{ catalogItemId: paneling.id, contentsHandling: "light", contentsProtection: "none", belongingsCleanup: "none" }] },
    stored,
  );
  const snapshot = lineCalculatorSnapshot(lines[0]?.description);
  check(
    "Matching stored dimensions prefill existing calculator fields",
    snapshot?.inputs.wallWidthFt === 8 && snapshot?.inputs.wallHeightFt === 8,
  );
  check(
    "Existing work-area calculator prefills are preserved",
    snapshot?.inputs.contentsHandlingLevel === "light" &&
      snapshot?.inputs.contentsProtectionLevel === "none",
  );

  const publicLeak = await servePublicStoredAsset(prisma, ownedPhoto.id, { provider });
  check("Public storage route still cannot serve private request photos", publicLeak.ok === false);
  const ownerRead = await servePrivateStoredAsset(prisma, ownedPhoto.id, business.id, { provider });
  check(
    "Owner private serve still returns bytes and an inline JPEG disposition",
    ownerRead.ok === true &&
      ownerRead.contentDisposition.startsWith("inline;"),
  );
  const otherRead = await servePrivateStoredAsset(prisma, ownedPhoto.id, other.id, { provider });
  check("R2/private tenant isolation remains enforced", otherRead.ok === false);

  const sent = await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "SENT", total: new Prisma.Decimal(0) },
  });
  await prisma.estimateVersion.create({
    data: {
      businessId: business.id,
      estimateId: sent.id,
      versionNumber: 1,
      total: new Prisma.Decimal(0),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      customerName: "Quote Customer",
      customerEmail: "quote@example.com",
      lineItems: {
        create: {
          businessId: business.id,
          description: lines[0].description,
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
          type: "LABOR",
        },
      },
    },
  });
  const document = await loadEstimateDocumentByToken(sent.publicToken, prisma);
  const documentText = document ? estimateDocumentPlainText(document) : "";
  check(
    "Customer/public estimate output does not expose private intake photos",
    document != null &&
      !documentText.includes("/api/storage/private/") &&
      !JSON.stringify(document).includes(ownedPhoto.id) &&
      !JSON.stringify(document).includes("Customer-reported / unverified"),
  );
  check(
    "Customer estimate document does not include owner-only measurement labels",
    !documentText.includes("Width 96 in") &&
      !documentText.includes(CUSTOMER_REPORTED_MEASUREMENT_LABEL),
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
    ? `\nAll intake-quote-handoff checks passed (${passed}).`
    : `\n${failed} intake-quote-handoff check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
