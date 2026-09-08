/**
 * Material deposit payment workflow:
 * Estimate → Approval → Deposit → Job → Final Invoice.
 *
 * Uses a fake Stripe provider. Does not require live Stripe credentials.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-material-deposit-payments.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { createFakePaymentProvider } = await import("@/lib/payments/fake");
const { parseCheckoutPaymentEvent } = await import("@/lib/payments/events");
const {
  applyVerifiedCheckoutPayment,
  createCustomerDepositCheckout,
  createCustomerInvoiceCheckout,
  getBusinessPaymentStatus,
  PaymentError,
  shouldShowPayDeposit,
  startStripeConnectOnboarding,
} = await import("@/lib/payments/service");
const { completeJobAndSendInvoice } = await import("@/lib/complete-job-invoice");
const {
  invoiceDocumentPlainText,
  loadInvoiceDocumentForBusiness,
} = await import("@/lib/invoice-document");
const {
  MATERIAL_DEPOSIT_STATUS_LABELS,
  buildProjectPaymentSummary,
  invoicePaymentBreakdown,
  listPaymentsGroupedByInvoiceId,
  loadEstimatePaymentSummary,
  materialDepositStatus,
  paymentsBelongingToInvoice,
  recordOwnerManualDeposit,
  unpaidMaterialDepositWarning,
} = await import("@/lib/project-payments");
const { payDepositButtonLabel } = await import("@/lib/payments/money");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_material_deposit_payments_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://deposit.test";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for material-deposit payments test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

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

function checkoutEvent(input) {
  return {
    type: input.type ?? "checkout.session.completed",
    account: input.account,
    data: {
      object: {
        object: "checkout.session",
        id: input.sessionId ?? "cs_test_1",
        payment_status: input.paymentStatus ?? "paid",
        amount_total: input.amountCents,
        currency: input.currency ?? "usd",
        payment_intent: input.paymentIntent ?? "pi_test_1",
        metadata: {
          purpose: input.purpose ?? "material_deposit",
          invoiceId: input.invoiceId,
          estimateId: input.estimateId,
          businessId: input.businessId,
          ...(input.connectedAccountId
            ? { connectedAccountId: input.connectedAccountId }
            : {}),
        },
      },
    },
  };
}

async function seedBusiness(name) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}` },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${name} Customer` },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: "10 Deposit Ave",
    },
  });
  return { business, membership, customer, property, ownerUser };
}

async function seedEstimate(input) {
  const token = randomUUID();
  const estimate = await prisma.estimate.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: input.status ?? "APPROVED",
      total: new Prisma.Decimal(input.total),
      publicToken: token,
    },
  });
  const lines = input.lines ?? [
    {
      description: "Labor",
      type: "LABOR",
      quantity: "1",
      unitPrice: "350.00",
      total: "350.00",
    },
    {
      description: "Materials",
      type: "MATERIAL",
      quantity: "1",
      unitPrice: "200.00",
      total: "200.00",
    },
  ];
  for (const line of lines) {
    await prisma.lineItem.create({
      data: {
        businessId: input.businessId,
        estimateId: estimate.id,
        description: line.description,
        quantity: new Prisma.Decimal(line.quantity),
        unitPrice: new Prisma.Decimal(line.unitPrice),
        total: new Prisma.Decimal(line.total),
        type: line.type,
      },
    });
  }
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(input.total),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      customerName: "Founder Customer",
      approvedAt: input.status === "SENT" ? null : new Date(),
      lineItems: {
        create: lines.map((line) => ({
          businessId: input.businessId,
          description: line.description,
          quantity: new Prisma.Decimal(line.quantity),
          unitPrice: new Prisma.Decimal(line.unitPrice),
          total: new Prisma.Decimal(line.total),
          type: line.type,
        })),
      },
    },
  });
  if (input.status !== "SENT") {
    await prisma.estimate.update({
      where: { id: estimate.id },
      data: { approvedVersionId: version.id },
    });
  }
  return { estimate, version, token };
}

try {
  const createJobSrc = readFileSync(
    new URL("../src/app/actions/job.ts", import.meta.url),
    "utf8",
  );
  const startJobSrc = createJobSrc.slice(createJobSrc.indexOf("export async function startJob"));
  const approveSrc = readFileSync(
    new URL("../src/components/estimates/approve-estimate-button.tsx", import.meta.url),
    "utf8",
  );
  const depositRouteSrc = readFileSync(
    new URL("../src/app/e/[token]/pay/route.ts", import.meta.url),
    "utf8",
  );
  const ownerInvoiceSrc = readFileSync(
    new URL("../src/app/(app)/invoices/[invoiceId]/page.tsx", import.meta.url),
    "utf8",
  );
  const invoicesListSrc = readFileSync(
    new URL("../src/app/(app)/invoices/page.tsx", import.meta.url),
    "utf8",
  );
  const invoicesWorkspaceSrc = readFileSync(
    new URL("../src/components/invoices/invoices-workspace.tsx", import.meta.url),
    "utf8",
  );
  const unscheduledPanelSrc = readFileSync(
    new URL("../src/components/schedule/unscheduled-jobs-panel.tsx", import.meta.url),
    "utf8",
  );
  const jobsPageSrc = readFileSync(
    new URL("../src/app/(app)/jobs/page.tsx", import.meta.url),
    "utf8",
  );
  const estimatePageSrc = readFileSync(
    new URL("../src/app/(app)/estimates/[estimateId]/page.tsx", import.meta.url),
    "utf8",
  );
  const portalPageSrc = readFileSync(
    new URL("../src/app/p/[token]/page.tsx", import.meta.url),
    "utf8",
  );
  const portalDepositRouteSrc = readFileSync(
    new URL("../src/app/p/[token]/deposit/route.ts", import.meta.url),
    "utf8",
  );
  const approvedScopeSrc = readFileSync(
    new URL("../src/components/jobs/approved-scope-card.tsx", import.meta.url),
    "utf8",
  );

  console.log("\nSTATIC — Deposit workflow contracts");
  check(
    "createJobFromEstimate does not hard-block unpaid deposits",
    createJobSrc.includes("export async function createJobFromEstimate") &&
      !createJobSrc.slice(0, createJobSrc.indexOf("export async function scheduleJob")).includes("depositRemaining") &&
      !createJobSrc.slice(0, createJobSrc.indexOf("export async function scheduleJob")).includes("unpaidDeposit"),
  );
  check(
    "startJob does not hard-block unpaid deposits",
    startJobSrc.includes("export async function startJob") &&
      !startJobSrc.includes("depositRemaining"),
  );
  check(
    "customer pays deposit only after approval",
    approveSrc.includes("approveEstimate") &&
      approveSrc.includes("/pay") &&
      approveSrc.includes("state.status === \"APPROVED\""),
  );
  check(
    "deposit pay route uses createCustomerDepositCheckout",
    depositRouteSrc.includes("createCustomerDepositCheckout(prisma, token)"),
  );
  check(
    "owner invoice ops page derives payments and amount due from Payment rows",
    ownerInvoiceSrc.includes("listProjectPayments") &&
      ownerInvoiceSrc.includes("invoicePaymentBreakdown") &&
      !ownerInvoiceSrc.includes("isPaid ? formatMoney(invoice.total)") &&
      !ownerInvoiceSrc.includes("isPaid ? formatMoney(0) : formatMoney(invoice.total)"),
  );
  check(
    "owner invoices list remaining due uses Payment rows, not PAID vs full total",
    invoicesListSrc.includes("listPaymentsGroupedByInvoiceId") &&
      invoicesListSrc.includes("invoicePaymentBreakdown") &&
      !invoicesListSrc.includes('invoice.status === "PAID" ? formatMoney(0) : formatMoney(invoice.total)'),
  );
  check(
    "owner invoices workspace shows deposit credit and remaining balance",
    invoicesWorkspaceSrc.includes("depositPaidLabel") &&
      invoicesWorkspaceSrc.includes("paymentsLabel") &&
      invoicesWorkspaceSrc.includes("balanceSettled"),
  );
  check(
    "unscheduled jobs panel warns on schedule when the deposit is unpaid",
    unscheduledPanelSrc.includes("unpaidDepositWarning={job.unpaidDepositWarning}") &&
      jobsPageSrc.includes("unscheduledPanelJobs") &&
      jobsPageSrc.includes("depositPaidByEstimateIds"),
  );
  check(
    "approved estimate deposit snapshot prefers the approved version",
    estimatePageSrc.includes("estimate.approvedVersion?.lineItems ?? estimate.lineItems") &&
      estimatePageSrc.includes("estimate.approvedVersion?.total ?? estimate.total"),
  );
  check(
    "project portal reuses createCustomerDepositCheckout for job tokens",
    portalDepositRouteSrc.includes("createCustomerDepositCheckout(prisma, token)") &&
      portalPageSrc.includes("reconcileEstimateDepositCheckout") &&
      portalPageSrc.includes("PortalMaterialDepositCard") &&
      portalPageSrc.includes("shouldShowPayDeposit"),
  );
  check(
    "project portal hides MATERIAL unit prices and shows Description | Qty",
    portalPageSrc.includes("hideMaterialLinePricing") &&
      approvedScopeSrc.includes("hideMaterialLinePricing") &&
      approvedScopeSrc.includes("customer-materials-compact") &&
      approvedScopeSrc.includes("Description") &&
      approvedScopeSrc.includes("Qty"),
  );
  check(
    "Pay Remaining Deposit is the partial-payment CTA",
    payDepositButtonLabel("$200.00") === "Pay $200.00 Material Deposit" &&
      payDepositButtonLabel("$100.00", true) === "Pay Remaining Deposit",
  );
  check(
    "Pay Deposit is hidden once a customer invoice exists",
    shouldShowPayDeposit({
      requiredCents: 20000,
      remainingCents: 20000,
      paymentReady: true,
      hasCustomerInvoice: false,
    }) === true &&
      shouldShowPayDeposit({
        requiredCents: 20000,
        remainingCents: 20000,
        paymentReady: true,
        hasCustomerInvoice: true,
      }) === false &&
      shouldShowPayDeposit({
        requiredCents: 20000,
        remainingCents: 0,
        paymentReady: true,
        hasCustomerInvoice: false,
      }) === false,
  );
  check(
    "unpaid warning names the remaining deposit",
    unpaidMaterialDepositWarning("200") === "Material deposit of $200.00 is still due." &&
      unpaidMaterialDepositWarning("0") === null,
  );

  console.log("\nUNIT — Deposit status from payment records");
  const zero = new Prisma.Decimal(0);
  const twoHundred = new Prisma.Decimal("200");
  const hundred = new Prisma.Decimal("100");
  check("no required deposit is none", materialDepositStatus(zero, zero) === "none");
  check("$0 paid of $200 is due", materialDepositStatus(twoHundred, zero) === "due");
  check("$100 of $200 is partial", materialDepositStatus(twoHundred, hundred) === "partial");
  check("$200 of $200 is paid", materialDepositStatus(twoHundred, twoHundred) === "paid");
  check("$250 of $200 is paid", materialDepositStatus(twoHundred, new Prisma.Decimal("250")) === "paid");
  check(
    "status labels are owner-readable",
    MATERIAL_DEPOSIT_STATUS_LABELS.none === "No Deposit Required" &&
      MATERIAL_DEPOSIT_STATUS_LABELS.due === "Deposit Due" &&
      MATERIAL_DEPOSIT_STATUS_LABELS.partial === "Deposit Partially Paid" &&
      MATERIAL_DEPOSIT_STATUS_LABELS.paid === "Deposit Paid",
  );

  const founderSummary = buildProjectPaymentSummary({
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
    payments: [
      {
        id: "p1",
        purpose: "MATERIAL_DEPOSIT",
        amount: "200.00",
        method: "STRIPE",
        receivedAt: new Date(),
        note: null,
      },
    ],
  });
  check("founder deposit paid is $200", founderSummary.depositPaid.toString() === "200");
  check("founder deposit remaining is $0", founderSummary.depositRemaining.toString() === "0");
  check("founder remaining project balance is $350", founderSummary.remainingBalance.toString() === "350");
  check("founder deposit status is paid", founderSummary.depositStatus === "paid");

  const invoiceCredit = invoicePaymentBreakdown({
    status: "SENT",
    total: "550.00",
    payments: [{ purpose: "MATERIAL_DEPOSIT", amount: "200.00" }],
  });
  check("invoice total stays $550", invoiceCredit.total.toString() === "550");
  check("invoice deposit paid is $200", invoiceCredit.depositPaid.toString() === "200");
  check("invoice amount due is $350", invoiceCredit.amountDue.toString() === "350");
  check("deposit is a payment, not a discount", invoiceCredit.amountPaid.toString() === "200");

  const overpaidInvoice = invoicePaymentBreakdown({
    status: "SENT",
    total: "550.00",
    payments: [{ purpose: "MATERIAL_DEPOSIT", amount: "600.00" }],
  });
  check("overpayment does not show a negative amount due", overpaidInvoice.amountDue.toString() === "0");
  check("overpayment is a credit on the invoice", overpaidInvoice.credit.toString() === "50");

  const legacyPaid = invoicePaymentBreakdown({
    status: "PAID",
    total: "300.00",
    payments: [],
  });
  check("legacy PAID invoices without Payment rows stay fully paid", legacyPaid.legacyFullyPaid === true);
  check("legacy PAID amount due is $0", legacyPaid.amountDue.toString() === "0");

  const groupedRows = paymentsBelongingToInvoice(
    { id: "inv-1", jobId: "job-1" },
    [
      { id: "p-deposit", invoiceId: "inv-1", jobId: "job-1" },
      { id: "p-other-invoice", invoiceId: "inv-2", jobId: "job-1" },
      { id: "p-unattached", invoiceId: null, jobId: "job-1" },
      { id: "p-other-job", invoiceId: null, jobId: "job-2" },
    ],
  );
  check(
    "invoice payment grouping keeps this invoice's rows and unattached job payments",
    groupedRows.map((row) => row.id).join(",") === "p-deposit,p-unattached",
  );

  const businessA = await seedBusiness("Deposit A");
  const businessB = await seedBusiness("Deposit B");
  const accessA = makeAccess(businessA.business.id, "OWNER", businessA.membership.id);
  const accessB = makeAccess(businessB.business.id, "OWNER", businessB.membership.id);
  const provider = createFakePaymentProvider();

  await startStripeConnectOnboarding(
    prisma,
    accessA,
    { appUrl: "http://deposit.test" },
    provider,
  );
  const accountA = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: businessA.business.id },
  });
  provider.setChargesEnabled(accountA.stripeAccountId, true);
  check(
    "Business A Stripe Connect is payment-ready",
    (await getBusinessPaymentStatus(prisma, businessA.business.id, provider)).paymentReady === true,
  );

  console.log("\nTEST — Founder $550 / $200 Stripe deposit → job → invoice");
  const founder = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  const depositSession = await createCustomerDepositCheckout(prisma, founder.token, provider, {
    appUrl: "http://deposit.test",
  });
  check("approved estimate can start deposit checkout", Boolean(depositSession.url));
  check("Stripe deposit checkout charges $200, not $550", depositSession.amountCents === 20000);
  check(
    "deposit checkout uses Business A connected account",
    depositSession.connectedAccountId === accountA.stripeAccountId,
  );
  provider.completeCheckout(depositSession.id);
  const paid = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        estimateId: founder.estimate.id,
        businessId: businessA.business.id,
        amountCents: 20000,
        sessionId: depositSession.id,
        paymentIntent: "pi_deposit_founder",
      }),
    ),
  );
  check("deposit webhook applies", paid.applied === true);
  const afterPay = await prisma.estimate.findUnique({ where: { id: founder.estimate.id } });
  check("estimate remains APPROVED after payment", afterPay.status === "APPROVED");
  const founderPaidSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: founder.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("Deposit Required = $200", founderPaidSummary.requiredDeposit.toString() === "200");
  check("Deposit Paid = $200", founderPaidSummary.depositPaid.toString() === "200");
  check("Deposit Remaining = $0", founderPaidSummary.depositRemaining.toString() === "0");
  check("Remaining Project Balance = $350", founderPaidSummary.remainingBalance.toString() === "350");
  check("one Payment row is the source of truth", founderPaidSummary.payments.length === 1);

  const duplicate = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        estimateId: founder.estimate.id,
        businessId: businessA.business.id,
        amountCents: 20000,
        sessionId: depositSession.id,
        paymentIntent: "pi_deposit_founder",
      }),
    ),
  );
  check("duplicate deposit webhook is idempotent", duplicate.reason === "already_paid");
  const afterDup = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: founder.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("duplicate webhook does not create a second payment", afterDup.payments.length === 1);

  const job = await prisma.job.create({
    data: {
      businessId: businessA.business.id,
      customerId: businessA.customer.id,
      propertyId: businessA.property.id,
      estimateId: founder.estimate.id,
      approvedEstimateVersionId: founder.version.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const completed = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.business.id,
    jobId: job.id,
    businessName: businessA.business.name,
  });
  check("complete job created and sent the invoice", completed.ok === true && completed.invoiceId);
  const invoiceDoc = await loadInvoiceDocumentForBusiness(
    completed.invoiceId,
    businessA.business.id,
    prisma,
  );
  const invoiceText = invoiceDoc ? invoiceDocumentPlainText(invoiceDoc) : "";
  check("invoice total is $550.00", invoiceDoc?.totalLabel === "$550.00");
  check("invoice payments / deposit is $200.00", invoiceDoc?.amountPaidLabel === "$200.00");
  check("invoice deposit paid line is $200.00", invoiceDoc?.depositPaidLabel === "$200.00");
  check("invoice amount due is $350.00", invoiceDoc?.amountDueLabel === "$350.00");
  check(
    "invoice document still has a generic Payments line",
    invoiceText.includes("Payments") && invoiceText.includes("$200.00"),
  );
  check(
    "invoice keeps one materials lump sum, not unit prices",
    invoiceDoc?.materialTotalLabel === "$200.00" &&
      invoiceDoc?.materialLines.every((line) => line.showLinePricing === false),
  );
  const ownerInvoicePayments = await listPaymentsGroupedByInvoiceId(
    prisma,
    businessA.business.id,
    [{ id: completed.invoiceId, jobId: job.id }],
  );
  const ownerInvoiceBreakdown = invoicePaymentBreakdown({
    status: "SENT",
    total: "550.00",
    payments: ownerInvoicePayments.get(completed.invoiceId) ?? [],
  });
  check(
    "owner invoice ops remaining due after $200 deposit is $350",
    ownerInvoiceBreakdown.amountPaid.toString() === "200" &&
      ownerInvoiceBreakdown.amountDue.toString() === "350" &&
      ownerInvoiceBreakdown.depositPaid.toString() === "200",
  );

  const remainingCheckout = await createCustomerInvoiceCheckout(
    prisma,
    job.projectToken,
    provider,
    { appUrl: "http://deposit.test" },
  );
  check("final invoice Stripe charge is the $350 remaining balance", remainingCheckout.amountCents === 35000);

  console.log("\nTEST — Approval without finishing payment");
  const abandoned = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  const abandonedSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: abandoned.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("abandoned payment leaves estimate APPROVED", abandoned.estimate.status === "APPROVED");
  check("abandoned payment leaves deposit due", abandonedSummary.depositStatus === "due");
  check("abandoned payment paid is $0", abandonedSummary.depositPaid.toString() === "0");
  const laterSession = await createCustomerDepositCheckout(prisma, abandoned.token, provider, {
    appUrl: "http://deposit.test",
  });
  check("customer can return later and pay the $200 deposit", laterSession.amountCents === 20000);
  provider.completeCheckout(laterSession.id);
  const laterPaid = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        estimateId: abandoned.estimate.id,
        businessId: businessA.business.id,
        amountCents: 20000,
        sessionId: laterSession.id,
        paymentIntent: "pi_deposit_later",
      }),
    ),
  );
  check("later deposit payment applies", laterPaid.applied === true);

  console.log("\nTEST — Owner records cash / Zelle manually");
  const manual = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  const cash = await recordOwnerManualDeposit(prisma, accessA, {
    estimateId: manual.estimate.id,
    amount: "200.00",
    method: "CASH",
    receivedAt: "2026-09-08",
    note: "Received at shop",
  });
  check("manual cash deposit creates a Payment row", cash.created === true);
  const zelleEstimate = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  await recordOwnerManualDeposit(prisma, accessA, {
    estimateId: zelleEstimate.estimate.id,
    amount: "200.00",
    method: "ZELLE_BANK_TRANSFER",
    note: "Zelle from customer",
  });
  const zelleSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: zelleEstimate.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("Zelle deposit is paid", zelleSummary.depositStatus === "paid");
  check("Zelle method is stored on the payment", zelleSummary.payments[0]?.method === "ZELLE_BANK_TRANSFER");

  console.log("\nTEST — Partial deposit $100");
  const partial = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  await recordOwnerManualDeposit(prisma, accessA, {
    estimateId: partial.estimate.id,
    amount: "100.00",
    method: "CHECK",
    note: "Check 1044",
  });
  const partialSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: partial.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("partial required is $200", partialSummary.requiredDeposit.toString() === "200");
  check("partial paid is $100", partialSummary.depositPaid.toString() === "100");
  check("partial remaining is $100", partialSummary.depositRemaining.toString() === "100");
  check("partial remaining project balance is $450", partialSummary.remainingBalance.toString() === "450");
  check("partial status is Deposit Partially Paid", partialSummary.depositStatus === "partial");
  const partialCheckout = await createCustomerDepositCheckout(prisma, partial.token, provider, {
    appUrl: "http://deposit.test",
  });
  check("partial Stripe checkout charges only the remaining $100", partialCheckout.amountCents === 10000);

  console.log("\nTEST — No deposit estimate");
  const none = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "350.00",
    lines: [
      {
        description: "Labor only",
        type: "LABOR",
        quantity: "1",
        unitPrice: "350.00",
        total: "350.00",
      },
    ],
  });
  const noneSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: none.estimate.id,
    estimateTotal: "350.00",
    requiredDeposit: "0",
  });
  check("no-deposit status is none", noneSummary.depositStatus === "none");
  check("no-deposit remaining warning is hidden", unpaidMaterialDepositWarning(noneSummary.depositRemaining) === null);
  try {
    await createCustomerDepositCheckout(prisma, none.token, provider, {
      appUrl: "http://deposit.test",
    });
    check("no-deposit estimate cannot open Pay Deposit checkout", false);
  } catch (error) {
    check(
      "no-deposit estimate cannot open Pay Deposit checkout",
      error instanceof PaymentError,
    );
  }

  console.log("\nTEST — Tenant isolation");
  await startStripeConnectOnboarding(
    prisma,
    accessB,
    { appUrl: "http://deposit.test" },
    provider,
  );
  const accountB = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: businessB.business.id },
  });
  provider.setChargesEnabled(accountB.stripeAccountId, true);
  const cross = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountB.stripeAccountId,
        estimateId: founder.estimate.id,
        businessId: businessB.business.id,
        amountCents: 20000,
        sessionId: "cs_cross_tenant",
        paymentIntent: "pi_cross_tenant",
      }),
    ),
  );
  check("Business B cannot apply a deposit to Business A", cross.reason === "business_mismatch");
  const bSeesA = await loadEstimatePaymentSummary(prisma, {
    businessId: businessB.business.id,
    estimateId: founder.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("Business B payment query does not see Business A rows", bSeesA.payments.length === 0);
  try {
    await recordOwnerManualDeposit(prisma, accessB, {
      estimateId: founder.estimate.id,
      amount: "200.00",
      method: "CASH",
    });
    check("Business B cannot record a deposit on Business A", false);
  } catch {
    check("Business B cannot record a deposit on Business A", true);
  }

  console.log("\nTEST — Deposit checkout is blocked before approval");
  const sentOnly = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
    status: "SENT",
  });
  try {
    await createCustomerDepositCheckout(prisma, sentOnly.token, provider, {
      appUrl: "http://deposit.test",
    });
    check("unapproved estimate cannot be charged a deposit", false);
  } catch (error) {
  check(
    "unapproved estimate cannot be charged a deposit",
    error instanceof PaymentError,
    );
  }

  console.log("\nTEST — Project portal token reuses the same deposit checkout");
  const portalEst = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  const portalJob = await prisma.job.create({
    data: {
      businessId: businessA.business.id,
      customerId: businessA.customer.id,
      propertyId: businessA.property.id,
      estimateId: portalEst.estimate.id,
      approvedEstimateVersionId: portalEst.version.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const portalSession = await createCustomerDepositCheckout(
    prisma,
    portalJob.projectToken,
    provider,
    { appUrl: "http://deposit.test" },
  );
  check("project portal token can start the same $200 deposit checkout", portalSession.amountCents === 20000);
  check(
    "project portal deposit checkout stays on Business A connected account",
    portalSession.connectedAccountId === accountA.stripeAccountId,
  );
  try {
    await createCustomerDepositCheckout(prisma, randomUUID(), provider, {
      appUrl: "http://deposit.test",
    });
    check("unknown project token cannot open deposit checkout", false);
  } catch (error) {
    check(
      "unknown project token cannot open deposit checkout",
      error instanceof PaymentError,
    );
  }

  console.log("\nTEST — Deposit overage stays on the project");
  const over = await seedEstimate({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "550.00",
  });
  await recordOwnerManualDeposit(prisma, accessA, {
    estimateId: over.estimate.id,
    amount: "250.00",
    method: "CASH",
  });
  const overSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: businessA.business.id,
    estimateId: over.estimate.id,
    estimateTotal: "550.00",
    requiredDeposit: "200.00",
  });
  check("overage is not lost", overSummary.totalPaid.toString() === "250");
  check("overage reduces remaining project balance to $300", overSummary.remainingBalance.toString() === "300");
  check("required-deposit overage is $50", overSummary.depositOverage.toString() === "50");
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    // ignore
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } catch {
    // ignore
  }
  await cleanup.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll material-deposit payment checks passed."
    : `\n${failures} material-deposit payment check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
