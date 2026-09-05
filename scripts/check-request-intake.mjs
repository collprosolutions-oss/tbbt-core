/**
 * Public request photos (private R2) + catalog-driven measurements.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-request-intake.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { MemoryStorageProvider, servePublicStoredAsset } = await import(
  "@/lib/business-storage/index"
);
const { putPublicRequestPhotoFromBytes } = await import(
  "@/lib/business-storage/request-photos"
);
const { servePrivateStoredAsset } = await import(
  "@/lib/business-storage/private-serve"
);
const {
  CONTRACTOR_VERIFIED_MEASUREMENT,
  CUSTOMER_REPORTED_MEASUREMENT,
  catalogAsksMeasurements,
  resolveCatalogIntakeConfig,
  validateCustomerMeasurementInput,
} = await import("@/lib/catalog-intake");

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

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

console.log("\nSTATIC — Private photos and reusable measurement config");
check(
  "Request photos use CUSTOMER_PHOTO + PRIVATE visibility",
  readRepo("src/lib/business-storage/request-photos.ts").includes("CUSTOMER_PHOTO") &&
    readRepo("src/lib/business-storage/request-photos.ts").includes('visibility: "PRIVATE"'),
);
check(
  "Public storage route is not used for request photos",
  !readRepo("src/lib/business-storage/request-photos.ts").includes("/api/storage/public/"),
);
check(
  "Shared measurement UI does not hardcode blinds or TV mounting",
  !/Blind|TV Mount|Drywall/.test(readRepo("src/components/public/request-measurement-fields.tsx")),
);
check(
  "Private request-photo route is not a public website path",
  !readRepo("src/lib/public-website-paths.ts").includes("/api/storage/private/"),
);
check(
  "Starter blinds template carries reusable measurement config",
  readRepo("src/lib/handyman-starter-catalog.ts").includes('templateKey: "blind-shade-installation"') &&
    readRepo("src/lib/handyman-starter-catalog.ts").includes('intakeMeasurementMode: "RECOMMENDED"'),
);
check(
  "Customer-reported and contractor-verified sources stay distinct",
  CUSTOMER_REPORTED_MEASUREMENT !== CONTRACTOR_VERIFIED_MEASUREMENT,
);

const noneConfig = resolveCatalogIntakeConfig({ intakeMeasurementMode: "NONE" });
const blindsConfig = resolveCatalogIntakeConfig({
  intakeMeasurementMode: "RECOMMENDED",
  intakeMeasurementAxes: "width,height",
  intakeMeasurementUnit: "IN",
});
check("Service without measurements enabled asks for none", !catalogAsksMeasurements(noneConfig));
check("Service with measurements enabled asks for configured axes", catalogAsksMeasurements(blindsConfig) && blindsConfig.axes.join(",") === "width,height");
check(
  "Optional measurements may be omitted",
  validateCustomerMeasurementInput(blindsConfig, { width: "", height: "" }).ok === true,
);
check(
  "Invalid optional measurement text is rejected",
  validateCustomerMeasurementInput(blindsConfig, { width: "abc", height: "" }).ok === false,
);
check(
  "Required measurements are rejected when empty",
  validateCustomerMeasurementInput(
    { ...blindsConfig, mode: "REQUIRED" },
    { width: "", height: "" },
  ).ok === false,
);

const testDbName = `tbbt_request_intake_${randomUUID().slice(0, 8)}`;
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
  console.error("Failed to push schema for request-intake test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const provider = new MemoryStorageProvider();
const storageDeps = {
  db: prisma,
  provider,
  bucketName: "tbbt-request-photos",
};

try {
  console.log("\nDB — Photos, measurements, and existing request compatibility");
  const business = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  const other = await prisma.business.create({
    data: { name: "Other Handyman", slug: "other-handyman", tradeCode: "HANDYMAN" },
  });
  const fan = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Ceiling Fan Replacement",
      category: "Fans & Fixtures",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(180),
      active: true,
    },
  });
  const blinds = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Blind / Shade Installation",
      category: "Mounting & Hanging",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(85),
      active: true,
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });
  const otherItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: other.id,
      name: "Shelf Install",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(90),
      active: true,
    },
  });

  const noPhotos = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "No Photo",
    email: "nophoto@example.com",
    phone: "555-0400",
    address: "",
    streetAddress: "12 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Fan only.",
    catalogItemIds: [fan.id],
    includeOther: false,
    otherDescription: "",
  });
  const noPhotoRequest = noPhotos.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: noPhotos.requestId },
        include: { photos: true, measurements: true, property: true },
      })
    : null;
  check("Public request with no photos still succeeds", noPhotos.ok === true);
  check("No-photo request stores no photo rows", noPhotoRequest?.photos.length === 0);
  check("Service without measurements stores none", noPhotoRequest?.measurements.length === 0);
  check("Structured address still stores on a no-photo request", noPhotoRequest?.property?.city === "Fort Myers");

  const first = await putPublicRequestPhotoFromBytes(
    storageDeps,
    "collpro-reno",
    { originalFilename: "window-1.png", mimeType: "image/png", body: pngBytes },
  );
  const second = await putPublicRequestPhotoFromBytes(
    storageDeps,
    "collpro-reno",
    { originalFilename: "window-2.png", mimeType: "image/png", body: pngBytes },
  );
  const foreign = await putPublicRequestPhotoFromBytes(
    storageDeps,
    "other-handyman",
    { originalFilename: "other.png", mimeType: "image/png", body: pngBytes },
  );

  const withPhotos = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Photo Owner",
    email: "photos@example.com",
    phone: "555-0401",
    address: "",
    streetAddress: "88 Harbor",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    notes: "Two windows.",
    catalogItemIds: [blinds.id],
    includeOther: false,
    otherDescription: "",
    photoAssetIds: [first.id, second.id, foreign.id],
    measurements: [{ catalogItemId: blinds.id, width: "32", height: "48", unit: "IN" }],
  });
  const photoRequest = withPhotos.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: withPhotos.requestId },
        include: { photos: true, measurements: true, items: true },
      })
    : null;
  check("Public request with multiple private photos succeeds", withPhotos.ok === true);
  check("Exactly two owned photos were attached", photoRequest?.photos.length === 2);
  check(
    "Photos belong to the correct business and request",
    photoRequest?.photos.every(
      (photo) =>
        photo.businessId === business.id &&
        photo.serviceRequestId === photoRequest.id &&
        Boolean(photo.storedAssetId),
    ) === true,
  );
  check(
    "Foreign-business photo was not attached",
    photoRequest?.photos.every((photo) => photo.storedAssetId !== foreign.id) === true,
  );

  const publicLeak = await servePublicStoredAsset(prisma, first.id, { provider });
  check("Public access cannot expose private request photos", publicLeak.ok === false);
  check("Private request photos have no publicPath", first.publicPath == null && first.visibility === "PRIVATE");
  const ownerRead = await servePrivateStoredAsset(prisma, first.id, business.id, { provider });
  check("Owner workspace can read the private request photo", ownerRead.ok === true);
  const otherOwnerRead = await servePrivateStoredAsset(prisma, first.id, other.id, { provider });
  check("Another business cannot read those private photos", otherOwnerRead.ok === false);

  check("Customer-reported measurements survive request creation", photoRequest?.measurements.length === 1);
  const reported = photoRequest?.measurements[0];
  check(
    "Stored measurement is customer-reported, not contractor-verified",
    reported?.source === CUSTOMER_REPORTED_MEASUREMENT &&
      reported?.verifiedAt == null &&
      reported?.verifiedByMembershipId == null,
  );
  check(
    "Width/height/quantity were stored for the blinds item",
    reported?.width?.toString() === "32" &&
      reported?.height?.toString() === "48" &&
      reported?.quantity === 1 &&
      reported?.unit === "IN",
  );

  const verified = await prisma.serviceRequestMeasurement.create({
    data: {
      businessId: business.id,
      serviceRequestId: photoRequest.id,
      serviceRequestItemId: reported.serviceRequestItemId,
      source: CONTRACTOR_VERIFIED_MEASUREMENT,
      width: new Prisma.Decimal("33"),
      height: new Prisma.Decimal("48"),
      quantity: 1,
      unit: "IN",
      verifiedAt: new Date(),
    },
  });
  const afterVerify = await prisma.serviceRequestMeasurement.findMany({
    where: { serviceRequestId: photoRequest.id },
    orderBy: { createdAt: "asc" },
  });
  check("Contractor verification adds a second row", afterVerify.length === 2);
  check(
    "Original customer-reported values remain",
    afterVerify[0].id === reported.id &&
      afterVerify[0].source === CUSTOMER_REPORTED_MEASUREMENT &&
      afterVerify[0].width.toString() === "32" &&
      verified.source === CONTRACTOR_VERIFIED_MEASUREMENT,
  );

  const legacy = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      description: "Old request without photos or measurements",
      serviceCatalogItemId: fan.id,
    },
    include: { photos: true, measurements: true, items: true },
  });
  check(
    "Existing requests continue working without photos or measurements",
    legacy.photos.length === 0 && legacy.measurements.length === 0 && legacy.items.length === 0,
  );

  const otherRequest = await createPublicServiceRequest(prisma, {
    slug: "other-handyman",
    name: "Other Customer",
    email: "other@example.com",
    phone: "555-0499",
    address: "10 Main St",
    notes: "",
    catalogItemIds: [otherItem.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Another tenant can still submit without CollPro measurement config", otherRequest.ok === true);
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
    ? `\nAll request-intake checks passed (${passed}).`
    : `\n${failed} request-intake check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
