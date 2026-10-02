/**
 * Complete Job → create/reuse a draft invoice. Send is a separate
 * sendDraftInvoiceIfNeeded / markInvoiceSent step (DRAFT → SENT).
 *
 * Imports the real completeJobAndDraftInvoice / persist helpers.
 * Server actions that depend on next/headers are not invoked.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-complete-job-invoice.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  completeJobAndDraftInvoice,
  invoiceSendShouldNotify,
  ownerCompleteJobSuccessState,
  sendDraftInvoiceIfNeeded,
} = await import("@/lib/complete-job-invoice");
const {
  COMPLETE_JOB_DRAFT_INVOICE_MESSAGE,
  FIELD_COMPLETE_JOB_MESSAGE,
  INVOICE_ALREADY_SENT_MESSAGE,
  completedJobPageInvoiceMessage,
  workOrderCardCompletedInvoiceMessage,
  invoicePageStatusMessage,
  completeJobDraftInvoiceHref,
} = await import("@/lib/complete-job-copy");
const {
  clockInTime,
  JOB_COMPLETION_TIME_CLOSED_REASON,
} = await import("@/lib/time-card-ops");
const { weekRange } = await import("@/lib/time-cards");
const {
  isCustomerVisibleInvoiceStatus,
  loadInvoiceDocumentForProjectToken,
} = await import("@/lib/invoice-document");
const { renderInvoicePdf } = await import("@/lib/invoice-pdf");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_complete_job_invoice_test";
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
  console.error("Failed to push schema for complete-job-invoice test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function pdfExtractText(buffer) {
  const raw = buffer.toString("latin1");
  return [...raw.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((match) => {
      try {
        return Buffer.from(match[1], "hex").toString("utf8");
      } catch {
        return "";
      }
    })
    .join("");
}

function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function createInProgressApprovedJob(input) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "APPROVED",
      total: new Prisma.Decimal(input.estimateTotal),
      laborMinimumAdjustment: new Prisma.Decimal(input.laborMinimum ?? 0),
      publicToken: randomUUID(),
    },
  });

  for (const line of input.estimateLines) {
    await prisma.lineItem.create({
      data: {
        businessId: input.businessId,
        estimateId: estimate.id,
        description: line.description,
        quantity: new Prisma.Decimal(line.quantity),
        unitPrice: new Prisma.Decimal(line.unitPrice),
        total: new Prisma.Decimal(line.total),
        type: "LABOR",
      },
    });
  }

  const version = await prisma.estimateVersion.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(input.estimateTotal),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(input.laborMinimum ?? 0),
      customerName: input.customerName,
      approvedAt: new Date(),
      lineItems: {
        create: input.estimateLines.map((line) => ({
          businessId: input.businessId,
          description: line.description,
          quantity: new Prisma.Decimal(line.quantity),
          unitPrice: new Prisma.Decimal(line.unitPrice),
          total: new Prisma.Decimal(line.total),
          type: "LABOR",
        })),
      },
    },
  });

  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });

  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      status: input.status ?? "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });

  return { estimate, version, job };
}

async function addChangeOrder(input) {
  const changeOrder = await prisma.changeOrder.create({
    data: {
      businessId: input.businessId,
      jobId: input.jobId,
      title: input.title,
      status: input.status,
      total: new Prisma.Decimal(input.total),
      approvedAt: input.status === "APPROVED" ? new Date() : null,
      sentAt: input.status === "SENT" || input.status === "APPROVED" ? new Date() : null,
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      changeOrderId: changeOrder.id,
      description: input.description,
      quantity: new Prisma.Decimal(input.quantity ?? 1),
      unitPrice: new Prisma.Decimal(input.total),
      total: new Prisma.Decimal(input.total),
      type: "LABOR",
    },
  });
  return changeOrder;
}

try {
  console.log("\nPURE — send notification gate");
  check("DRAFT invoices notify on send", invoiceSendShouldNotify("DRAFT") === true);
  check("SENT invoices do not notify again", invoiceSendShouldNotify("SENT") === false);
  check("PAID invoices do not notify again", invoiceSendShouldNotify("PAID") === false);

  const copySrc = readFileSync(new URL("../src/lib/complete-job-copy.ts", import.meta.url), "utf8");
  const completeSrc = readFileSync(new URL("../src/lib/complete-job-invoice.ts", import.meta.url), "utf8");
  const jobActionSrc = readFileSync(new URL("../src/app/actions/job.ts", import.meta.url), "utf8");
  const completeButtonSrc = readFileSync(
    new URL("../src/components/jobs/mark-job-complete-button.tsx", import.meta.url),
    "utf8",
  );
  const workOrderCardSrc = readFileSync(
    new URL("../src/components/jobs/jobs-workspace.tsx", import.meta.url),
    "utf8",
  );
  const jobPageSrc = readFileSync(new URL("../src/app/(app)/jobs/[jobId]/page.tsx", import.meta.url), "utf8");
  const invoicePageSrc = readFileSync(
    new URL("../src/app/(app)/invoices/[invoiceId]/page.tsx", import.meta.url),
    "utf8",
  );
  const fieldButtonSrc = readFileSync(
    new URL("../src/components/field/complete-assigned-job-button.tsx", import.meta.url),
    "utf8",
  );
  const fieldPageSrc = readFileSync(new URL("../src/app/field/jobs/[jobId]/page.tsx", import.meta.url), "utf8");
  const nativeJobSrc = readFileSync(new URL("../apps/native/src/screens/JobScreen.tsx", import.meta.url), "utf8");
  const todaySrc = readFileSync(new URL("../src/lib/owner-today.ts", import.meta.url), "utf8");
  const bsosSrc = readFileSync(new URL("../src/lib/bsos.ts", import.meta.url), "utf8");
  check(
    "draft completion message is pinned",
    COMPLETE_JOB_DRAFT_INVOICE_MESSAGE ===
      "Job completed. Invoice drafted - review it and press Send when ready.",
  );
  check(
    "field completion message does not claim an invoice was sent or drafted",
    FIELD_COMPLETE_JOB_MESSAGE ===
      "This job is complete. The owner will review and send the invoice when ready." &&
      !/invoice was sent|sent automatically|invoice drafted/i.test(FIELD_COMPLETE_JOB_MESSAGE),
  );

  const draftOnlyAttention = {
    unbilled: true,
    reason: "draft-only-invoice",
    detail: "Completed job invoice has not been sent",
    invoiceStatuses: ["DRAFT"],
  };
  check(
    "job page draft-only derived output is the Send prompt, not the generic unbilled detail",
    completedJobPageInvoiceMessage(draftOnlyAttention) === COMPLETE_JOB_DRAFT_INVOICE_MESSAGE &&
      completedJobPageInvoiceMessage(draftOnlyAttention) !== draftOnlyAttention.detail,
  );
  check(
    "job page other unbilled reasons keep their detail",
    completedJobPageInvoiceMessage({
      unbilled: true,
      reason: "no-covering-invoice",
      detail: "Completed job has unbilled approved work",
      invoiceStatuses: [],
    }) === "Completed job has unbilled approved work",
  );
  check(
    "work-order card derived output is the Send prompt for a draft invoice",
    workOrderCardCompletedInvoiceMessage("DRAFT") === COMPLETE_JOB_DRAFT_INVOICE_MESSAGE &&
      workOrderCardCompletedInvoiceMessage("SENT") === null,
  );
  check(
    "invoice page derived output is the Send prompt for a draft invoice",
    invoicePageStatusMessage("DRAFT") === COMPLETE_JOB_DRAFT_INVOICE_MESSAGE &&
      invoicePageStatusMessage("SENT", false) !== COMPLETE_JOB_DRAFT_INVOICE_MESSAGE,
  );

  const markJobCompleteFn = jobActionSrc.slice(
    jobActionSrc.indexOf("export async function markJobComplete"),
    jobActionSrc.indexOf(
      "export async function",
      jobActionSrc.indexOf("export async function markJobComplete") + 1,
    ),
  );
  check(
    "markJobComplete returns the draft success message and invoice href",
    markJobCompleteFn.includes("...ownerCompleteJobSuccessState(result)") &&
      markJobCompleteFn.includes("warning: result.warning"),
  );
  check(
    "job page Invoice card renders the derived draft-only helper",
    /<CardDescription>\s*\{completedJobPageInvoiceMessage\(/.test(jobPageSrc) &&
      !/<CardDescription>\s*\{billingAttention/.test(jobPageSrc) &&
      jobPageSrc.includes("MarkInvoiceSentButton") &&
      jobPageSrc.includes("`/invoices/${invoice.id}`") &&
      jobPageSrc.includes("`/invoices/${row.id}`"),
  );
  check(
    "work-order card renders the derived draft message plus Send and Open invoice",
    workOrderCardSrc.includes("workOrderCardCompletedInvoiceMessage(") &&
      workOrderCardSrc.includes("{draftInvoicePrompt}") &&
      workOrderCardSrc.includes("MarkInvoiceSentButton") &&
      workOrderCardSrc.includes("`/invoices/${job.invoice.id}`") &&
      !workOrderCardSrc.includes("invoice was sent"),
  );
  check(
    "invoice page renders the derived draft message where Send lives",
    invoicePageSrc.includes("invoicePageStatusMessage(") &&
      invoicePageSrc.includes("MarkInvoiceSentButton") &&
      !invoicePageSrc.includes("invoice was sent automatically"),
  );
  check(
    "owner Complete Job button still exposes a transient Open invoice path",
    completeButtonSrc.includes("state.message") &&
      completeButtonSrc.includes("Open invoice") &&
      completeButtonSrc.includes("completeJobDraftInvoiceHref") &&
      !completeButtonSrc.includes("invoice was sent"),
  );
  check(
    "field and native complete copy does not claim send or double the sentence",
    fieldButtonSrc.includes("state.message") &&
      fieldPageSrc.includes("{FIELD_COMPLETE_JOB_MESSAGE}") &&
      !fieldPageSrc.includes("This job is complete. {FIELD_COMPLETE_JOB_MESSAGE}") &&
      nativeJobSrc.includes(FIELD_COMPLETE_JOB_MESSAGE) &&
      !nativeJobSrc.includes("invoice was sent") &&
      todaySrc.includes("Owner Complete Job leaves a draft") &&
      bsosSrc.includes("Owner Complete Job leaves a draft until Send") &&
      !completeSrc.includes("sendDraftInvoiceIfNeeded(db"),
  );
  check(
    "draft success state points at the invoice Send page",
    ownerCompleteJobSuccessState({
      ok: true,
      jobCompleted: true,
      invoiceId: "inv_draft",
      invoiceCreated: true,
      invoiceReused: false,
      invoiceStatus: "DRAFT",
      newlySent: false,
      customerNotified: false,
    }).message === COMPLETE_JOB_DRAFT_INVOICE_MESSAGE &&
      completeJobDraftInvoiceHref("inv_draft") === "/invoices/inv_draft",
  );
  check("copy helpers live next to the pinned draft message", copySrc.includes("completedJobPageInvoiceMessage"));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Jordan Rivera",
      email: "jordan@example.com",
    },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Other Ave",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner-complete@example.com", passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member-complete@example.com", passwordHash: "x" },
  });
  const otherUser = await prisma.user.create({
    data: { name: "Omar Other", email: "other-complete@example.com", passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Bea Owner", email: "beta-owner-complete@example.com", passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" },
  });
  function makeAccess(businessId, role, membershipId) {
    return {
      businessId,
      workspace: { role, membership: { id: membershipId } },
      scope: { businessId },
      assertOwned(record) {
        if (!record || record.businessId !== businessId) {
          throw new Error("Record is not in the authorized business workspace.");
        }
        return record;
      },
    };
  }
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);

  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });
  const propertyB = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      addressLine1: "99 Beta Way",
    },
  });

  const work = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 275,
    laborMinimum: 0,
    estimateLines: [
      {
        description: "Closet Shelf / Rod Repair",
        quantity: 2,
        unitPrice: 100,
        total: 200,
      },
      {
        description: "Curtain Rod Installation",
        quantity: 1,
        unitPrice: 75,
        total: 75,
      },
    ],
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Closet Shelf / Rod Repair",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(100),
      active: true,
    },
  });

  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Draft leftover",
    status: "DRAFT",
    total: 0,
    description: "Old $0 draft",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Sent not approved",
    status: "SENT",
    total: 55,
    description: "Sent only line",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Declined extra",
    status: "DECLINED",
    total: 60,
    description: "Declined only line",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Cancelled extra",
    status: "CANCELLED",
    total: 70,
    description: "Cancelled only line",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Keypad change order",
    status: "APPROVED",
    total: 100,
    description: "Keypad / Electronic Deadbolt Replacement",
  });
  await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: work.job.id,
      description: "Unconverted additional work",
      status: "OPEN",
      source: "CUSTOMER",
    },
  });

  console.log("\nTEST A — Completing an approved job creates one draft invoice");
  const completed = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("complete succeeds", completed.ok === true);
  check("job is marked completed", (await prisma.job.findUniqueOrThrow({ where: { id: work.job.id } })).status === "COMPLETED");
  check("invoice was created", completed.ok && completed.invoiceCreated === true);
  check("invoice stays DRAFT until an explicit send", completed.ok && completed.invoiceStatus === "DRAFT" && completed.newlySent === false);
  check("complete does not notify the customer", completed.ok && completed.customerNotified === false);
  check(
    "complete success copy is the draft Send prompt",
    completed.ok &&
      ownerCompleteJobSuccessState(completed).message === COMPLETE_JOB_DRAFT_INVOICE_MESSAGE &&
      ownerCompleteJobSuccessState(completed).invoiceHref === `/invoices/${completed.invoiceId}`,
  );
  const completeEvents = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, subjectId: work.job.id },
    select: { type: true },
  });
  const invoiceEventsAfterComplete = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, subjectId: completed.ok ? completed.invoiceId : "" },
    select: { type: true },
  });
  check(
    "complete does not emit INVOICE_SENT",
    completeEvents.every((event) => event.type !== "INVOICE_SENT") &&
      invoiceEventsAfterComplete.every((event) => event.type !== "INVOICE_SENT"),
  );
  check(
    "complete writes no invoice-ready email or SMS",
    (await prisma.customerCommunication.count({
      where: {
        businessId: businessA.id,
        relatedType: "INVOICE",
        relatedId: completed.ok ? completed.invoiceId : undefined,
      },
    })) === 0,
  );
  check("draft is not portal-visible", isCustomerVisibleInvoiceStatus(completed.ok ? completed.invoiceStatus : "") === false);

  const invoiceCount = await prisma.invoice.count({ where: { jobId: work.job.id } });
  check("exactly one invoice", invoiceCount === 1);
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: completed.invoiceId },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("invoice total is $375", invoice.total.toString() === "375");
  check("three approved work lines", invoice.lineItems.length === 3);
  check(
    "original approved closet qty 2",
    invoice.lineItems[0].description === "Closet Shelf / Rod Repair" &&
      invoice.lineItems[0].quantity.toString() === "2",
  );
  check(
    "original approved curtain qty 1",
    invoice.lineItems[1].description === "Curtain Rod Installation",
  );
  check(
    "approved change-order keypad is included",
    invoice.lineItems[2].description === "Keypad / Electronic Deadbolt Replacement",
  );
  check(
    "unapproved change orders and raw additional work are excluded",
    invoice.lineItems.every(
      (line) =>
        !["Old $0 draft", "Sent only line", "Declined only line", "Cancelled only line", "Unconverted additional work"].includes(
          line.description,
        ),
    ),
  );

  const draftPortalDoc = await loadInvoiceDocumentForProjectToken(
    work.job.projectToken,
    prisma,
  );
  check("customer portal cannot load the draft invoice", draftPortalDoc == null);

  const sent = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessA.id,
    invoiceId: invoice.id,
    businessName: businessA.name,
  });
  check("explicit send flips DRAFT to SENT", sent.ok === true && sent.newlySent === true && sent.status === "SENT");
  check(
    "explicit send emits INVOICE_SENT exactly once",
    (await prisma.businessEvent.count({
      where: { businessId: businessA.id, type: "INVOICE_SENT", subjectId: invoice.id },
    })) === 1,
  );
  const sentAgain = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessA.id,
    invoiceId: invoice.id,
    businessName: businessA.name,
  });
  check(
    "duplicate send is idempotent already-sent success",
    sentAgain.ok === true &&
      sentAgain.newlySent === false &&
      sentAgain.alreadySent === true &&
      sentAgain.message === INVOICE_ALREADY_SENT_MESSAGE,
  );
  check(
    "duplicate send does not emit a second INVOICE_SENT",
    (await prisma.businessEvent.count({
      where: { businessId: businessA.id, type: "INVOICE_SENT", subjectId: invoice.id },
    })) === 1,
  );

  const portalDoc = await loadInvoiceDocumentForProjectToken(
    work.job.projectToken,
    prisma,
  );
  check("customer portal can load the sent invoice", portalDoc?.invoiceId === invoice.id);
  check("portal document lists the three work descriptions", portalDoc?.lineItems.length === 3);
  const pdf = await renderInvoicePdf(portalDoc);
  const pdfText = pdfExtractText(pdf);
  check("PDF contains closet work", pdfText.includes("Closet Shelf / Rod Repair"));
  check("PDF contains keypad work", pdfText.includes("Keypad / Electronic Deadbolt Replacement"));
  check("PDF contains WORK PERFORMED", pdfText.includes("WORK PERFORMED"));
  check("PDF total is $375.00", pdfText.includes("$375.00"));

  console.log("\nTEST — Concurrent double Send is already-sent success");
  const concurrentWork = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 40,
    estimateLines: [{ description: "Concurrent send", quantity: 1, unitPrice: 40, total: 40 }],
  });
  const concurrentCompleted = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: concurrentWork.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check(
    "concurrent fixture stays DRAFT until send",
    concurrentCompleted.ok === true && concurrentCompleted.invoiceStatus === "DRAFT",
  );
  const concurrentSends = await Promise.all([
    sendDraftInvoiceIfNeeded(prisma, {
      businessId: businessA.id,
      invoiceId: concurrentCompleted.invoiceId,
      businessName: businessA.name,
    }),
    sendDraftInvoiceIfNeeded(prisma, {
      businessId: businessA.id,
      invoiceId: concurrentCompleted.invoiceId,
      businessName: businessA.name,
    }),
  ]);
  check(
    "both concurrent Send clicks succeed",
    concurrentSends.every(
      (result) =>
        result.ok === true &&
        result.status === "SENT" &&
        result.error == null,
    ),
  );
  check(
    "exactly one concurrent click newly sends",
    concurrentSends.filter((result) => result.ok && result.newlySent === true).length === 1,
  );
  check(
    "the losing Send click is already-sent success, not a created-but-could-not-send error",
    concurrentSends.some(
      (result) =>
        result.ok === true &&
        result.newlySent === false &&
        result.alreadySent === true &&
        result.message === INVOICE_ALREADY_SENT_MESSAGE,
    ) &&
      concurrentSends.every(
        (result) => result.error !== "The invoice was created but could not be sent.",
      ),
  );
  check(
    "concurrent Send emits INVOICE_SENT exactly once",
    (await prisma.businessEvent.count({
      where: {
        businessId: businessA.id,
        type: "INVOICE_SENT",
        subjectId: concurrentCompleted.ok ? concurrentCompleted.invoiceId : "",
      },
    })) === 1,
  );

  console.log("\nTEST B — Retrying Complete Job is idempotent");
  const retry = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("retry succeeds", retry.ok === true);
  check("retry reuses the same invoice", retry.ok && retry.invoiceId === invoice.id && retry.invoiceReused === true);
  check("retry does not send again", retry.ok && retry.newlySent === false);
  check("retry does not notify again", retry.ok && retry.customerNotified === false);
  check(
    "still exactly one invoice",
    (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 1,
  );
  check(
    "line items were not duplicated",
    (await prisma.lineItem.count({ where: { invoiceId: invoice.id } })) === 3,
  );
  const afterRetry = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("retry did not change invoice total", afterRetry.total.toString() === "375");
  check("retry left status SENT", afterRetry.status === "SENT");
  check(
    "retry complete still leaves INVOICE_SENT at exactly one",
    (await prisma.businessEvent.count({
      where: { businessId: businessA.id, type: "INVOICE_SENT", subjectId: invoice.id },
    })) === 1,
  );
  check("retry created no payment write", afterRetry.paidAt == null && afterRetry.paymentMethod == null);

  console.log("\nTEST C — Approved scope stays frozen after catalog edits");
  const estimateBefore = await prisma.estimateVersion.findUniqueOrThrow({
    where: { id: work.version.id },
  });
  await prisma.serviceCatalogItem.update({
    where: { id: catalog.id },
    data: { price: new Prisma.Decimal(9999), name: "NEW CATALOG NAME" },
  });
  await prisma.estimate.update({
    where: { id: work.estimate.id },
    data: { total: new Prisma.Decimal(9999) },
  });
  const frozen = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("invoice total still $375 after catalog edit", frozen.total.toString() === "375");
  check(
    "invoice line still uses the approved snapshot description/price",
    frozen.lineItems[0].description === "Closet Shelf / Rod Repair" &&
      frozen.lineItems[0].unitPrice.toString() === "100",
  );
  check(
    "original approved estimate version is unchanged",
    (await prisma.estimateVersion.findUniqueOrThrow({ where: { id: work.version.id } })).total.toString() ===
      estimateBefore.total.toString(),
  );

  console.log("\nTEST E — Existing paid invoice is not financially altered");
  const paidAt = new Date("2026-09-03T16:00:00.000Z");
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: "PAID",
      paidAt,
      paymentMethod: "STRIPE",
      paymentReference: "pi_existing_375",
    },
  });
  const paidRetry = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("paid retry succeeds without a new invoice", paidRetry.ok === true && paidRetry.invoiceId === invoice.id);
  check("paid retry does not send again", paidRetry.ok && paidRetry.newlySent === false);
  check("paid status is unchanged", paid.status === "PAID");
  check("paid total is unchanged", paid.total.toString() === "375");
  check("paidAt is unchanged", paid.paidAt?.toISOString() === paidAt.toISOString());
  check("payment method is unchanged", paid.paymentMethod === "STRIPE");
  check("payment reference is unchanged", paid.paymentReference === "pi_existing_375");

  console.log("\nTEST F — Tenant isolation");
  const foreign = await completeJobAndDraftInvoice(prisma, {
    businessId: businessB.id,
    jobId: work.job.id,
    businessName: businessB.name,
    actorMembershipId: betaOwnerMem.id,
  });
  check("other business cannot complete/send this job", foreign.ok === false);
  check(
    "foreign complete did not add a second invoice",
    (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 1,
  );
  const foreignSend = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessB.id,
    invoiceId: invoice.id,
    businessName: businessB.name,
  });
  check("other business cannot send this invoice", foreignSend.ok === false);
  const stillPaid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("isolated send attempt left payment state alone", stillPaid.status === "PAID" && stillPaid.total.toString() === "375");

  console.log("\nTEST — Unstarted job is not completed or invoiced");
  const unstarted = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 50,
    estimateLines: [
      { description: "Unstarted work", quantity: 1, unitPrice: 50, total: 50 },
    ],
    status: "SCHEDULED",
  });
  const blocked = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: unstarted.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("unstarted job is rejected", blocked.ok === false);
  check(
    "unstarted job stays SCHEDULED",
    (await prisma.job.findUniqueOrThrow({ where: { id: unstarted.job.id } })).status === "SCHEDULED",
  );
  check(
    "no invoice was created for the unstarted job",
    (await prisma.invoice.count({ where: { jobId: unstarted.job.id } })) === 0,
  );

  console.log("\nTEST — Owner completion closes exact-job RUNNING JOB time");
  const timed = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 80,
    estimateLines: [{ description: "Timed labor", quantity: 1, unitPrice: 80, total: 80 }],
  });
  await prisma.job.update({
    where: { id: timed.job.id },
    data: { assignedMembershipId: memberMem.id },
  });
  const sibling = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 40,
    estimateLines: [{ description: "Sibling job", quantity: 1, unitPrice: 40, total: 40 }],
  });
  await prisma.job.update({
    where: { id: sibling.job.id },
    data: { assignedMembershipId: otherMem.id },
  });
  const jobAStartedAt = new Date(Date.now() - 50 * 60 * 1000);
  const runningJobA = await clockInTime(prisma, memberA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: timed.job.id,
    startedAt: jobAStartedAt,
    note: "On site finishing timed labor",
  });
  const runningJobB = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: otherMem.id,
      jobId: sibling.job.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      endedAt: null,
      source: "CLOCK",
    },
  });
  const runningTravel = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: ownerMem.id,
      activityType: "TRAVEL",
      status: "RUNNING",
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      endedAt: null,
      source: "CLOCK",
    },
  });
  const completedTimed = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: timed.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  const closedTimed = await prisma.timeEntry.findUnique({ where: { id: runningJobA.id } });
  const timedAdjustments = await prisma.timeEntryAdjustment.findMany({
    where: { timeEntryId: runningJobA.id, reason: JOB_COMPLETION_TIME_CLOSED_REASON },
  });
  check("owner complete with running JOB time succeeds", completedTimed.ok === true);
  check(
    "timed job is COMPLETED",
    (await prisma.job.findUniqueOrThrow({ where: { id: timed.job.id } })).status === "COMPLETED",
  );
  check(
    "invoice behavior is preserved",
    completedTimed.ok &&
      completedTimed.invoiceCreated === true &&
      completedTimed.invoiceStatus === "DRAFT" &&
      completedTimed.newlySent === false,
  );
  check(
    "RUNNING JOB entry is READY with endedAt and preserved startedAt/note",
    closedTimed.status === "READY" &&
      closedTimed.endedAt != null &&
      closedTimed.startedAt.getTime() === jobAStartedAt.getTime() &&
      closedTimed.note === "On site finishing timed labor",
  );
  check("completion wrote one truthful close adjustment", timedAdjustments.length === 1);
  check(
    "sibling Job B running JOB entry is untouched",
    (await prisma.timeEntry.findUnique({ where: { id: runningJobB.id } })).status === "RUNNING",
  );
  check(
    "unrelated TRAVEL stays running",
    (await prisma.timeEntry.findUnique({ where: { id: runningTravel.id } })).status === "RUNNING",
  );

  const retryTimed = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: timed.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("repeated owner completion reuses the invoice", retryTimed.ok && retryTimed.invoiceReused === true);
  check(
    "repeated owner completion does not double-adjust",
    (await prisma.timeEntryAdjustment.count({
      where: { timeEntryId: runningJobA.id, reason: JOB_COMPLETION_TIME_CLOSED_REASON },
    })) === 1,
  );
  check(
    "still exactly one invoice for the timed job",
    (await prisma.invoice.count({ where: { jobId: timed.job.id } })) === 1,
  );

  console.log("\nTEST — Approved week blocks owner completion before invoice");
  const approvedBlock = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 55,
    estimateLines: [{ description: "Approved-week block", quantity: 1, unitPrice: 55, total: 55 }],
  });
  await prisma.job.update({
    where: { id: approvedBlock.job.id },
    data: { assignedMembershipId: memberMem.id },
  });
  const approvedRunning = await clockInTime(prisma, memberA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: approvedBlock.job.id,
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      weekStartedAt: weekRange(approvedRunning.startedAt, "America/New_York").start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });
  const invoicesBeforeBlock = await prisma.invoice.count({ where: { jobId: approvedBlock.job.id } });
  const blockedApproved = await completeJobAndDraftInvoice(prisma, {
    businessId: businessA.id,
    jobId: approvedBlock.job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("approved week fails completion", blockedApproved.ok === false && blockedApproved.jobCompleted === false);
  check(
    "approved-week block leaves Job IN_PROGRESS",
    (await prisma.job.findUniqueOrThrow({ where: { id: approvedBlock.job.id } })).status === "IN_PROGRESS",
  );
  check(
    "approved-week block creates no invoice",
    (await prisma.invoice.count({ where: { jobId: approvedBlock.job.id } })) === invoicesBeforeBlock,
  );
  check(
    "approved-week block does not mutate the running entry",
    (await prisma.timeEntry.findUnique({ where: { id: approvedRunning.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: approvedRunning.id } })).endedAt == null,
  );

  console.log("\nTEST — Owner completion vs JOB clock-in race");
  const race = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 25,
    estimateLines: [{ description: "Race job", quantity: 1, unitPrice: 25, total: 25 }],
  });
  const raceUser = await prisma.user.create({
    data: { name: "Riley Race", email: "race-complete@example.com", passwordHash: "x" },
  });
  const raceMem = await prisma.membership.create({
    data: { userId: raceUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.job.update({
    where: { id: race.job.id },
    data: { assignedMembershipId: raceMem.id },
  });
  const raceAccess = makeAccess(businessA.id, "MEMBER", raceMem.id);
  await Promise.allSettled([
    clockInTime(prisma, raceAccess, {
      membershipId: raceMem.id,
      activityType: "JOB",
      jobId: race.job.id,
    }),
    completeJobAndDraftInvoice(prisma, {
      businessId: businessA.id,
      jobId: race.job.id,
      businessName: businessA.name,
      actorMembershipId: ownerMem.id,
    }),
  ]);
  const raceJob = await prisma.job.findUniqueOrThrow({ where: { id: race.job.id } });
  const raceRunning = await prisma.timeEntry.count({
    where: {
      businessId: businessA.id,
      jobId: race.job.id,
      activityType: "JOB",
      status: "RUNNING",
      endedAt: null,
    },
  });
  check(
    "owner completion vs clock-in never leaves COMPLETED + RUNNING JOB time",
    !(raceJob.status === "COMPLETED" && raceRunning > 0),
  );

  console.log(
    failures === 0
      ? "\nAll complete-job-invoice checks passed."
      : `\n${failures} complete-job-invoice check(s) failed.`,
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

process.exit(failures === 0 ? 0 : 1);
