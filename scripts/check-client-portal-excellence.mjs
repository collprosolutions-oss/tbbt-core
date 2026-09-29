/**
 * Client Portal Excellence — Project Home proofs.
 *
 * Static + pure + isolated-DB. HTTP isolation runs when `.next` exists.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-client-portal-excellence.mjs
 */
import { createRequire, register } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  customerFacingAdditionalWorkStatus,
  customerFacingInvoiceTruth,
  customerFacingPortalMessageStatus,
  isPortalCustomerVisibleMessageChannel,
  isPortalCustomerVisibleMessageStatus,
  loadPortalAdditionalWorkRequests,
  loadPortalCustomerCommunications,
  PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS,
  portalAppointmentConfirmationCopy,
  portalAppointmentWhenLabel,
  portalApprovedChangeOrderCount,
  portalPendingChangeOrderCount,
  portalRequestSummary,
  resolvePortalNextAction,
} = await import("@/lib/portal-project-home");
const { formatDateTime, formatTime } = await import("@/lib/format");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
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

const page = readRepo("src/app/p/[token]/page.tsx");
const homeHelper = readRepo("src/lib/portal-project-home.ts");
const homeSummary = readRepo("src/components/portal/project-home-summary.tsx");
const commsCard = readRepo("src/components/portal/portal-communications-card.tsx");
const workHistory = readRepo("src/components/portal/portal-additional-work-history.tsx");
const changeCard = readRepo("src/components/portal/change-orders-card.tsx");
const additionalForm = readRepo("src/components/portal/request-additional-work-form.tsx");
const publicAdditional = readRepo("src/app/actions/public-additional-work-request.ts");
const publicChange = readRepo("src/app/actions/public-change-order.ts");
const payRoute = readRepo("src/app/p/[token]/pay/route.ts");
const timeline = readRepo("src/lib/communications/timeline.ts");

console.log("\nSTATIC — Canonical portal only, no second portal or schema");
check(
  "Still the existing /p/[token] Project Portal",
  page.includes("Customer Project Portal") &&
    page.includes("where: { projectToken: token }") &&
    !existsSync(new URL("../src/app/portal/", import.meta.url).pathname),
);
check(
  "Portal never accepts a client-supplied businessId/customerId/jobId",
  page.includes("where: { projectToken: token }") &&
    !page.includes("formData.get(\"businessId\")") &&
    !page.includes("formData.get(\"jobId\")") &&
    !page.includes("formData.get(\"customerId\")"),
);
check(
  "Prisma schema is untouched by this helper (no schema writes)",
  !homeHelper.includes("prisma migrate") &&
    !homeHelper.includes("$executeRaw") &&
    !homeHelper.includes("prisma.schema"),
);
check(
  "Does not import the owner communications timeline loader",
  !page.includes("loadCustomerCommunicationHistory") &&
    !page.includes("loadCustomerCommunicationTimeline") &&
    !homeHelper.includes("loadCustomerCommunicationHistory") &&
    !homeHelper.includes("@/lib/communications/timeline"),
);
check(
  "Owner timeline loader source is unchanged by this check's scope",
  timeline.includes("export async function loadCustomerCommunicationHistory"),
);
check(
  "Project Home uses token-scoped loaders only",
  page.includes("loadPortalCustomerCommunications") &&
    page.includes("loadPortalAdditionalWorkRequests") &&
    page.includes("prisma,\n    token") &&
    homeHelper.includes("where: { projectToken: trimmed }") &&
    homeHelper.includes("businessId: job.businessId") &&
    homeHelper.includes("customerId: job.customerId"),
);
check(
  "Portal additional-work history is customer-source only",
  homeHelper.includes('source: "CUSTOMER"') &&
    homeHelper.includes("Employee-originated field requests stay on owner/internal views"),
);
check(
  "Internal cost/vault/notes stay off the portal page",
  !page.includes("laborCost") &&
    !page.includes("supplierCost") &&
    !page.includes("Business Vault") &&
    !page.includes("Chief-of-Staff") &&
    !page.includes("problemReports") &&
    !page.includes("JobPhoto") &&
    !page.includes("prisma.jobPhoto") &&
    page.includes("no internal notes"),
);
check(
  "Forbidden customer claims are not shown as live copy",
  !page.includes("Technician is on the way") &&
    !page.includes("Your message was read") &&
    !homeSummary.includes("Your message was read") &&
    !commsCard.includes("was read") &&
    homeHelper.includes("PORTAL_FORBIDDEN_CUSTOMER_CLAIMS"),
);
check(
  "SENT is never labeled Delivered",
  homeHelper.includes('if (status === "DELIVERED") return "Delivered"') &&
    homeHelper.includes('if (status === "SENT") return "Sent"') &&
    commsCard.includes("Sent is") &&
    commsCard.includes("not the same as delivered"),
);
check(
  "Portal messages are outbound EMAIL/SMS/PORTAL only",
  homeHelper.includes('direction: "OUTBOUND"') &&
    homeHelper.includes("PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS") &&
    homeHelper.includes('"EMAIL"') &&
    homeHelper.includes('"SMS"') &&
    homeHelper.includes('"PORTAL"') &&
    !homeHelper.includes('"MANUAL"') &&
    !homeHelper.includes('"SYSTEM"') &&
    !homeHelper.includes('"PHONE"') &&
    commsCard.includes("Messages we have sent") &&
    !commsCard.includes("sent or received") &&
    !commsCard.includes("From you"),
);
check(
  "Portal page contains no request-time DDL path",
  !page.includes("ensureBusinessPublicContactSchema") &&
    !page.includes("ALTER TABLE") &&
    !page.includes("$executeRawUnsafe") &&
    !page.includes("$executeRaw") &&
    page.includes("BUSINESS_PUBLIC_CONTACT_SELECT") &&
    page.includes("resolveBusinessPublicContact"),
);
check(
  "Appointment exact/window uses recorded arrivalWindowMinutes",
  page.includes("arrivalWindowMinutes: true") &&
    page.includes("portalAppointmentWhenLabel") &&
    homeHelper.includes("Arrival window:") &&
    homeHelper.includes("Appointment time:"),
);
check(
  "Unconfirmed appointments still use customerAppointmentStatusLabel",
  page.includes("customerAppointmentStatusLabel") &&
    page.includes("isCurrentAppointmentConfirmed") &&
    !page.includes("Technician is on the way"),
);
check(
  "Invoice/payment path is still canonical",
  page.includes("shouldShowPayInvoice") &&
    page.includes("PayInvoiceButton") &&
    page.includes('href={`/p/${token}/invoice`}') &&
    payRoute.includes("createCustomerInvoiceCheckout") &&
    !homeHelper.includes("createCustomerInvoiceCheckout") &&
    !homeHelper.includes("prisma.invoice.update"),
);
check(
  "Change Order customer approval stays on the existing action",
  changeCard.includes("ApproveDeclineChangeOrderButtons") &&
    publicChange.includes("export async function approveChangeOrder") &&
    !homeHelper.includes("approveChangeOrder") &&
    !homeHelper.includes("prisma.changeOrder.update"),
);
check(
  "Additional work still uses the existing public action",
  additionalForm.includes("requestAdditionalWork") &&
    publicAdditional.includes("createCustomerAdditionalWorkRequest") &&
    !homeHelper.includes("additionalWorkRequest.create") &&
    !homeHelper.includes("createCustomerAdditionalWorkRequest"),
);
check(
  "Project Home next step links existing anchors/routes",
  homeSummary.includes("href={nextAction.href}") &&
    homeHelper.includes("`/e/${input.estimatePublicToken}`") &&
    homeHelper.includes("`/p/${token}/invoice`") &&
    homeHelper.includes("`#appointment`") &&
    homeHelper.includes("`#change-orders`"),
);
check(
  "Mobile-first next-step buttons are full width on phones",
  homeSummary.includes("h-11 w-full sm:w-auto") &&
    homeSummary.includes("Your next step"),
);
check(
  "Existing layout contracts still appear on the portal page",
  page.includes("max-w-[1200px]") &&
    page.includes("md:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]") &&
    page.includes("md:grid-cols-2 xl:grid-cols-3") &&
    page.includes("formatMailingAddress") &&
    page.includes("formatDateTime(job.scheduledAt, timeZone)") &&
    page.includes("resolveBusinessTimeZone(job.business)"),
);
check(
  "History components stay customer-safe",
  workHistory.includes("Submitted") &&
    !workHistory.includes("margin") &&
    !commsCard.includes("failureReason") &&
    !commsCard.includes("consentContext"),
);

const ny = "America/New_York";
const la = "America/Los_Angeles";
const start = new Date("2026-09-26T16:00:00.000Z");

console.log("\nPURE — Appointment exact/window truth");
const exact = portalAppointmentWhenLabel(start, null, ny);
const exactZero = portalAppointmentWhenLabel(start, 0, ny);
const windowNy = portalAppointmentWhenLabel(start, 120, ny);
const windowLa = portalAppointmentWhenLabel(start, 120, la);
check("null window is exact appointment time", exact.kind === "exact");
check("0 window is exact appointment time", exactZero.kind === "exact");
check(
  "exact label uses Appointment time",
  exact.label.startsWith("Appointment time:") &&
    exact.label.includes(formatDateTime(start, ny)),
);
check("120-minute window is a window, not exact", windowNy.kind === "window");
check(
  "NY window ends two hours later on the same clock",
  windowNy.label.includes("Arrival window:") &&
    windowNy.label.includes(formatDateTime(start, ny)) &&
    windowNy.label.includes(formatTime(new Date(start.getTime() + 120 * 60 * 1000), ny)),
);
check(
  "Same UTC instant renders the LA window, not the NY clock",
  windowLa.label.includes(formatDateTime(start, la)) &&
    !windowLa.label.includes(formatTime(start, ny)),
);

const awaitingJob = {
  scheduledAt: start,
  scheduledDurationMinutes: 60,
  appointmentConfirmationStatus: "AWAITING_CUSTOMER",
  appointmentProposalId: 1,
  appointmentConfirmedForProposalId: null,
  appointmentConfirmationSource: null,
  propertyAccessMethod: null,
  propertyAccessInstructions: null,
  propertyAccessContactName: null,
  propertyAccessContactInfo: null,
  propertyAccessPickupLocation: null,
  propertyAccessNote: null,
};
const confirmedJob = {
  ...awaitingJob,
  appointmentConfirmationStatus: "CONFIRMED",
  appointmentConfirmedForProposalId: 1,
  appointmentConfirmationSource: "PORTAL",
  propertyAccessMethod: "CUSTOMER_PRESENT",
};
check(
  "Unconfirmed appointment is not called confirmed",
  portalAppointmentConfirmationCopy(awaitingJob).confirmed === false &&
    portalAppointmentConfirmationCopy(awaitingJob).label ===
      "Awaiting Your Confirmation",
);
check(
  "Confirmed current slot is called confirmed",
  portalAppointmentConfirmationCopy(confirmedJob).confirmed === true &&
    portalAppointmentConfirmationCopy(confirmedJob).label === "Appointment confirmed",
);

console.log("\nPURE — Status truth and next actions");
check("SENT message is Sent, not Delivered", customerFacingPortalMessageStatus("SENT") === "Sent");
check(
  "DELIVERED message is Delivered",
  customerFacingPortalMessageStatus("DELIVERED") === "Delivered",
);
check(
  "QUEUED/FAILED/DRAFT are not customer-visible",
  customerFacingPortalMessageStatus("QUEUED") === null &&
    customerFacingPortalMessageStatus("FAILED") === null &&
    customerFacingPortalMessageStatus("DRAFT") === null &&
    !isPortalCustomerVisibleMessageStatus("QUEUED"),
);
check(
  "EMAIL/SMS/PORTAL are the only customer-visible channels",
  isPortalCustomerVisibleMessageChannel("EMAIL") &&
    isPortalCustomerVisibleMessageChannel("SMS") &&
    isPortalCustomerVisibleMessageChannel("PORTAL") &&
    !isPortalCustomerVisibleMessageChannel("MANUAL") &&
    !isPortalCustomerVisibleMessageChannel("SYSTEM") &&
    !isPortalCustomerVisibleMessageChannel("PHONE") &&
    PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS.join(",") === "EMAIL,SMS,PORTAL",
);
check(
  "Invoice SENT is Outstanding, not Paid",
  customerFacingInvoiceTruth("SENT").label === "Outstanding" &&
    customerFacingInvoiceTruth("SENT").paid === false,
);
check(
  "Invoice PAID is Paid",
  customerFacingInvoiceTruth("PAID").label === "Paid" &&
    customerFacingInvoiceTruth("PAID").paid === true,
);
check(
  "DRAFT invoice is not available yet",
  customerFacingInvoiceTruth("DRAFT").label === "Not available yet",
);
check(
  "Additional work OPEN is Submitted",
  customerFacingAdditionalWorkStatus("OPEN") === "Submitted",
);
check(
  "Pending SENT change orders count only SENT",
  portalPendingChangeOrderCount([
    { status: "SENT" },
    { status: "APPROVED" },
    { status: "DRAFT" },
  ]) === 1 &&
    portalApprovedChangeOrderCount([
      { status: "SENT" },
      { status: "APPROVED" },
      { status: "APPROVED" },
    ]) === 2,
);
check(
  "Request summary never invents missing work",
  portalRequestSummary(null) === null &&
    portalRequestSummary({ summary: "  Ceiling fan  " })?.summary === "Ceiling fan",
);

const estimateAction = resolvePortalNextAction({
  projectToken: "tok",
  estimatePublicToken: "est-tok",
  estimateStatus: "SENT",
  appointmentScheduled: true,
  appointmentConfirmed: false,
  appointmentStatus: "AWAITING_CUSTOMER",
  pendingChangeOrderCount: 1,
  showPayInvoice: true,
  showPayDeposit: true,
  invoiceStatus: "SENT",
});
check(
  "Review estimate is the first next step when the estimate is SENT",
  estimateAction.kind === "review_estimate" &&
    estimateAction.href === "/e/est-tok",
);
const confirmAction = resolvePortalNextAction({
  projectToken: "tok",
  estimatePublicToken: "est-tok",
  estimateStatus: "APPROVED",
  appointmentScheduled: true,
  appointmentConfirmed: false,
  appointmentStatus: "AWAITING_CUSTOMER",
  pendingChangeOrderCount: 1,
  showPayInvoice: true,
  showPayDeposit: true,
  invoiceStatus: "SENT",
});
check(
  "Confirm appointment beats later actions when the slot is awaiting",
  confirmAction.kind === "confirm_appointment" &&
    confirmAction.href === "#appointment",
);
const payAction = resolvePortalNextAction({
  projectToken: "tok",
  estimatePublicToken: null,
  estimateStatus: "APPROVED",
  appointmentScheduled: true,
  appointmentConfirmed: true,
  appointmentStatus: "CONFIRMED",
  pendingChangeOrderCount: 0,
  showPayInvoice: true,
  showPayDeposit: true,
  invoiceStatus: "SENT",
});
check(
  "Pay invoice uses the existing invoice anchor, not a new mutation",
  payAction.kind === "pay_invoice" && payAction.href === "#invoice",
);

const ALLOWED_TEST_HOSTS = new Set(["localhost", "127.0.0.1"]);
function assertLocalDatabaseUrl(urlString, label) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    console.error(`${label} is not a valid URL.`);
    process.exit(1);
  }
  const host = (parsedUrl.hostname || "").toLowerCase();
  if (!ALLOWED_TEST_HOSTS.has(host)) {
    console.error(
      `Refusing client-portal-excellence test DB: ${label} host must be localhost or 127.0.0.1, got ${host || "(empty)"}.`,
    );
    process.exit(1);
  }
  return parsedUrl;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nDB skipped — DATABASE_URL is not set");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
assertLocalDatabaseUrl(baseUrl, "DATABASE_URL");

const testDbName = "tbbt_client_portal_excellence_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
assertLocalDatabaseUrl(testUrl, "client-portal-excellence test DATABASE_URL");
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for client-portal-excellence test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

async function seedBusiness(slug, name) {
  return prisma.business.create({
    data: { name, slug, tradeCode: "HANDYMAN", timezone: "America/New_York" },
  });
}

async function seedCustomer(businessId, name) {
  return prisma.customer.create({
    data: { businessId, name, email: `${slugSafe(name)}@example.com` },
  });
}

function slugSafe(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function seedJob(business, customer, extras = {}) {
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: extras.address ?? "12 Test St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const request = extras.withRequest
    ? await prisma.serviceRequest.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          propertyId: property.id,
          summary: extras.requestSummary ?? "Replace ceiling fan",
        },
      })
    : null;
  const estimate = extras.withEstimate
    ? await prisma.estimate.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          propertyId: property.id,
          serviceRequestId: request?.id ?? null,
          status: extras.estimateStatus ?? "APPROVED",
          total: new Prisma.Decimal("250.00"),
          publicToken: extras.estimateToken ?? randomUUID(),
        },
      })
    : null;
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      estimateId: estimate?.id ?? null,
      projectToken: extras.projectToken ?? randomUUID(),
      status: extras.status ?? "SCHEDULED",
      scheduledAt: extras.scheduledAt ?? start,
      scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
      arrivalWindowMinutes: extras.arrivalWindowMinutes ?? null,
      appointmentProposalId: extras.appointmentProposalId ?? 1,
      appointmentConfirmationStatus:
        extras.appointmentConfirmationStatus ?? "AWAITING_CUSTOMER",
      appointmentConfirmedForProposalId:
        extras.appointmentConfirmedForProposalId ?? null,
    },
  });
  return { property, request, estimate, job };
}

async function seedMessage(input) {
  return prisma.customerCommunication.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      direction: input.direction ?? "OUTBOUND",
      channel: input.channel ?? "SMS",
      purpose: input.purpose ?? "JOB_UPDATE",
      relatedType: input.relatedType ?? "JOB",
      relatedId: input.relatedId,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      bodySnapshot: input.body,
      status: input.status,
      provider: "test",
    },
  });
}

let serverProcess;
try {
  const alpha = await seedBusiness(
    `alpha-portal-${randomUUID().slice(0, 8)}`,
    "Alpha Portal Co",
  );
  const beta = await seedBusiness(
    `beta-portal-${randomUUID().slice(0, 8)}`,
    "Beta Portal Co",
  );
  const customerA = await seedCustomer(alpha.id, "Alpha Owner Customer");
  const sibling = await seedCustomer(alpha.id, "Sibling Secret Customer");
  const foreign = await seedCustomer(beta.id, "Foreign Secret Customer");

  const jobA = await seedJob(alpha, customerA, {
    projectToken: randomUUID(),
    withEstimate: true,
    withRequest: true,
    requestSummary: "Alpha ceiling fan",
    arrivalWindowMinutes: 120,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
  });
  const jobSibling = await seedJob(alpha, sibling, {
    projectToken: randomUUID(),
    withEstimate: true,
    status: "IN_PROGRESS",
  });
  const jobForeign = await seedJob(beta, foreign, {
    projectToken: randomUUID(),
    withEstimate: true,
    status: "COMPLETED",
  });
  const jobA2 = await seedJob(alpha, customerA, {
    projectToken: randomUUID(),
    withEstimate: true,
    status: "IN_PROGRESS",
    requestSummary: "Unrelated same-customer job",
  });

  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "SMS",
    body: "Alpha owned appointment reminder",
    status: "SENT",
    purpose: "APPOINTMENT_REMINDER",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "SMS",
    body: "Alpha owned delivered invoice note",
    status: "DELIVERED",
    purpose: "INVOICE_READY",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "EMAIL",
    body: "Alpha owned email estimate ready",
    status: "SENT",
    purpose: "ESTIMATE_READY",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "PORTAL",
    body: "Alpha owned portal project update",
    status: "SENT",
    purpose: "JOB_UPDATE",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "MANUAL",
    body: "Alpha manual owner note must stay hidden",
    status: "SENT",
    purpose: "OWNER_FOLLOW_UP",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "SYSTEM",
    body: "Alpha system log must stay hidden",
    status: "SENT",
    purpose: "JOB_UPDATE",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    channel: "PHONE",
    body: "Alpha phone log must stay hidden",
    status: "SENT",
    purpose: "MANUAL_PHONE",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    direction: "INBOUND",
    channel: "EMAIL",
    body: "Alpha inbound email must stay hidden",
    status: "SENT",
    purpose: "JOB_UPDATE",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA.job.id,
    body: "Alpha draft should stay hidden",
    status: "DRAFT",
    purpose: "JOB_UPDATE",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: customerA.id,
    relatedId: jobA2.job.id,
    channel: "EMAIL",
    body: "Unrelated same-customer leak body",
    status: "SENT",
    purpose: "JOB_UPDATE",
  });
  await seedMessage({
    businessId: alpha.id,
    customerId: sibling.id,
    relatedId: jobSibling.job.id,
    channel: "SMS",
    body: "Sibling secret leak body",
    status: "DELIVERED",
    purpose: "JOB_UPDATE",
  });
  await seedMessage({
    businessId: beta.id,
    customerId: foreign.id,
    relatedId: jobForeign.job.id,
    channel: "SMS",
    body: "Foreign secret leak body",
    status: "DELIVERED",
    purpose: "JOB_UPDATE",
  });

  await prisma.additionalWorkRequest.create({
    data: {
      businessId: alpha.id,
      jobId: jobA.job.id,
      description: "Alpha extra outlet",
      source: "CUSTOMER",
    },
  });
  await prisma.additionalWorkRequest.create({
    data: {
      businessId: alpha.id,
      jobId: jobA.job.id,
      description: "Alpha employee-only extra leak work",
      source: "EMPLOYEE",
    },
  });
  await prisma.additionalWorkRequest.create({
    data: {
      businessId: alpha.id,
      jobId: jobSibling.job.id,
      description: "Sibling extra leak work",
      source: "CUSTOMER",
    },
  });
  await prisma.additionalWorkRequest.create({
    data: {
      businessId: beta.id,
      jobId: jobForeign.job.id,
      description: "Foreign extra leak work",
      source: "CUSTOMER",
    },
  });

  await prisma.changeOrder.create({
    data: {
      businessId: alpha.id,
      jobId: jobA.job.id,
      title: "Alpha pending CO",
      status: "SENT",
      total: new Prisma.Decimal("40.00"),
    },
  });
  await prisma.changeOrder.create({
    data: {
      businessId: alpha.id,
      jobId: jobSibling.job.id,
      title: "Sibling secret CO",
      status: "SENT",
      total: new Prisma.Decimal("99.00"),
    },
  });

  console.log("\nISOLATED DB — Token-scoped communications and additional work");
  const alphaMessages = await loadPortalCustomerCommunications(
    prisma,
    jobA.job.projectToken,
  );
  const siblingMessages = await loadPortalCustomerCommunications(
    prisma,
    jobSibling.job.projectToken,
  );
  const foreignMessages = await loadPortalCustomerCommunications(
    prisma,
    jobForeign.job.projectToken,
  );
  const missingMessages = await loadPortalCustomerCommunications(
    prisma,
    randomUUID(),
  );
  const otherJobMessages = await loadPortalCustomerCommunications(
    prisma,
    jobA2.job.projectToken,
  );
  check(
    "Owned token sees only this customer's outbound SENT/DELIVERED EMAIL/SMS/PORTAL messages",
    alphaMessages.length === 4 &&
      alphaMessages.some((row) => row.body.includes("Alpha owned appointment reminder")) &&
      alphaMessages.some((row) => row.body.includes("Alpha owned delivered invoice note")) &&
      alphaMessages.some((row) => row.body.includes("Alpha owned email estimate ready")) &&
      alphaMessages.some((row) => row.body.includes("Alpha owned portal project update")) &&
      alphaMessages.every((row) => row.direction === "OUTBOUND") &&
      alphaMessages.every((row) => ["EMAIL", "SMS", "PORTAL"].includes(row.channel)) &&
      alphaMessages.every((row) => row.statusLabel === "Sent" || row.statusLabel === "Delivered"),
  );
  check(
    "EMAIL + SENT matching Job renders",
    alphaMessages.some(
      (row) =>
        row.channel === "EMAIL" &&
        row.statusLabel === "Sent" &&
        row.body.includes("Alpha owned email estimate ready"),
    ),
  );
  check(
    "SMS + DELIVERED matching Job renders",
    alphaMessages.some(
      (row) =>
        row.channel === "SMS" &&
        row.statusLabel === "Delivered" &&
        row.body.includes("Alpha owned delivered invoice note"),
    ),
  );
  check(
    "PORTAL + SENT matching Job renders",
    alphaMessages.some(
      (row) =>
        row.channel === "PORTAL" &&
        row.statusLabel === "Sent" &&
        row.body.includes("Alpha owned portal project update"),
    ),
  );
  check(
    "MANUAL + SENT matching Job does not render",
    alphaMessages.every((row) => !row.body.includes("manual owner note must stay hidden")),
  );
  check(
    "SYSTEM + SENT matching Job does not render",
    alphaMessages.every((row) => !row.body.includes("system log must stay hidden")),
  );
  check(
    "PHONE notes and inbound rows do not render",
    alphaMessages.every((row) => !row.body.includes("phone log must stay hidden")) &&
      alphaMessages.every((row) => !row.body.includes("inbound email must stay hidden")) &&
      alphaMessages.every((row) => row.direction === "OUTBOUND"),
  );
  check(
    "DRAFT is not shown as a customer-visible message",
    alphaMessages.every((row) => !row.body.includes("draft should stay hidden")),
  );
  check(
    "Unrelated same-customer message cannot leak into this project token",
    alphaMessages.every((row) => !row.body.includes("Unrelated same-customer leak body")) &&
      otherJobMessages.length === 1 &&
      otherJobMessages[0].body.includes("Unrelated same-customer leak body"),
  );
  check(
    "Sibling customer cannot leak into Alpha's portal messages",
    alphaMessages.every((row) => !row.body.includes("Sibling secret")) &&
      siblingMessages.every((row) => row.body.includes("Sibling secret leak body")) &&
      siblingMessages.length === 1,
  );
  check(
    "Foreign business cannot leak into Alpha's portal messages",
    alphaMessages.every((row) => !row.body.includes("Foreign secret")) &&
      foreignMessages.every((row) => row.body.includes("Foreign secret leak body")),
  );
  check("Unknown token returns no communications", missingMessages.length === 0);
  check(
    "SENT row is labeled Sent, not Delivered",
    alphaMessages.find((row) => row.body.includes("appointment reminder"))
      ?.statusLabel === "Sent",
  );
  check(
    "DELIVERED row is labeled Delivered",
    alphaMessages.find((row) => row.body.includes("delivered invoice note"))
      ?.statusLabel === "Delivered",
  );

  const alphaWork = await loadPortalAdditionalWorkRequests(
    prisma,
    jobA.job.projectToken,
  );
  const siblingWork = await loadPortalAdditionalWorkRequests(
    prisma,
    jobSibling.job.projectToken,
  );
  const missingWork = await loadPortalAdditionalWorkRequests(prisma, randomUUID());
  check(
    "Owned token sees only this job's customer-originated additional-work requests",
    alphaWork.length === 1 &&
      alphaWork[0].description === "Alpha extra outlet" &&
      alphaWork[0].statusLabel === "Submitted",
  );
  check(
    "Employee-originated additional work on the same job is omitted from the portal loader",
    alphaWork.every((row) => !row.description.includes("employee-only")),
  );
  check(
    "Sibling additional work does not appear on Alpha's token",
    alphaWork.every((row) => !row.description.includes("Sibling")) &&
      siblingWork.some((row) => row.description.includes("Sibling extra leak work")),
  );
  check("Unknown token returns no additional-work requests", missingWork.length === 0);

  const repoRoot = new URL("..", import.meta.url).pathname;
  if (!existsSync(`${repoRoot}.next`)) {
    console.log("\nHTTP skipped — no .next build output yet");
  } else {
    const PORT = 43831;
    const APP_URL = `http://127.0.0.1:${PORT}`;
    async function waitForServer(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
          if (res.status < 500) return true;
        } catch {
          // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return false;
    }

    serverProcess = spawn(
      "node_modules/.bin/next",
      ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
      {
        cwd: repoRoot.replace(/\/$/, ""),
        env: {
          ...process.env,
          DATABASE_URL: testUrl,
          NODE_ENV: "production",
        },
        stdio: "pipe",
      },
    );
    let serverOutput = "";
    serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
    serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));
    const up = await waitForServer(30_000);
    if (!up) {
      console.error("Server did not start in time. Output so far:\n" + serverOutput);
      failed += 1;
    } else {
      console.log("\nHTTP — Token isolation and recorded-truth copy");
      const owned = await fetch(`${APP_URL}/p/${jobA.job.projectToken}`, {
        redirect: "manual",
      });
      const ownedBody = await owned.text();
      check("owned token returns 200", owned.status === 200);
      check("owned page shows this business", ownedBody.includes("Alpha Portal Co"));
      check(
        "owned portal HTML shows the customer-originated additional-work request",
        ownedBody.includes("Alpha extra outlet"),
      );
      check(
        "owned portal HTML omits same-job employee-originated additional-work text",
        !ownedBody.includes("Alpha employee-only extra leak work"),
      );
      check("owned page shows this customer", ownedBody.includes("Alpha Owner Customer"));
      check("owned page is Project Home", ownedBody.includes("Project Home"));
      check(
        "owned page does not show sibling customer",
        !ownedBody.includes("Sibling Secret Customer") &&
          !ownedBody.includes("Sibling secret leak body") &&
          !ownedBody.includes("Sibling extra leak work") &&
          !ownedBody.includes("Sibling secret CO"),
      );
      check(
        "owned page does not show foreign business or customer",
        !ownedBody.includes("Beta Portal Co") &&
          !ownedBody.includes("Foreign Secret Customer") &&
          !ownedBody.includes("Foreign secret leak body"),
      );
      check(
        "unconfirmed appointment is not called confirmed",
        ownedBody.includes("Awaiting Your Confirmation") &&
          !ownedBody.includes("Appointment confirmed"),
      );
      check(
        "arrival window copy uses recorded window truth",
        ownedBody.includes("Arrival window:") &&
          !ownedBody.includes("Technician is on the way"),
      );
      check(
        "SENT communication is shown as Sent, not delivered",
        ownedBody.includes("Alpha owned appointment reminder") &&
          ownedBody.includes("Sent") &&
          ownedBody.includes("Alpha owned delivered invoice note"),
      );
      check(
        "EMAIL/SMS/PORTAL customer-facing deliveries render",
        ownedBody.includes("Alpha owned email estimate ready") &&
          ownedBody.includes("Alpha owned delivered invoice note") &&
          ownedBody.includes("Alpha owned portal project update"),
      );
      check(
        "MANUAL/SYSTEM/PHONE/inbound/unrelated bodies stay hidden",
        !ownedBody.includes("Alpha manual owner note must stay hidden") &&
          !ownedBody.includes("Alpha system log must stay hidden") &&
          !ownedBody.includes("Alpha phone log must stay hidden") &&
          !ownedBody.includes("Alpha inbound email must stay hidden") &&
          !ownedBody.includes("Unrelated same-customer leak body") &&
          !ownedBody.includes("sent or received"),
      );
      check(
        "DRAFT communication is absent",
        !ownedBody.includes("Alpha draft should stay hidden"),
      );
      check(
        "internal private facts stay absent",
        !ownedBody.includes("Business Vault") &&
          !ownedBody.includes("Chief-of-Staff") &&
          !ownedBody.includes("Your message was read") &&
          !ownedBody.includes("laborCost") &&
          !ownedBody.includes("supplierCost"),
      );
      check(
        "canonical next-step / change-order path remains",
        ownedBody.includes("Confirm appointment") &&
          ownedBody.includes("Change Orders") &&
          ownedBody.includes("Approve") &&
          ownedBody.includes("Pending Approval"),
      );

      const siblingRes = await fetch(`${APP_URL}/p/${jobSibling.job.projectToken}`, {
        redirect: "manual",
      });
      const siblingBody = await siblingRes.text();
      check("sibling token returns 200", siblingRes.status === 200);
      check(
        "sibling token cannot see Alpha customer or Alpha request",
        siblingBody.includes("Sibling Secret Customer") &&
          !siblingBody.includes("Alpha Owner Customer") &&
          !siblingBody.includes("Alpha extra outlet") &&
          !siblingBody.includes("Alpha owned appointment reminder"),
      );

      const invalid = await fetch(`${APP_URL}/p/${randomUUID()}`, {
        redirect: "manual",
      });
      const invalidBody = await invalid.text();
      check("invalid token is unavailable, not an error leak", invalid.status === 200);
      check(
        "invalid token hides Alpha and sibling names",
        invalidBody.includes("Project unavailable") &&
          !invalidBody.includes("Alpha Portal Co") &&
          !invalidBody.includes("Alpha Owner Customer") &&
          !invalidBody.includes("Sibling Secret Customer"),
      );
    }
  }
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll client-portal excellence checks passed (${passed}).`
    : `\n${failed} client-portal excellence check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
