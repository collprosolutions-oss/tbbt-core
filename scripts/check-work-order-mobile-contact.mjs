/**
 * Focused verification for owner Work Order mobile contact + field handoff.
 *
 * Call / Text / Email / Directions come from recorded Job.customer and
 * Job.property fields on the existing tenant-scoped Job load. Open Field
 * View stays assignment-scoped. No second customer/property query, no
 * invented contact or address, no new email or maps subsystem.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-work-order-mobile-contact.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { directionsUrl, smsHref, telHref } = await import("@/lib/directions");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Same truthful trimmed mailto as the customer mobile contact view. */
function workOrderEmailHref(email) {
  const value = email?.trim();
  return value ? `mailto:${value}` : null;
}

function viewerIsAssignee(assignedMembershipId, viewerMembershipId) {
  return assignedMembershipId === viewerMembershipId;
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

const page = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const directionsLib = readRepo("src/lib/directions.ts");
const customerForm = readRepo("src/components/customers/edit-customer-form.tsx");

const headerStart = page.indexOf("<PageHeader");
const headerEnd = page.indexOf("</PageHeader>");
const header = page.slice(headerStart, headerEnd);
const actionRailStart = page.indexOf("</PageHeader>");
const summaryStart = page.indexOf("<CardTitle>Work Order Summary</CardTitle>");
const actionRail = page.slice(actionRailStart, summaryStart);

console.log("\nUNIT — Recorded phone / email / address helpers");
const recordedPhone = "(239) 357-8199";
const recordedEmail = "owner@example.com";
const recordedProperty = {
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "Fort Myers",
  region: "FL",
  postalCode: "33901",
};
const recordedMaps = directionsUrl(recordedProperty);

check(
  "recorded phone -> correct tel: action",
  telHref(recordedPhone) === `tel:${recordedPhone}`,
);
check(
  "recorded phone -> correct sms: action",
  smsHref(recordedPhone) === "sms:2393578199",
);
check(
  "blank/null phone -> no Call/Text",
  telHref(null) === null &&
    telHref("") === null &&
    telHref("   ") === null &&
    smsHref(null) === null &&
    smsHref("") === null &&
    smsHref("   ") === null &&
    smsHref("---") === null,
);
check(
  "recorded email -> mailto:",
  workOrderEmailHref(recordedEmail) === `mailto:${recordedEmail}` &&
    workOrderEmailHref("  pat@example.com  ") === "mailto:pat@example.com",
);
check(
  "blank/null email -> no Email",
  workOrderEmailHref(null) === null &&
    workOrderEmailHref("") === null &&
    workOrderEmailHref("   ") === null &&
    workOrderEmailHref(undefined) === null,
);
check(
  "recorded property -> canonical directionsUrl",
  recordedMaps ===
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("123 Main St, Fort Myers, FL, 33901")}` &&
    recordedMaps.includes("query=") &&
    !recordedMaps.includes("key="),
);
check(
  "missing address -> no Directions",
  directionsUrl(null) === null &&
    directionsUrl({ addressLine1: "", city: "", region: "", postalCode: "" }) === null,
);

console.log("\nSTATIC — Work Order uses existing helpers on the tenant-owned Job load");
check(
  "Work Order imports canonical telHref / smsHref / directionsUrl only",
  page.includes('import { directionsUrl, smsHref, telHref } from "@/lib/directions"') &&
    directionsLib.includes("export function telHref") &&
    directionsLib.includes("export function smsHref") &&
    directionsLib.includes("export function directionsUrl") &&
    !page.includes("function telHref") &&
    !page.includes("function smsHref") &&
    !page.includes("function directionsUrl"),
);
check(
  "Call uses telHref(job.customer?.phone)",
  page.includes("const callHref = telHref(job.customer?.phone)") &&
    actionRail.includes("{callHref ? (") &&
    actionRail.includes("<a href={callHref}>Call customer</a>"),
);
check(
  "Text uses smsHref(job.customer?.phone) and omits the action when null",
  page.includes("const textHref = smsHref(job.customer?.phone)") &&
    actionRail.includes("{textHref ? (") &&
    actionRail.includes("<a href={textHref}>Text customer</a>"),
);
check(
  "Email uses the same trimmed mailto as customer mobile UI",
  page.includes("function workOrderEmailHref(") &&
    page.includes("const value = email?.trim()") &&
    page.includes("`mailto:${value}`") &&
    page.includes("const mailHref = workOrderEmailHref(job.customer?.email)") &&
    actionRail.includes("{mailHref ? (") &&
    actionRail.includes("<a href={mailHref}>Email customer</a>") &&
    customerForm.includes("function emailHref(") &&
    customerForm.includes("`mailto:${value}`"),
);
check(
  "Directions uses directionsUrl(job.property) and recorded address fields only",
  page.includes("const mapsHref = directionsUrl(job.property)") &&
    actionRail.includes("{mapsHref ? (") &&
    actionRail.includes("Directions") &&
    page.includes("addressLine1: true") &&
    page.includes("addressLine2: true") &&
    page.includes("city: true") &&
    page.includes("region: true") &&
    page.includes("postalCode: true") &&
    !page.includes("geocod") &&
    !page.includes("latitude") &&
    !page.includes("longitude") &&
    !actionRail.includes("key="),
);
check(
  "Missing recorded contact/address renders no Call/Text/Email/Directions action",
  actionRail.includes("{callHref ? (") &&
    actionRail.includes("{textHref ? (") &&
    actionRail.includes("{mailHref ? (") &&
    actionRail.includes("{mapsHref ? (") &&
    !actionRail.includes("No phone on file") &&
    !actionRail.includes("No address on file") &&
    !actionRail.includes("disabled"),
);
check(
  "Contact actions sit above billing/scope cards and use phone tap targets",
  actionRailStart < summaryStart &&
    actionRail.includes('className="h-12 w-full text-base sm:h-9 sm:w-auto sm:text-sm"') &&
    !actionRail.includes("Payments & Deposit") &&
    !actionRail.includes("Original Approved Scope"),
);
check(
  "Today handoff uses the existing /today route",
  actionRail.includes('href="/today"') &&
    actionRail.includes("Back to Today") &&
    !actionRail.includes("#today") &&
    !page.includes('href="/today#'),
);

console.log("\nSTATIC — Existing header, assignment, and Field handoff stay intact");
check(
  "Open Field View visible when viewer membership === assignedMembershipId",
  page.includes("const viewerIsAssignee = job.assignedMembershipId === actorMembership.id") &&
    header.includes("{viewerIsAssignee ? (") &&
    header.includes("Open Field View") &&
    header.includes("href={`/field/jobs/${job.id}`}") &&
    viewerIsAssignee("mem-assigned", "mem-assigned") === true,
);
check(
  "Open Field View absent for non-assignee",
  header.includes("{viewerIsAssignee ? (") &&
    header.includes(") : null}") &&
    !header.includes("Open Field View") === false &&
    viewerIsAssignee("mem-assigned", "mem-other") === false &&
    viewerIsAssignee(null, "mem-owner") === false,
);
check(
  "existing Start / Complete / Invoice / RecordNav behavior still present",
  header.includes("<StartJobButton") &&
    header.includes("<MarkJobCompleteButton") &&
    header.includes("Open Invoice") &&
    header.includes("<RecordNav") &&
    header.includes('backHref="/jobs"') &&
    header.includes('backLabel="Back to Jobs"'),
);
check(
  "#144 self-assignment and assignment-candidate rules are unchanged",
  page.includes("const canSelfAssign =") &&
    page.includes('actorRole === "OWNER" || actorRole === "ADMIN"') &&
    page.includes("eligibleMemberRows") &&
    page.includes('role: "MEMBER", active: true'),
);

console.log("\nSTATIC — Tenant-owned Job load; no second customer/property query");
const jobFindCount = page.split("prisma.job.findFirst").length - 1;
const customerFindCount = (page.match(/prisma\.customer\./g) || []).length;
const propertyFindCount = (page.match(/prisma\.property\./g) || []).length;
check(
  "foreign job cannot be rendered through another tenant",
  page.includes("requireManagementPageAccess") &&
    page.includes("where: { id: jobId, ...access.scope }") &&
    page.includes("access.assertOwned(job)") &&
    page.includes("if (!job) {") &&
    page.includes("notFound()"),
);
check(
  "no new customer/property query outside the tenant-owned Job load",
  jobFindCount === 1 &&
    customerFindCount === 0 &&
    propertyFindCount === 0 &&
    page.includes("customer: { select: { name: true, phone: true, email: true } }") &&
    !page.includes("prisma.customer.find") &&
    !page.includes("prisma.property.find"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to prove tenant Job isolation.",
  );
  process.exit(1);
}

const testDbName = "tbbt_work_order_mobile_contact_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for work-order-mobile-contact test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const WORK_ORDER_JOB_INCLUDE = {
  customer: { select: { name: true, phone: true, email: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
};

try {
  console.log("\nPRISMA — Tenant-scoped Work Order Job load");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Work Order", slug: `alpha-wo-mobile-${randomUUID()}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Work Order", slug: `beta-wo-mobile-${randomUUID()}` },
  });
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Pat Alpha",
      phone: recordedPhone,
      email: recordedEmail,
    },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: recordedProperty.addressLine1,
      city: recordedProperty.city,
      region: recordedProperty.region,
      postalCode: recordedProperty.postalCode,
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });

  const owned = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: businessA.id },
    include: WORK_ORDER_JOB_INCLUDE,
  });
  const foreign = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: businessB.id },
    include: WORK_ORDER_JOB_INCLUDE,
  });

  check(
    "owned Work Order load returns recorded name / phone / email / address",
    owned?.customer?.name === "Pat Alpha" &&
      owned?.customer?.phone === recordedPhone &&
      owned?.customer?.email === recordedEmail &&
      owned?.property?.addressLine1 === recordedProperty.addressLine1 &&
      telHref(owned.customer.phone) === `tel:${recordedPhone}` &&
      smsHref(owned.customer.phone) === "sms:2393578199" &&
      workOrderEmailHref(owned.customer.email) === `mailto:${recordedEmail}` &&
      directionsUrl(owned.property) === recordedMaps,
  );
  check(
    "foreign job cannot be rendered through another tenant",
    foreign === null,
  );
  check(
    "contact fields arrive on the Job include, not a second Customer/Property query",
    Boolean(owned?.customer) && Boolean(owned?.property),
  );
} finally {
  await prisma.$disconnect();
}

if (failed > 0) {
  console.error(`\nwork-order-mobile-contact check failed: ${failed} failure(s)`);
  process.exit(1);
}

console.log(`\nwork-order-mobile-contact check passed (${passed} checks)`);
