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
const {
  createOwnerLoggedLead,
  recordedLeadSourceForChannel,
} = await import("@/lib/owner-log-lead");
const { loadPipelineSource } = await import("@/lib/pipeline-data");
const { decideCustomerMatch } = await import("@/lib/customer-identity");
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
const { firstHeaderHostWithPort } = await import("@/lib/vercel-app-host");
const { submitPublicIntakeForm, PUBLIC_INTAKE_SUBMIT_ERROR } = await import(
  "@/lib/public-request-submit"
);

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
check(
  "Public request photos now accept HEIC/HEIF in addition to JPEG/PNG/WebP",
  readRepo("src/lib/business-storage/request-photo-rules.ts").includes("image/heic") &&
    readRepo("src/lib/business-storage/request-photo-rules.ts").includes("image/heif"),
);
const jobPhotoSrc = readRepo("src/app/actions/job-photo.ts");
const expenseSrc = readRepo("src/app/actions/expenses.ts");
const storageSrc = readRepo("src/lib/storage.ts");
check(
  "OWNER/ADMIN job photos use private R2 / StoredAsset, not the 4MB Blob server-action path",
  jobPhotoSrc.includes("authorizeManagementJobPhoto") &&
    jobPhotoSrc.includes("finalizeManagementJobPhoto") &&
    jobPhotoSrc.includes("The image body never enters this") &&
    !jobPhotoSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    !jobPhotoSrc.includes("uploadJobPhoto") &&
    !jobPhotoSrc.includes("BLOB_READ_WRITE_TOKEN"),
);
check(
  "Expense receipt uploads still use the current storage helper and 4MB size cap",
  storageSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES = 4 * 1024 * 1024") &&
    expenseSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES"),
);

const nextConfigSrc = readRepo("next.config.ts");
const proxySrc = readRepo("src/proxy.ts");
check(
  "Server Actions allow www.tbbtool.com origin used by public hire submit",
  nextConfigSrc.includes('"www.tbbtool.com"') &&
    nextConfigSrc.includes('"tbbtool.com"') &&
    nextConfigSrc.includes("allowedOrigins"),
);
check(
  "Public website proxy copies Host onto x-forwarded-host before Server Actions",
  proxySrc.includes("firstHeaderHostWithPort") &&
    proxySrc.includes('requestHeaders.set("x-forwarded-host", csrfHost)') &&
    proxySrc.includes("isPublicWebsitePath"),
);
check(
  "Host-with-port helper keeps local ports and takes the first forwarded host",
  firstHeaderHostWithPort("www.tbbtool.com") === "www.tbbtool.com" &&
    firstHeaderHostWithPort("www.tbbtool.com, www.collproreno.com") ===
      "www.tbbtool.com" &&
    firstHeaderHostWithPort("localhost:43217") === "localhost:43217",
);

const csrfThrownSubmit = await submitPublicIntakeForm(
  async () => {
    throw new Error("Invalid Server Actions request.");
  },
  "handy-handyman-services",
  new FormData(),
);
check(
  "Thrown Server Action CSRF abort maps to the public submit retry error",
  csrfThrownSubmit.ok === false &&
    csrfThrownSubmit.error === PUBLIC_INTAKE_SUBMIT_ERROR &&
    PUBLIC_INTAKE_SUBMIT_ERROR ===
      "This request could not be submitted. Please try again.",
);

const r2CorsSrc = readRepo("src/lib/business-storage/r2-cors.ts");
const r2CorsJson = readRepo("src/lib/business-storage/r2-browser-upload-cors.json");
const requestFlowSrc = readRepo("src/components/public/request-flow.tsx");
const intakeActionSrc = readRepo("src/app/actions/intake.ts");
const applyCorsSrc = readRepo("scripts/apply-r2-browser-upload-cors.mjs");
check(
  "R2 browser-upload CORS allowlist includes https://www.tbbtool.com",
  r2CorsSrc.includes('"https://www.tbbtool.com"') &&
    r2CorsSrc.includes('"https://tbbtool.com"') &&
    r2CorsJson.includes("https://www.tbbtool.com") &&
    r2CorsJson.includes("https://tbbtool.com") &&
    applyCorsSrc.includes('"https://www.tbbtool.com"'),
);
check(
  "Public hire photo PUT CORS failure falls back to server-side photos FormData",
  requestFlowSrc.includes("authorized.uploadUrl") &&
    requestFlowSrc.includes('formData.append("photos", photo.file)') &&
    requestFlowSrc.includes("abortPublicRequestPhotoUpload") &&
    intakeActionSrc.includes('.getAll("photos")') &&
    intakeActionSrc.includes("putPublicRequestPhotoFromBytes"),
);
check(
  "Public submit notifies the tenant company email after the request persists",
  intakeActionSrc.indexOf("createPublicServiceRequest(prisma") <
    intakeActionSrc.indexOf("notifyBusinessNewPublicRequest(prisma") &&
    intakeActionSrc.includes("notifyBusinessNewPublicRequest(prisma, {") &&
    intakeActionSrc.includes("businessId: notifyBusiness.id") &&
    intakeActionSrc.includes("requestId: created.requestId") &&
    !/customer\.email/.test(intakeActionSrc),
);

const requestActionSrc = readRepo("src/app/actions/request.ts");
const ownerLogLeadSrc = readRepo("src/lib/owner-log-lead.ts");
const logLeadFormSrc = readRepo("src/components/requests/log-lead-form.tsx");
const logLeadPageSrc = readRepo("src/app/(app)/requests/log-lead/page.tsx");
check(
  "Owner Log lead is a real ServiceRequest action, not a second Lead table",
  requestActionSrc.includes("export async function logLead") &&
    requestActionSrc.includes("createOwnerLoggedLead") &&
    requestActionSrc.includes("CAPABILITIES.MANAGE_ESTIMATES") &&
    ownerLogLeadSrc.includes("serviceRequest.create") &&
    !ownerLogLeadSrc.includes("prisma.lead") &&
    !requestActionSrc.includes("model Lead"),
);
check(
  "Log lead never authorizes from client businessId",
  !requestActionSrc.includes('readString(formData, "businessId")') &&
    ownerLogLeadSrc.includes("Browser-supplied businessId is never authorization") &&
    ownerLogLeadSrc.includes("void input.businessId"),
);
check(
  "Log lead reuses normalized customer matching and structured addresses",
  ownerLogLeadSrc.includes("decideCustomerMatch") &&
    ownerLogLeadSrc.includes("validateStructuredAddress") &&
    logLeadFormSrc.includes('name="streetAddress"') &&
    logLeadFormSrc.includes('name="postalCode"'),
);
check(
  "Log lead form stays a one-minute capture (no price, schedule, or payment)",
  !logLeadFormSrc.includes("unitPrice") &&
    !logLeadFormSrc.includes("scheduledAt") &&
    !logLeadFormSrc.includes("payment") &&
    logLeadPageSrc.includes("creates a ServiceRequest"),
);
check(
  "Logged leads hand off through the existing createEstimate path",
  readRepo("src/app/(app)/requests/page.tsx").includes('href="/requests/log-lead"') &&
    readRepo("src/components/requests/requests-workspace.tsx").includes("CreateEstimateButton") &&
    readRepo("src/app/actions/estimate.ts").includes("serviceRequestId: request.id") &&
    readRepo("src/app/actions/estimate.ts").includes("customerId: request.customerId") &&
    readRepo("src/app/actions/estimate.ts").includes("propertyId: request.propertyId"),
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

  console.log("\nDB — Owner Log lead creates a real ServiceRequest");
  function makeAccess(businessId) {
    return {
      businessId,
      scope: { businessId },
      assertOwned(record) {
        if (!record || record.businessId !== businessId) {
          throw new Error("Record is not in the authorized business workspace.");
        }
        return record;
      },
    };
  }
  const ownerAccess = makeAccess(business.id);
  const otherAccess = makeAccess(other.id);

  const phoneLead = await createOwnerLoggedLead(prisma, ownerAccess, {
    businessId: other.id,
    mode: "new",
    name: "Phone Lead",
    email: "phone.lead@example.com",
    phone: "(239) 555-0110",
    summary: "Kitchen faucet leak",
    notes: "Called during lunch",
    channel: "PHONE",
    submissionId: "phonelead01",
  });
  const phoneRequest = phoneLead.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: phoneLead.requestId },
        include: { customer: true, property: true, items: true },
      })
    : null;
  check("Owner can log a new phone lead", phoneLead.ok === true);
  check("Logged lead is an OPEN ServiceRequest in this tenant",
    phoneRequest?.status === "OPEN" && phoneRequest.businessId === business.id);
  check("Phone/walk-in stores MANUAL, not a new schema value",
    phoneRequest?.leadSource === "MANUAL" &&
      recordedLeadSourceForChannel("PHONE") === "MANUAL" &&
      recordedLeadSourceForChannel("WALK_IN") === "MANUAL" &&
      recordedLeadSourceForChannel("REFERRAL") === "REFERRAL");
  check("Phone origin is preserved in request notes",
    (phoneRequest?.description ?? "").includes("Logged lead origin: Phone"));
  check("Client businessId was ignored; request stayed on the access tenant",
    phoneRequest?.businessId === business.id && phoneRequest?.businessId !== other.id);

  const pipeline = await loadPipelineSource(prisma, business.id);
  check("Logged lead appears on the Pipeline New Lead path",
    pipeline.opportunities.some(
      (row) => row.serviceRequestId === phoneRequest?.id && row.stage === "NEW_LEAD",
    ));
  const listed = await prisma.serviceRequest.findMany({
    where: { businessId: business.id, status: "OPEN" },
    select: { id: true },
  });
  check("Logged lead appears on the Requests OPEN path",
    listed.some((row) => row.id === phoneRequest?.id));

  const customersBeforeMatch = await prisma.customer.count({ where: { businessId: business.id } });
  const emailMatch = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Different Name",
    email: "PHONE.LEAD@example.com",
    phone: "",
    summary: "Repeat caller",
    channel: "PHONE",
    submissionId: "emailmatch1",
  });
  const emailMatchRequest = emailMatch.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: emailMatch.requestId },
        include: { customer: true },
      })
    : null;
  const customersAfterEmail = await prisma.customer.count({ where: { businessId: business.id } });
  check("Normalized email reuses the existing customer",
    emailMatch.ok === true &&
      emailMatchRequest?.customerId === phoneRequest?.customerId &&
      customersAfterEmail === customersBeforeMatch);
  check("Clear email match does not create a duplicate customer",
    customersAfterEmail === customersBeforeMatch);

  const phoneMatch = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Still Different",
    email: "",
    phone: "+1 239-555-0110",
    summary: "Follow-up text",
    channel: "TEXT",
    submissionId: "phonematch1",
  });
  const phoneMatchRequest = phoneMatch.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: phoneMatch.requestId },
      })
    : null;
  const customersAfterPhone = await prisma.customer.count({ where: { businessId: business.id } });
  check("Normalized phone reuses the existing customer",
    phoneMatch.ok === true &&
      phoneMatchRequest?.customerId === phoneRequest?.customerId &&
      customersAfterPhone === customersBeforeMatch);

  const existingProperty = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: phoneRequest.customerId,
      addressLine1: "12 Oak St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
    },
  });
  const existingPropertyLead = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "existing",
    customerId: phoneRequest.customerId,
    propertyChoice: existingProperty.id,
    summary: "Back to the same house",
    channel: "WALK_IN",
    serviceCatalogItemId: fan.id,
    submissionId: "existprop1",
  });
  const existingPropertyRequest = existingPropertyLead.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: existingPropertyLead.requestId },
        include: { items: true },
      })
    : null;
  check("Existing property can be selected on a logged lead",
    existingPropertyLead.ok === true &&
      existingPropertyRequest?.propertyId === existingProperty.id &&
      existingPropertyRequest.customerId === phoneRequest.customerId);
  check("Optional catalog service attaches to the logged request",
    existingPropertyRequest?.serviceCatalogItemId === fan.id &&
      existingPropertyRequest.items.some((item) => item.serviceCatalogItemId === fan.id));

  const newPropertyLead = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "existing",
    customerId: phoneRequest.customerId,
    propertyChoice: "new",
    streetAddress: "88 Harbor Ave",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    summary: "Second property",
    channel: "MANUAL",
    submissionId: "newprop001",
  });
  const newPropertyRequest = newPropertyLead.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: newPropertyLead.requestId },
        include: { property: true },
      })
    : null;
  check("New structured property can be created on a logged lead",
    newPropertyLead.ok === true &&
      newPropertyRequest?.property?.addressLine1 === "88 Harbor Ave" &&
      newPropertyRequest.property?.city === "Cape Coral" &&
      newPropertyRequest.property?.region === "FL" &&
      newPropertyRequest.property?.postalCode === "33904" &&
      newPropertyRequest.property?.businessId === business.id &&
      newPropertyRequest.customerId === phoneRequest.customerId);

  const otherCustomerCount = await prisma.customer.count({ where: { businessId: other.id } });
  const otherRequestCount = await prisma.serviceRequest.count({ where: { businessId: other.id } });
  const otherPropertyCount = await prisma.property.count({ where: { businessId: other.id } });
  const foreignCustomer = await createOwnerLoggedLead(prisma, otherAccess, {
    mode: "existing",
    customerId: phoneRequest.customerId,
    summary: "Hijack customer",
    channel: "PHONE",
    submissionId: "foreigncus",
  });
  const otherExistingCustomer = await prisma.customer.findFirst({
    where: { businessId: other.id },
    select: { id: true },
  });
  const foreignProperty = otherExistingCustomer
    ? await createOwnerLoggedLead(prisma, otherAccess, {
        mode: "existing",
        customerId: otherExistingCustomer.id,
        propertyChoice: existingProperty.id,
        summary: "Hijack property",
        channel: "PHONE",
        submissionId: "foreignprp",
      })
    : { ok: true };
  check("Tenant B cannot attach tenant A customer",
    foreignCustomer.ok === false);
  check("Tenant B cannot attach tenant A property",
    foreignProperty.ok === false);
  check("Rejected foreign IDs create no partial customer/request/property rows",
    (await prisma.customer.count({ where: { businessId: other.id } })) === otherCustomerCount &&
      (await prisma.serviceRequest.count({ where: { businessId: other.id } })) === otherRequestCount &&
      (await prisma.property.count({ where: { businessId: other.id } })) === otherPropertyCount);

  const retry = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Phone Lead",
    email: "phone.lead@example.com",
    summary: "Kitchen faucet leak",
    channel: "PHONE",
    submissionId: "phonelead01",
  });
  check("Resubmit with the same submissionId reuses the request",
    retry.ok === true && retry.requestId === phoneLead.requestId && retry.reused === true);

  const customersBeforeHandoff = await prisma.customer.count({ where: { businessId: business.id } });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      serviceRequestId: phoneRequest.id,
      customerId: phoneRequest.customerId,
      propertyId: phoneRequest.propertyId,
      leadSource: phoneRequest.leadSource,
      campaignId: phoneRequest.campaignId,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.serviceRequest.update({
    where: { id: phoneRequest.id },
    data: { status: "CONVERTED" },
  });
  const converted = await prisma.serviceRequest.findUnique({
    where: { id: phoneRequest.id },
  });
  const customersAfterHandoff = await prisma.customer.count({ where: { businessId: business.id } });
  check("Request→estimate handoff keeps the same customer and property",
    estimate.serviceRequestId === phoneRequest.id &&
      estimate.customerId === phoneRequest.customerId &&
      estimate.propertyId === phoneRequest.propertyId &&
      estimate.leadSource === phoneRequest.leadSource &&
      converted.status === "CONVERTED");
  check("Handoff does not create a second customer",
    customersAfterHandoff === customersBeforeHandoff);

  const conflictA = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Email Owner",
      email: "conflict@example.com",
    },
  });
  const conflictB = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Phone Owner",
      phone: "2395550199",
    },
  });
  const ambiguous = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Ambiguous Person",
    email: "conflict@example.com",
    phone: "239-555-0199",
    summary: "Conflicting identifiers",
    channel: "PHONE",
    submissionId: "ambiguous1",
  });
  const ambiguousRequest = ambiguous.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: ambiguous.requestId },
      })
    : null;
  check("Ambiguous email/phone does not silently merge existing customers",
    ambiguous.ok === true &&
      ambiguousRequest?.customerId !== conflictA.id &&
      ambiguousRequest?.customerId !== conflictB.id &&
      (ambiguousRequest?.description ?? "").includes("TBBT Identity Review"));
  check("decideCustomerMatch still classifies that pair as ambiguous",
    decideCustomerMatch(
      [
        { id: conflictA.id, name: "Email Owner", email: "conflict@example.com", phone: null },
        { id: conflictB.id, name: "Phone Owner", email: null, phone: "2395550199" },
      ],
      { email: "conflict@example.com", phone: "239-555-0199" },
    ).kind === "ambiguous");
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
