/**
 * Structured public service-address + tenant service-area checks.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-service-address.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { resolveBusinessServiceArea } = await import("@/lib/business-service-area");
const { formatAddress } = await import("@/lib/format");
const {
  OUT_OF_AREA_WARNING,
  applyAddressSuggestion,
  cityIsInServiceArea,
  findReusableProperty,
  formatStructuredAddress,
  getAddressLookupProvider,
  isValidUsPostalCode,
  normalizeRegion,
  shouldWarnOutsideServiceArea,
  structuredAddressKey,
  validateStructuredAddress,
} = await import("@/lib/service-address");

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

console.log("\nSTATIC — Form and provider boundaries");
const fieldsSrc = readRepo("src/components/public/service-address-fields.tsx");
const flowSrc = readRepo("src/components/public/request-flow.tsx");
check("Structured fields live in Step 1 of the public request flow", flowSrc.includes("ServiceAddressFields"));
check("Shared address UI does not hardcode CollPro cities", !/Fort Myers|Cape Coral|North Fort Myers/.test(fieldsSrc));
check("Shared address UI does not assume Florida", !fieldsSrc.includes("Florida"));
check("No Maps/Places/Mapbox provider is wired yet", getAddressLookupProvider() === null);
check("Address lookup hook exists for a future provider", readRepo("src/lib/service-address.ts").includes("getAddressLookupProvider"));

console.log("\nPURE — Formatting, ZIP, and tenant service area");
const formatted = formatStructuredAddress({
  streetAddress: "412 Pine St",
  unit: "Apt 3",
  city: "Fort Myers",
  region: "FL",
  postalCode: "33901",
});
check(
  "Formatted address uses street, unit, city, state, ZIP",
  formatted === "412 Pine St, Apt 3, Fort Myers, FL, 33901",
);
check(
  "formatAddress still renders a legacy one-line Property",
  formatAddress({ addressLine1: "10 Main St" }) === "10 Main St",
);
check(
  "formatAddress still renders a structured Property",
  formatAddress({
    addressLine1: "10 Main St",
    addressLine2: null,
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
  }) === "10 Main St, Cape Coral, FL, 33904",
);

check("5-digit ZIP is accepted", isValidUsPostalCode("33901"));
check("ZIP+4 is accepted", isValidUsPostalCode("33901-1234"));
check("Invented or short ZIP is rejected", !isValidUsPostalCode("3390") && !isValidUsPostalCode("ABCDE"));

const collproArea = resolveBusinessServiceArea({ slug: "collpro-reno" });
const otherArea = resolveBusinessServiceArea({ slug: "other-handyman" });
check(
  "CollPro service-area cities are tenant-scoped",
  collproArea.cities.includes("Fort Myers") &&
    collproArea.cities.includes("Cape Coral") &&
    collproArea.cities.includes("North Fort Myers"),
);
check("CollPro default state is FL from tenant config, not global code", collproArea.region === "FL" && collproArea.country === "US");
check("Another business does not inherit CollPro cities or Florida", otherArea.cities.length === 0 && otherArea.region === null);
check("Fort Myers is in CollPro's approved area", cityIsInServiceArea("fort myers", collproArea.cities));
check("Naples is outside CollPro's approved area", !cityIsInServiceArea("Naples", collproArea.cities));
check("Out-of-area warning text is the approved customer copy", OUT_OF_AREA_WARNING.includes("outside our standard service area"));
check(
  "Out-of-area warning fires for a city not on the tenant list",
  shouldWarnOutsideServiceArea("Naples", collproArea.cities) === true,
);
check(
  "Approved city does not warn",
  shouldWarnOutsideServiceArea("Cape Coral", collproArea.cities) === false,
);
check(
  "Business with no configured cities never warns",
  shouldWarnOutsideServiceArea("Anywhere", otherArea.cities) === false,
);

const missingStreet = validateStructuredAddress(
  { streetAddress: "", city: "Fort Myers", region: "FL", postalCode: "33901" },
  { country: "US" },
);
const missingZip = validateStructuredAddress(
  { streetAddress: "1 Main", city: "Fort Myers", region: "FL", postalCode: "" },
  { country: "US" },
);
const nonUsOk = validateStructuredAddress(
  { streetAddress: "1 Main", city: "Toronto", region: "ON", postalCode: "" },
  { country: "CA" },
);
check("Street is required", missingStreet.ok === false);
check("ZIP is required for US businesses", missingZip.ok === false);
check("ZIP is not required for a non-US business", nonUsOk.ok === true);
check("Florida is normalized to FL only when the business is US", normalizeRegion("Florida", "US") === "FL");
check("Non-US region is not forced to a US state", normalizeRegion("Ontario", "CA") === "Ontario");

const filled = applyAddressSuggestion(
  { streetAddress: "", unit: "B", city: "", region: "", postalCode: "" },
  { streetAddress: "88 Harbor", city: "Cape Coral", region: "FL", postalCode: "33904" },
);
check(
  "A future provider suggestion fills street, city, state, and ZIP",
  filled.streetAddress === "88 Harbor" &&
    filled.city === "Cape Coral" &&
    filled.region === "FL" &&
    filled.postalCode === "33904" &&
    filled.unit === "B",
);

const legacyMatch = findReusableProperty(
  [{ id: "legacy", addressLine1: "412 Pine St, Apt 3, Fort Myers, FL, 33901" }],
  {
    streetAddress: "412 Pine St",
    unit: "Apt 3",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
  },
  "US",
);
check("Structured submit can reuse a legacy one-line Property", legacyMatch?.id === "legacy");
check(
  "Structured keys ignore ZIP punctuation",
  structuredAddressKey(
    { streetAddress: "1 A", unit: "", city: "X", region: "FL", postalCode: "33901-1234" },
    "US",
  ) ===
    structuredAddressKey(
      { streetAddress: "1 A", unit: "", city: "X", region: "FL", postalCode: "339011234" },
      "US",
    ),
);

const testDbName = `tbbt_service_address_${randomUUID().slice(0, 8)}`;
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
  console.error("Failed to push schema for service-address test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Structured intake, reuse, and backward compatibility");
  const collpro = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  const other = await prisma.business.create({
    data: { name: "Other Handyman", slug: "other-handyman", tradeCode: "HANDYMAN" },
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: collpro.id,
      name: "Door Adjustment",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(75),
      active: true,
    },
  });
  const otherCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: other.id,
      name: "Shelf Install",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(90),
      active: true,
    },
  });

  const created = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Ada Homeowner",
    email: "ada-address@example.com",
    phone: "555-0200",
    address: "",
    streetAddress: "412 Pine St",
    unit: "Apt 3",
    city: "Fort Myers",
    region: "Florida",
    postalCode: "33901",
    notes: "Door sticks.",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Structured address submission succeeds", created.ok === true);

  const request = created.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: created.requestId },
        include: { property: true, customer: true },
      })
    : null;
  check(
    "Property stores structured street, unit, city, state, ZIP",
    request?.property?.addressLine1 === "412 Pine St" &&
      request?.property?.addressLine2 === "Apt 3" &&
      request?.property?.city === "Fort Myers" &&
      request?.property?.region === "FL" &&
      request?.property?.postalCode === "33901",
  );
  check(
    "Formatted display address is built from structured fields",
    request?.property
      ? formatAddress(request.property) === "412 Pine St, Apt 3, Fort Myers, FL, 33901"
      : false,
  );

  const retry = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Ada Homeowner",
    email: "ada-address@example.com",
    phone: "555-0200",
    address: "",
    streetAddress: "412 Pine St",
    unit: "Apt 3",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Same house again.",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
  });
  const retryRequest = retry.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: retry.requestId } })
    : null;
  const propertyCount = await prisma.property.count({
    where: { businessId: collpro.id, customerId: request?.customerId ?? "missing" },
  });
  check("Retry reuses the same Property", retryRequest?.propertyId === request?.propertyId);
  check("Retry does not create a duplicate Property", propertyCount === 1);

  const outside = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Bea Visitor",
    email: "bea-address@example.com",
    phone: "555-0201",
    address: "",
    streetAddress: "9 Gulf Dr",
    unit: "",
    city: "Naples",
    region: "FL",
    postalCode: "34102",
    notes: "Outside the usual area.",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Out-of-area city is not hard-blocked", outside.ok === true);
  const outsideProperty = outside.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: outside.requestId },
        include: { property: true },
      })
    : null;
  check("Out-of-area city is still stored on the Property", outsideProperty?.property?.city === "Naples");

  const missing = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Cara Incomplete",
    email: "cara-address@example.com",
    phone: "555-0202",
    address: "",
    streetAddress: "1 Oak",
    unit: "",
    city: "Fort Myers",
    region: "FL",
    postalCode: "",
    notes: "",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
  });
  check("US ZIP is required on structured CollPro intake", missing.ok === false);

  const customer = await prisma.customer.create({
    data: {
      businessId: collpro.id,
      name: "Legacy Owner",
      email: "legacy-address@example.com",
      phone: "555-0299",
    },
  });
  const legacyProperty = await prisma.property.create({
    data: {
      businessId: collpro.id,
      customerId: customer.id,
      addressLine1: "77 Harbor Ave",
    },
  });
  check(
    "Existing one-line Property still renders",
    formatAddress(legacyProperty) === "77 Harbor Ave",
  );
  const legacyReuse = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Legacy Owner",
    email: "legacy-address@example.com",
    phone: "555-0299",
    address: "",
    streetAddress: "77 Harbor Ave",
    unit: "",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    notes: "",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
  });
  const legacyReuseRequest = legacyReuse.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: legacyReuse.requestId } })
    : null;
  check(
    "Structured submit matching a legacy street reuses that Property",
    legacyReuseRequest?.propertyId === legacyProperty.id,
  );

  const oneLine = await createPublicServiceRequest(prisma, {
    slug: "other-handyman",
    name: "Dana Other",
    email: "dana-address@example.com",
    phone: "555-0300",
    address: "10 Main St",
    notes: "Legacy one-line still works.",
    catalogItemIds: [otherCatalog.id],
    includeOther: false,
    otherDescription: "",
  });
  const oneLineRequest = oneLine.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: oneLine.requestId },
        include: { property: true },
      })
    : null;
  check("Legacy one-line address submission still succeeds", oneLine.ok === true);
  check(
    "Legacy one-line still stores addressLine1 only",
    oneLineRequest?.property?.addressLine1 === "10 Main St" &&
      oneLineRequest?.property?.city == null,
  );
  check(
    "Other tenant did not receive CollPro service-area defaults",
    resolveBusinessServiceArea({ slug: "other-handyman" }).cities.length === 0,
  );

  const oneLineRetry = await createPublicServiceRequest(prisma, {
    slug: "other-handyman",
    name: "Dana Other",
    email: "dana-address@example.com",
    phone: "555-0300",
    address: "10 Main St",
    notes: "Same street again.",
    catalogItemIds: [otherCatalog.id],
    includeOther: false,
    otherDescription: "",
  });
  const oneLineRetryRequest = oneLineRetry.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: oneLineRetry.requestId } })
    : null;
  check(
    "Legacy one-line retry does not duplicate the Property",
    oneLineRetryRequest?.propertyId === oneLineRequest?.property?.id,
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
    ? `\nAll service-address checks passed (${passed}).`
    : `\n${failed} service-address check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
