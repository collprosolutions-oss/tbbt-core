/**
 * Bounce/complaint suppression at sendTransactionalEmail, the single
 * outbound-email chokepoint. Customer-facing purposes are suppressed;
 * system-exempt purposes are not. Fake provider and disposable DB only.
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

function extractSendCalls(src) {
  const calls = [];
  let idx = 0;
  const needle = "sendTransactionalEmail(";
  while (idx < src.length) {
    const start = src.indexOf(needle, idx);
    if (start < 0) break;
    let i = start + needle.length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    calls.push(src.slice(start, i));
    idx = i;
  }
  return calls;
}

const CUSTOMER_CALL_SITES = [
  { file: "src/lib/communications/engine.ts", path: "compose", purpose: "customer" },
  { file: "src/app/actions/estimate.ts", path: "estimate", purpose: "customer" },
  { file: "src/lib/complete-job-invoice.ts", path: "invoice", purpose: "customer" },
  { file: "src/lib/reviews-ops.ts", path: "review request/reminder", purpose: "customer" },
  { file: "src/lib/appointment-notify.ts", path: "appointment", purpose: "customer" },
  { file: "src/lib/referral-ops.ts", path: "referral/follow-up", purpose: "customer" },
  { file: "src/lib/automation/email.ts", path: "automation", purpose: "automation" },
];

const EXEMPT_CALL_SITES = [
  { file: "src/app/actions/team.ts", path: "team invite", purpose: "system-exempt-team" },
  { file: "src/lib/password-reset.ts", path: "password reset", purpose: "system-exempt-password-reset" },
  { file: "src/lib/request-notify.ts", path: "new-request company notify", purpose: "system-exempt-request-notify" },
];

const PROVIDER_DIRECT = /new\s+Resend\b|resend\.emails|api\.resend\.com/;
const CUSTOMER_PURPOSES = new Set(["customer", "automation"]);

function runStaticCallSiteChecks() {
  console.log("\nSTATIC — chokepoint inventory, no bypass, customer businessId");
  const srcRoot = join(root, "src");
  const files = walkSrc(srcRoot);
  const stray = [];
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

  const mailSrc = readFileSync(join(root, "src/lib/mail.ts"), "utf8");
  check(
    "Call-site inventory lists customer vs system-exempt callers",
    CUSTOMER_CALL_SITES.every((site) => mailSrc.includes(site.file)) &&
      EXEMPT_CALL_SITES.every((site) => mailSrc.includes(site.file)) &&
      mailSrc.includes("system-exempt-team") &&
      mailSrc.includes("system-exempt-password-reset") &&
      mailSrc.includes("system-exempt-request-notify"),
  );
  check(
    "Chokepoint checks customer purposes immediately before the provider",
    mailSrc.includes("isCustomerEmailPurpose(input.purpose)") &&
      mailSrc.includes("blockedOutboundEmailReason") &&
      mailSrc.indexOf("blockedOutboundEmailReason") < mailSrc.indexOf("injectedEmailSender") &&
      mailSrc.indexOf("blockedOutboundEmailReason") < mailSrc.indexOf("new Resend"),
  );

  for (const site of CUSTOMER_CALL_SITES) {
    const src = readFileSync(join(root, site.file), "utf8");
    const calls = extractSendCalls(src);
    const customerCalls = calls.filter(
      (call) =>
        call.includes(`purpose: "${site.purpose}"`) || call.includes(`purpose: '${site.purpose}'`),
    );
    check(
      `${site.path} uses purpose ${site.purpose} and businessId`,
      customerCalls.length > 0 &&
        customerCalls.every((call) => /businessId\s*:/.test(call)),
    );
    const omitted = calls.filter((call) => {
      const purpose = call.match(/purpose:\s*["']([^"']+)["']/);
      return purpose && CUSTOMER_PURPOSES.has(purpose[1]) && !/businessId\s*:/.test(call);
    });
    check(`${site.path} has no customer-purpose call omitting businessId`, omitted.length === 0);
  }

  for (const site of EXEMPT_CALL_SITES) {
    const src = readFileSync(join(root, site.file), "utf8");
    const calls = extractSendCalls(src);
    check(
      `${site.path} is marked ${site.purpose}`,
      src.includes(`purpose: "${site.purpose}"`) ||
        calls.some((call) => call.includes(`purpose: "${site.purpose}"`)),
    );
    check(
      `${site.path} is not a customer purpose`,
      !calls.some((call) => {
        const purpose = call.match(/purpose:\s*["']([^"']+)["']/);
        return purpose && CUSTOMER_PURPOSES.has(purpose[1]);
      }),
    );
  }
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

function oddStoredDest(email) {
  const trimmed = email.trim();
  const [local, domain] = trimmed.split("@");
  return `  ${local[0].toUpperCase()}${local.slice(1).toLowerCase()}@${domain[0].toUpperCase()}${domain.slice(1).toLowerCase()} `;
}

function isSuppressedOutcome(value) {
  if (!value || typeof value !== "object") return false;
  if (value.suppressed === true) return true;
  if (value.status === "SUPPRESSED" || value.status === "BLOCKED") return true;
  if (value.lastEmailStatus === "SUPPRESSED") return true;
  const text = `${value.failureReason ?? ""} ${value.warning ?? ""} ${value.error ?? ""} ${value.message ?? ""}`;
  return /Not sent: this address reported a (complaint|bounce)/.test(text);
}

function itemMarkedSent(value, pathName) {
  if (!value || typeof value !== "object") return false;
  if (pathName === "invoice") return value.customerNotified === true;
  if (pathName === "appointment") return value.sent === true;
  if (pathName === "compose") return value.status === "SENT" || value.ok === true;
  if (pathName.startsWith("automation")) return value.status === "SENT";
  if (pathName === "estimate") return Boolean(value.id) && !value.suppressed && !value.error;
  if (pathName === "review reminder") return value.lastEmailStatus === "SENT";
  return value.status === "SENT";
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
    const { EMAIL_OUTBOUND_SUPPRESSED_COMPLAINT } = await import(
      "@/lib/mail-outbound-suppression"
    );
    const {
      outboundEmailSuppressionTestHooks,
      resetOutboundEmailSuppressionTestHooks,
    } = await import("@/lib/mail-outbound-suppression");
    const { notifyCustomerAppointmentProposed } = await import("@/lib/appointment-notify");
    const { sendDraftInvoiceIfNeeded } = await import("@/lib/complete-job-invoice");
    const { sendReviewRequest, sendReviewRequestReminder } = await import("@/lib/reviews-ops");
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
      const stored = oddStoredDest(email);
      return prisma.emailFailedDestination.create({
        data: {
          businessId,
          destinationFingerprint: emailDestinationFingerprint(businessId, stored),
          destinationLast4: stored.trim().split("@")[0].slice(-4),
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
                  oddStoredDest(cust.email),
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
        purpose: "customer",
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

    async function runReviewReminder(tenant, cust) {
      const request = await prisma.reviewRequest.create({
        data: {
          businessId: tenant.business.id,
          customerId: cust.id,
          status: "SENT",
          requestedAt: new Date(),
          requestText: "Please leave an honest review.",
          createdByMembershipId: tenant.membership.id,
          lastEmailStatus: "SENT",
        },
      });
      return sendReviewRequestReminder(prisma, tenant.access, { requestId: request.id });
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

    async function runAutomation(tenant, cust, purpose) {
      const payload = {};
      let subjectType = "ESTIMATE";
      let subjectId;

      if (purpose === "ESTIMATE_READY" || purpose === "ESTIMATE_FOLLOW_UP") {
        const estimate = await prisma.estimate.create({
          data: {
            businessId: tenant.business.id,
            customerId: cust.id,
            status: "SENT",
            publicToken: randomUUID(),
            total: 75,
          },
        });
        subjectType = "ESTIMATE";
        subjectId = estimate.id;
      } else if (purpose === "INVOICE_READY" || purpose === "PAYMENT_REMINDER") {
        const prop = await property(tenant, cust);
        const createdJob = await jobFor(tenant, cust, prop);
        const invoice = await prisma.invoice.create({
          data: {
            businessId: tenant.business.id,
            customerId: cust.id,
            jobId: createdJob.id,
            status: "SENT",
            total: 50,
          },
        });
        subjectType = "INVOICE";
        subjectId = invoice.id;
      } else if (
        purpose === "APPOINTMENT_CONFIRMATION" ||
        purpose === "SCHEDULE_CHANGE" ||
        purpose === "APPOINTMENT_REMINDER"
      ) {
        const scheduledAt = new Date("2026-10-10T15:00:00.000Z");
        const prop = await property(tenant, cust);
        const createdJob = await jobFor(tenant, cust, prop, {
          status: "SCHEDULED",
          scheduledAt,
          appointmentProposalId: 1,
        });
        subjectType = "JOB";
        subjectId = createdJob.id;
        payload.proposalId = 1;
        payload.scheduledAt = scheduledAt.toISOString();
      } else if (purpose === "REVIEW_REQUEST") {
        const request = await prisma.reviewRequest.create({
          data: {
            businessId: tenant.business.id,
            customerId: cust.id,
            status: "READY",
            requestText: "Please leave an honest review.",
            createdByMembershipId: tenant.membership.id,
          },
        });
        subjectType = "REVIEW_REQUEST";
        subjectId = request.id;
        payload.requestText = request.requestText;
      } else if (purpose === "REFERRAL_REQUEST") {
        const request = await prisma.referralRequest.create({
          data: {
            businessId: tenant.business.id,
            customerId: cust.id,
            status: "READY",
            requestText: "If you know someone, send them our way.",
            createdByMembershipId: tenant.membership.id,
          },
        });
        subjectType = "REFERRAL_REQUEST";
        subjectId = request.id;
        payload.requestText = request.requestText;
      } else if (purpose === "JOB_FOLLOW_UP" || purpose === "REPEAT_FOLLOW_UP") {
        const row = await prisma.customerFollowUp.create({
          data: {
            businessId: tenant.business.id,
            customerId: cust.id,
            kind: purpose === "REPEAT_FOLLOW_UP" ? "REPEAT" : "JOB_COMPLETE",
            status: "OPEN",
            origin: "COMMUNICATION",
            notes: "Checking in after the job.",
            createdByMembershipId: tenant.membership.id,
          },
        });
        subjectType = "CUSTOMER_FOLLOW_UP";
        subjectId = row.id;
      } else {
        throw new Error(`unknown automation purpose ${purpose}`);
      }

      return attemptAutomationEmail(prisma, {
        businessId: tenant.business.id,
        runId: randomUUID(),
        purpose,
        subjectType,
        subjectId,
        customerId: cust.id,
        businessName: tenant.business.name,
        payload,
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
        purpose: "system-exempt-team",
        idempotencyKey: `team-invite/${tenant.business.id}/${email}`,
        businessId: tenant.business.id,
        db: prisma,
      });
    }

    let passwordResetNow = Date.now();
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
      passwordResetNow += 120_000;
      return requestPasswordResetOp(prisma, email, undefined, new Date(passwordResetNow));
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

    const AUTOMATION_KINDS = [
      "ESTIMATE_READY",
      "ESTIMATE_FOLLOW_UP",
      "INVOICE_READY",
      "PAYMENT_REMINDER",
      "APPOINTMENT_CONFIRMATION",
      "SCHEDULE_CHANGE",
      "APPOINTMENT_REMINDER",
      "REVIEW_REQUEST",
      "REFERRAL_REQUEST",
      "JOB_FOLLOW_UP",
      "REPEAT_FOLLOW_UP",
    ];

    const customerPaths = [
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
        name: "review reminder",
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, "Reminder Suppressed");
          return runReviewReminder(tenant, cust);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, "Reminder Allowed");
          return runReviewReminder(tenant, cust);
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
      ...AUTOMATION_KINDS.map((purpose) => ({
        name: `automation ${purpose}`,
        async suppressed(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          const cust = await customer(tenant, email, `Auto ${purpose} Suppressed`);
          return runAutomation(tenant, cust, purpose);
        },
        async allowed(tenant, email) {
          const cust = await customer(tenant, email, `Auto ${purpose} Allowed`);
          return runAutomation(tenant, cust, purpose);
        },
      })),
    ];

    const exemptPaths = [
      {
        name: "team invite",
        async run(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          return runTeam(tenant, email);
        },
      },
      {
        name: "password reset",
        async run(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          return runPasswordReset(tenant, email);
        },
      },
      {
        name: "new-request company notify",
        async run(tenant, email) {
          await recordFailedDest(tenant.business.id, email);
          return runCompanyNotify(tenant, email);
        },
      },
    ];

    console.log("\nTEST — each customer path honors suppression at send time");
    for (const path of customerPaths) {
      const suppressedEmail = `blocked.${path.name.replace(/\W+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`;
      const otherEmail = `clean.${path.name.replace(/\W+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`;
      const beforeBlocked = sentBefore();
      const suppressedResult = await path.suppressed(tenantA, suppressedEmail);
      check(
        `${path.name}: suppressed address makes zero provider calls`,
        fake.sent.length === beforeBlocked,
      );
      check(`${path.name}: outcome is suppressed`, isSuppressedOutcome(suppressedResult));
      check(`${path.name}: item not marked SENT`, !itemMarkedSent(suppressedResult, path.name));

      const beforeOther = sentBefore();
      const otherResult = await path.allowed(tenantB, suppressedEmail);
      check(
        `${path.name}: same address in another business still sends`,
        fake.sent.length === beforeOther + 1 &&
          fake.sent[fake.sent.length - 1].to.toLowerCase() === suppressedEmail.toLowerCase() &&
          fake.sent[fake.sent.length - 1].businessId === tenantB.business.id,
      );
      check(
        `${path.name}: other-business send is not suppressed`,
        !isSuppressedOutcome(otherResult) && itemMarkedSent(otherResult, path.name),
      );

      const beforeClean = sentBefore();
      const cleanResult = await path.allowed(tenantA, otherEmail);
      check(
        `${path.name}: non-suppressed address still sends exactly once`,
        fake.sent.length === beforeClean + 1 &&
          fake.sent[fake.sent.length - 1].to.toLowerCase() === otherEmail.toLowerCase(),
      );
      check(
        `${path.name}: clean send is not suppressed`,
        !isSuppressedOutcome(cleanResult) && itemMarkedSent(cleanResult, path.name),
      );
    }

    console.log("\nTEST — system-exempt mail still sends to a suppressed address");
    for (const path of exemptPaths) {
      const email = `exempt.${path.name.replace(/\W+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`;
      const before = sentBefore();
      const result = await path.run(tenantA, email);
      check(
        `${path.name}: exempt purpose still calls the provider once`,
        fake.sent.length === before + 1 &&
          fake.sent[fake.sent.length - 1].to.toLowerCase() === email.toLowerCase(),
      );
      check(`${path.name}: exempt outcome is not suppressed`, !isSuppressedOutcome(result));
    }

    console.log("\nTEST — fingerprint normalization and fail-closed lookup");
    const canon = `canon.${randomUUID().slice(0, 8)}@example.com`;
    await recordFailedDest(tenantA.business.id, canon);
    const beforeNorm = sentBefore();
    const normalized = await sendTransactionalEmail({
      apiKey: "re_test_outbound_suppression",
      from: "Suppress Co <suppress@example.com>",
      to: `  ${canon.split("@")[0].toUpperCase()}@${canon.split("@")[1].toUpperCase()}  `,
      subject: "Normalized",
      html: "<p>n</p>",
      text: "n",
      kind: "customer",
      purpose: "customer",
      idempotencyKey: `norm-${randomUUID()}`,
      businessId: tenantA.business.id,
      db: prisma,
    });
    check(
      "Case/whitespace matches the fingerprint and does not send",
      fake.sent.length === beforeNorm && normalized.suppressed === true,
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
      purpose: "customer",
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
      purpose: "customer",
      idempotencyKey: `lookup-${randomUUID()}`,
      businessId: tenantA.business.id,
      db: prisma,
    });
    resetOutboundEmailSuppressionTestHooks();
    check(
      "DB lookup error does not send to a known complaint address",
      fake.sent.length === beforeFail &&
        failedLookup.suppressed === true &&
        failedLookup.reason === "UNAVAILABLE",
    );
    check(
      "Suppression errors do not include the destination address",
      !String(failedLookup.message).includes(complaintEmail) &&
        !EMAIL_OUTBOUND_SUPPRESSED_COMPLAINT.includes("@"),
    );

    const missingBusiness = await sendTransactionalEmail({
      apiKey: "re_test_outbound_suppression",
      from: "Suppress Co <suppress@example.com>",
      to: `missing.${randomUUID().slice(0, 8)}@example.com`,
      subject: "Missing business",
      html: "<p>x</p>",
      text: "x",
      kind: "review",
      purpose: "customer",
      idempotencyKey: `missing-biz-${randomUUID()}`,
      db: prisma,
    });
    check(
      "Customer purpose without businessId is fail-closed and does not send",
      missingBusiness.suppressed === true && missingBusiness.reason === "UNAVAILABLE",
    );

    resetCommunicationEmailSender();
  },
).finally(restoreEnv);

if (!MUTATION_CHILD) {
  console.log("\nMUTATION — skipping review and automation checks fails those path tests");
  const mailPath = join(root, "src/lib/mail.ts");
  const original = readFileSync(mailPath, "utf8");
  const guard =
    "  if (isCustomerEmailPurpose(input.purpose)) {\n    const db = input.db ?? prisma;\n    const blocked = await blockedOutboundEmailReason(db, input.businessId ?? \"\", input.to);\n    if (blocked) {\n      return {\n        suppressed: true,\n        reason: blocked.reason,\n        message: blocked.message,\n      };\n    }\n  }";
  const mutated =
    "  if (isCustomerEmailPurpose(input.purpose) && input.kind !== \"review\" && input.purpose !== \"automation\") {\n    const db = input.db ?? prisma;\n    const blocked = await blockedOutboundEmailReason(db, input.businessId ?? \"\", input.to);\n    if (blocked) {\n      return {\n        suppressed: true,\n        reason: blocked.reason,\n        message: blocked.message,\n      };\n    }\n  }";
  check("Chokepoint customer-purpose guard is present for mutation", original.includes(guard));
  if (original.includes(guard)) {
    writeFileSync(mailPath, original.replace(guard, mutated));
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
      const mustFail = [
        "review request",
        "review reminder",
        ...[
          "ESTIMATE_READY",
          "ESTIMATE_FOLLOW_UP",
          "INVOICE_READY",
          "PAYMENT_REMINDER",
          "APPOINTMENT_CONFIRMATION",
          "SCHEDULE_CHANGE",
          "APPOINTMENT_REMINDER",
          "REVIEW_REQUEST",
          "REFERRAL_REQUEST",
          "JOB_FOLLOW_UP",
          "REPEAT_FOLLOW_UP",
        ].map((purpose) => `automation ${purpose}`),
      ];
      const failedTargeted = mustFail.every((name) =>
        output.includes(`FAIL - ${name}: suppressed address makes zero provider calls`),
      );
      check(
        "Removing the review and automation checks fails those path tests",
        child.status !== 0 && failedTargeted,
      );
      if (child.status === 0 || !failedTargeted) {
        console.error(output.slice(-6000));
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
