/**
 * Bounce/complaint suppression at sendTransactionalEmail, the single
 * outbound-email chokepoint. Fake provider and disposable DB only.
 *
 * Run with:
 *   npm run test:email-outbound-suppression
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MUTATION_CHILD = process.env.EMAIL_SUPPRESSION_MUTATION_CHILD === "1";

const previous = {
  DATABASE_URL: process.env.DATABASE_URL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  TBBT_EMAIL_ADAPTER: process.env.TBBT_EMAIL_ADAPTER,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function walkSrc(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkSrc(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const OUTBOUND_CALL_SITES = [
  { file: "src/lib/communications/engine.ts", path: "compose" },
  { file: "src/app/actions/estimate.ts", path: "estimate" },
  { file: "src/lib/complete-job-invoice.ts", path: "invoice" },
  { file: "src/lib/reviews-ops.ts", path: "review request" },
  { file: "src/lib/appointment-notify.ts", path: "appointment" },
  { file: "src/lib/referral-ops.ts", path: "referral/follow-up" },
  { file: "src/lib/automation/email.ts", path: "automation/follow-up" },
  { file: "src/app/actions/team.ts", path: "team invite" },
  { file: "src/lib/password-reset.ts", path: "password reset" },
  { file: "src/lib/request-notify.ts", path: "new-request company notify" },
];

const PROVIDER_DIRECT = /new\s+Resend\b|resend\.emails|api\.resend\.com/;

function runStaticCallSiteChecks() {
  console.log("\nSTATIC — every outbound email path uses the chokepoint");
  const srcRoot = join(root, "src");
  const files = walkSrc(srcRoot);
  let stray = [];
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel === "src/lib/mail.ts") continue;
    const src = readFileSync(file, "utf8");
    if (PROVIDER_DIRECT.test(src)) stray.push(rel);
  }
  check(
    "No direct Resend/provider send outside sendTransactionalEmail",
    stray.length === 0,
  );
  if (stray.length) console.error("  stray provider sites:", stray.join(", "));

  for (const site of OUTBOUND_CALL_SITES) {
    const src = readFileSync(join(root, site.file), "utf8");
    check(
      `${site.path} calls sendTransactionalEmail with businessId`,
      src.includes("sendTransactionalEmail") && src.includes("businessId:"),
    );
  }

  const mailSrc = readFileSync(join(root, "src/lib/mail.ts"), "utf8");
  check(
    "Chokepoint checks suppression immediately before the provider",
    mailSrc.includes("blockedOutboundEmailReason") &&
      mailSrc.indexOf("blockedOutboundEmailReason") < mailSrc.indexOf("injectedEmailSender") &&
      mailSrc.indexOf("blockedOutboundEmailReason") < mailSrc.indexOf("new Resend"),
  );
}

if (!MUTATION_CHILD) {
  runStaticCallSiteChecks();
}

if (!previous.DATABASE_URL) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

delete process.env.VERCEL_ENV;
process.env.TBBT_EMAIL_ADAPTER = "fake";
process.env.RESEND_API_KEY = "re_test_outbound_suppression";
process.env.EMAIL_FROM = "TBBT <suppress@example.com>";
process.env.NEXT_PUBLIC_APP_URL = "http://outbound-suppression.test";

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId },
      business: { id: businessId, name: "Suppress Co" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

await withDisposableTestDatabase(
  {
    databaseUrl: previous.DATABASE_URL,
    namePrefix: "tbbt_email_outbound_suppression",
    setProcessEnv: true,
  },
  async ({ prisma }) => {
    const { emailDestinationFingerprint } = await import("@/lib/communications");
    const {
      composeCustomerCommunication,
      communicationEmailDispatchTestHooks,
      resetCommunicationEmailSender,
    } = await import("@/lib/communications");
    const {
      getFakeTransactionalEmailSender,
      resetTransactionalEmailSender,
      sendTransactionalEmail,
    } = await import("@/lib/mail");
    const { EMAIL_COMPLAINT_BLOCK_REASON } = await import("@/lib/mail-failed-destination");
    const {
      outboundEmailSuppressionTestHooks,
      resetOutboundEmailSuppressionTestHooks,
    } = await import("@/lib/mail-outbound-suppression");
    const { notifyCustomerAppointmentProposed } = await import("@/lib/appointment-notify");
    const { sendDraftInvoiceIfNeeded } = await import("@/lib/complete-job-invoice");
    const { sendReviewRequest } = await import("@/lib/reviews-ops");
    const { sendReferralRequest, sendCustomerFollowUp } = await import("@/lib/referral-ops");
    const { attemptAutomationEmail } = await import("@/lib/automation/email");
    const { requestPasswordResetOp } = await import("@/lib/password-reset");
    const { notifyBusinessNewPublicRequest } = await import("@/lib/request-notify");
    const { buildEstimateReadyEmail } = await import("@/lib/estimate-mail");
    const { estimateEmailIdempotencyKey, isMailSendAttemptId } = await import("@/lib/mail");
    const { createFakeCustomerMessagingProvider, setCustomerMessagingProvider } = await import(
      "@/lib/customer-messaging"
    );

    setCustomerMessagingProvider(createFakeCustomerMessagingProvider());
    resetTransactionalEmailSender();
    const fake = getFakeTransactionalEmailSender();

    async function seedBusiness(name) {
      const ownerUser = await prisma.user.create({
        data: {
          name: `${name} Owner`,
          email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
          passwordHash: "x",
        },
      });
      const business = await prisma.business.create({
        data: {
          name,
          slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
          publicEmail: null,
        },
      });
      const membership = await prisma.membership.create({
        data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
      });
      return {
        business,
        membership,
        ownerUser,
        access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id),
      };
    }

    async function recordFailedDest(businessId, email, reason = "COMPLAINT") {
      return prisma.emailFailedDestination.create({
        data: {
          businessId,
          destinationFingerprint: emailDestinationFingerprint(businessId, email),
          destinationLast4: email.split("@")[0].slice(-4),
          reason,
          provider: "resend",
          providerEventId: `evt_${randomUUID()}`,
          providerMessageId: `re_${randomUUID()}`,
        },
      });
    }

    const tenantA = await seedBusiness("Alpha Suppress");
    const tenantB = await seedBusiness("Beta Suppress");

    async function customer(tenant, email, name) {
      return prisma.customer.create({
        data: { businessId: tenant.business.id, name, email },
      });
    }

    async function property(tenant, cust) {
      return prisma.property.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          addressLine1: "1 Main",
          city: "Austin",
          region: "TX",
          postalCode: "78701",
        },
      });
    }

    async function jobFor(tenant, cust, prop, extras = {}) {
      return prisma.job.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          propertyId: prop.id,
          projectToken: randomUUID(),
          status: extras.status ?? "COMPLETED",
          scheduledAt: extras.scheduledAt ?? new Date(),
          scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
          appointmentProposalId: extras.appointmentProposalId ?? 1,
        },
      });
    }

    const sentBefore = () => fake.sent.length;

    async function runCompose(tenant, cust, { insertAtSend } = {}) {
      communicationEmailDispatchTestHooks.beforeProviderSend = insertAtSend
        ? async ({ db }) => {
            await db.emailFailedDestination.create({
              data: {
                businessId: tenant.business.id,
                destinationFingerprint: emailDestinationFingerprint(
                  tenant.business.id,
                  cust.email,
                ),
                destinationLast4: cust.email.split("@")[0].slice(-4),
                reason: "COMPLAINT",
                provider: "resend",
                providerEventId: `evt_live_${randomUUID()}`,
                providerMessageId: `re_live_${randomUUID()}`,
              },
            });
          }
        : undefined;
      try {
        return await composeCustomerCommunication(prisma, tenant.access, {
          customerId: cust.id,
          channel: "EMAIL",
          purpose: "GENERAL",
          subject: "Compose path",
          body: "Compose body",
          idempotencyKey: `compose-${randomUUID()}`,
        });
      } finally {
        communicationEmailDispatchTestHooks.beforeProviderSend = undefined;
      }
    }

    async function runEstimate(tenant, cust) {
      const attempt = randomUUID();
      if (!isMailSendAttemptId(attempt)) throw new Error("expected uuid attempt");
      const email = buildEstimateReadyEmail({
        businessName: tenant.business.name,
        customerName: cust.name,
        total: "100",
        address: null,
        approveUrl: "http://outbound-suppression.test/e/token",
      });
      return sendTransactionalEmail({
        apiKey: "re_test_outbound_suppression",
        from: "Suppress Co <suppress@example.com>",
        to: cust.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        kind: "estimate",
        idempotencyKey: estimateEmailIdempotencyKey(`est_${randomUUID()}`, attempt),
        businessId: tenant.business.id,
        db: prisma,
      });
    }

    async function runInvoice(tenant, cust) {
      const prop = await property(tenant, cust);
      const createdJob = await jobFor(tenant, cust, prop);
      const invoice = await prisma.invoice.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          jobId: createdJob.id,
          status: "DRAFT",
          total: 50,
        },
      });
      return sendDraftInvoiceIfNeeded(prisma, {
        businessId: tenant.business.id,
        invoiceId: invoice.id,
        businessName: tenant.business.name,
      });
    }

    async function runReview(tenant, cust) {
      const request = await prisma.reviewRequest.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          status: "READY",
          requestText: "Please leave an honest review.",
          createdByMembershipId: tenant.membership.id,
        },
      });
      return sendReviewRequest(prisma, tenant.access, { requestId: request.id });
    }

    async function runAppointment(tenant, cust) {
      const prop = await property(tenant, cust);
      const createdJob = await jobFor(tenant, cust, prop, {
        status: "SCHEDULED",
        scheduledAt: new Date("2026-10-10T15:00:00.000Z"),
        appointmentProposalId: 1,
      });
      return notifyCustomerAppointmentProposed(prisma, {
        businessId: tenant.business.id,
        jobId: createdJob.id,
        businessName: tenant.business.name,
        proposalId: 1,
        scheduledAt: createdJob.scheduledAt,
        scheduledDurationMinutes: 60,
        rescheduled: false,
        sendAttemptId: "auto",
        actorMembershipId: tenant.membership.id,
      });
    }

    async function runReferral(tenant, cust) {
      const request = await prisma.referralRequest.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          status: "READY",
          requestText: "If you know someone, send them our way.",
          createdByMembershipId: tenant.membership.id,
        },
      });
      return sendReferralRequest(prisma, tenant.access, { requestId: request.id });
    }

    async function runFollowUp(tenant, cust) {
      const row = await prisma.customerFollowUp.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          kind: "JOB_COMPLETE",
          status: "OPEN",
          origin: "COMMUNICATION",
          notes: "Checking in after the job.",
          createdByMembershipId: tenant.membership.id,
        },
      });
      return sendCustomerFollowUp(prisma, tenant.access, { followUpId: row.id });
    }

    async function runAutomation(tenant, cust) {
      const estimate = await prisma.estimate.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          status: "SENT",
          publicToken: randomUUID(),
          total: 75,
        },
      });
      return attemptAutomationEmail(prisma, {
        businessId: tenant.business.id,
        runId: randomUUID(),
        purpose: "ESTIMATE_READY",
        subjectType: "ESTIMATE",
        subjectId: estimate.id,
        customerId: cust.id,
        businessName: tenant.business.name,
        payload: {},
      });
    }

    async function runTeam(tenant, email) {
      return sendTransactionalEmail({
        apiKey: "re_test_outbound_suppression",
        from: "Suppress Co <suppress@example.com>",
        to: email,
        subject: "Team invite",
        html: "<p>Set your password.</p>",
        text: "Set your password.",
        kind: "team",
        idempotencyKey: `team-invite/${tenant.business.id}/${email}`,
        businessId: tenant.business.id,
        db: prisma,
      });
    }

    async function runPasswordReset(tenant, email) {
      const user =
        (await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })) ??
        (await prisma.user.create({
          data: { name: "Reset User", email: email.trim().toLowerCase(), passwordHash: "x" },
        }));
      const existing = await prisma.membership.findFirst({
        where: { userId: user.id, businessId: tenant.business.id },
      });
      if (!existing) {
        await prisma.membership.create({
          data: { userId: user.id, businessId: tenant.business.id, role: "MEMBER" },
        });
      }
      await prisma.membership.updateMany({
        where: { userId: user.id, businessId: { not: tenant.business.id } },
        data: { active: false },
      });
      return requestPasswordResetOp(prisma, email);
    }

    async function runCompanyNotify(tenant, email) {
      await prisma.business.update({
        where: { id: tenant.business.id },
        data: { publicEmail: email },
      });
      const request = await prisma.serviceRequest.create({
        data: {
          businessId: tenant.business.id,
          summary: "New public request",
        },
      });
      return notifyBusinessNewPublicRequest(prisma, {
        businessId: tenant.business.id,
        requestId: request.id,
      });
    }

    const paths = [
      {
        name: "compose",
        async suppressed(tenant, email) {
          const cust = await customer(tenant, email, "Compose Suppressed");
          return runCompose(tenant, cust, { insertAtSend: true });
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Compose Allowed");
          return runCompose(tenant, cust);
        },
      },
      {
        name: "estimate",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Estimate Suppressed");
          return runEstimate(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Estimate Allowed");
          return runEstimate(tenant, cust);
        },
      },
      {
        name: "invoice",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Invoice Suppressed");
          return runInvoice(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Invoice Allowed");
          return runInvoice(tenant, cust);
        },
      },
      {
        name: "review request",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Review Suppressed");
          return runReview(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Review Allowed");
          return runReview(tenant, cust);
        },
      },
      {
        name: "appointment",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Appt Suppressed");
          return runAppointment(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Appt Allowed");
          return runAppointment(tenant, cust);
        },
      },
      {
        name: "referral",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Referral Suppressed");
          return runReferral(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Referral Allowed");
          return runReferral(tenant, cust);
        },
      },
      {
        name: "follow-up",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Followup Suppressed");
          return runFollowUp(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Followup Allowed");
          return runFollowUp(tenant, cust);
        },
      },
      {
        name: "automation/follow-up",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Auto Suppressed");
          return runAutomation(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Auto Allowed");
          return runAutomation(tenant, cust);
        },
      },
      {
        name: "team invite",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          return runTeam(tenant, email);
        },
        async allowed(tenant, email) {
          return runTeam(tenant, email);
        },
      },
      {
        name: "password reset",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          return runPasswordReset(tenant, email);
        },
        async allowed(tenant, email) {
          return runPasswordReset(tenant, email);
        },
      },
      {
        name: "new-request company notify",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          return runCompanyNotify(tenant, email);
        },
        async allowed(tenant, email) {
          return runCompanyNotify(tenant, email);
        },
      },
    ];

    console.log("\nTEST — each outbound path honors suppression at send time");
    for (const path of paths) {
      const suppressedEmail = `blocked.${path.name.replace(/\W+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`;
      const otherEmail = `clean.${path.name.replace(/\W+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`;
      const beforeBlocked = sentBefore();
      await path.suppressed(tenantA, suppressedEmail);
      check(
        `${path.name}: suppressed address makes zero provider calls`,
        fake.sent.length === beforeBlocked,
      );

      const beforeOther = sentBefore();
      await path.allowed(tenantB, suppressedEmail);
      check(
        `${path.name}: same address in another business still sends`,
        fake.sent.length === beforeOther + 1 &&
          fake.sent[fake.sent.length - 1].to.toLowerCase() === suppressedEmail.toLowerCase() &&
          fake.sent[fake.sent.length - 1].businessId === tenantB.business.id,
      );

      const beforeClean = sentBefore();
      await path.allowed(tenantA, otherEmail);
      check(
        `${path.name}: non-suppressed address still sends`,
        fake.sent.length === beforeClean + 1 &&
          fake.sent[fake.sent.length - 1].to.toLowerCase() === otherEmail.toLowerCase(),
      );
    }

    console.log("\nTEST — fingerprint normalization and fail-closed lookup");
    const canon = `canon.${randomUUID().slice(0, 8)}@example.com`;
    await recordFailedDest(tenantA.business.id, canon);
    const beforeNorm = sentBefore();
    await sendTransactionalEmail({
      apiKey: "re_test_outbound_suppression",
      from: "Suppress Co <suppress@example.com>",
      to: `  ${canon.split("@")[0].toUpperCase()}@${canon.split("@")[1].toUpperCase()}  `,
      subject: "Normalized",
      html: "<p>n</p>",
      text: "n",
      kind: "customer",
      idempotencyKey: `norm-${randomUUID()}`,
      businessId: tenantA.business.id,
      db: prisma,
    });
    check(
      "Case/whitespace matches the fingerprint and does not send",
      fake.sent.length === beforeNorm,
    );

    const plus = `${canon.split("@")[0]}+tag@${canon.split("@")[1]}`;
    const beforePlus = sentBefore();
    await sendTransactionalEmail({
      apiKey: "re_test_outbound_suppression",
      from: "Suppress Co <suppress@example.com>",
      to: plus,
      subject: "Plus",
      html: "<p>p</p>",
      text: "p",
      kind: "customer",
      idempotencyKey: `plus-${randomUUID()}`,
      businessId: tenantA.business.id,
      db: prisma,
    });
    check(
      "Plus-address stays distinct because the fingerprint does not strip +tags",
      fake.sent.length === beforePlus + 1 && fake.sent[fake.sent.length - 1].to === plus,
    );

    const complaintEmail = `lookup.${randomUUID().slice(0, 8)}@example.com`;
    await recordFailedDest(tenantA.business.id, complaintEmail, "COMPLAINT");
    outboundEmailSuppressionTestHooks.failLookup = true;
    const beforeFail = sentBefore();
    const failedLookup = await sendTransactionalEmail({
      apiKey: "re_test_outbound_suppression",
      from: "Suppress Co <suppress@example.com>",
      to: complaintEmail,
      subject: "Lookup fail",
      html: "<p>x</p>",
      text: "x",
      kind: "customer",
      idempotencyKey: `lookup-${randomUUID()}`,
      businessId: tenantA.business.id,
      db: prisma,
    });
    resetOutboundEmailSuppressionTestHooks();
    check(
      "DB lookup error does not send to a known complaint address",
      fake.sent.length === beforeFail &&
        failedLookup.error ===
          "This email could not be sent because destination eligibility could not be confirmed.",
    );
    check(
      "Suppression errors do not include the destination address",
      !String(failedLookup.error).includes(complaintEmail) &&
        !EMAIL_COMPLAINT_BLOCK_REASON.includes("@"),
    );

    resetCommunicationEmailSender();
  },
).finally(restoreEnv);

if (!MUTATION_CHILD) {
  console.log("\nMUTATION — removing the chokepoint check fails every path test");
  const mailPath = join(root, "src/lib/mail.ts");
  const original = readFileSync(mailPath, "utf8");
  const guard =
    "  const blocked = await blockedOutboundEmailReason(db, input.businessId, input.to);\n  if (blocked) {\n    return { error: blocked };\n  }\n\n";
  check("Chokepoint guard is present for mutation", original.includes(guard));
  if (original.includes(guard)) {
    writeFileSync(mailPath, original.replace(guard, ""));
    try {
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, EMAIL_SUPPRESSION_MUTATION_CHILD: "1" },
          encoding: "utf8",
          timeout: 180_000,
        },
      );
      const output = `${child.stdout || ""}\n${child.stderr || ""}`;
      const pathNames = [
        "compose",
        "estimate",
        "invoice",
        "review request",
        "appointment",
        "referral",
        "follow-up",
        "automation/follow-up",
        "team invite",
        "password reset",
        "new-request company notify",
      ];
      const failedEveryPath = pathNames.every((name) =>
        output.includes(`FAIL - ${name}: suppressed address makes zero provider calls`),
      );
      check(
        "Removing the chokepoint check fails every path test",
        child.status !== 0 && failedEveryPath,
      );
      if (child.status === 0 || !failedEveryPath) {
        console.error(output.slice(-4000));
      }
    } finally {
      writeFileSync(mailPath, original);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nOutbound email suppression checks passed.");
