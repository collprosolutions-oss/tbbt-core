/**
 * Referral + review-reminder isolation and idempotency.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-referrals.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const { customerSmsIdempotencyKey } = await import("@/lib/customer-messaging/bodies");
const { reviewRequestEmailIdempotencyKey } = await import("@/lib/mail");
const { REQUEST_SEND_DISCLAIMER, NO_REVIEW_GATING_MESSAGE, suggestedRequestText } = await import(
  "@/lib/reviews"
);
const {
  createReviewRequest,
  advanceReviewRequestStatus,
  sendReviewRequestReminder,
  stopReviewRequestReminders,
  ReviewsError,
} = await import("@/lib/reviews-ops");
const {
  createReferralRequest,
  advanceReferralRequest,
  cancelReferralRequest,
  recordReferral,
  createCustomerFollowUp,
  cancelCustomerFollowUp,
  ReferralError,
  suggestedReferralText,
} = await import("@/lib/referral-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_referrals_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
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

try {
  console.log("\nSTATIC — Referrals + reminder idempotency");
  check(
    "Referral copy does not gate on a positive review",
    !/5-star|five star|positive review/i.test(
      suggestedReferralText({ customerName: "Ada", businessName: "CollPro" }),
    ),
  );
  check(
    "Review request copy still asks for an honest review",
    /honest review/.test(suggestedRequestText({ customerName: "Ada", businessName: "CollPro" })),
  );
  check("No review gating message is present", /does not suppress/.test(NO_REVIEW_GATING_MESSAGE));
  check(
    "Send disclaimer never claims a published external review",
    /never claims a published/i.test(REQUEST_SEND_DISCLAIMER),
  );
  check(
    "Review email idempotency is per request + attempt",
    reviewRequestEmailIdempotencyKey("req-1", "sent") === "review-request/req-1/sent" &&
      reviewRequestEmailIdempotencyKey("req-1", "reminder-1") === "review-request/req-1/reminder-1",
  );
  check(
    "SMS reminder keys differ per attempt",
    customerSmsIdempotencyKey("REVIEW_REMINDER", "req-1", "1") !==
      customerSmsIdempotencyKey("REVIEW_REMINDER", "req-1", "2"),
  );
  check(
    "Referral SMS key is stable for one request",
    customerSmsIdempotencyKey("REFERRAL_REQUEST", "ref-1") ===
      customerSmsIdempotencyKey("REFERRAL_REQUEST", "ref-1"),
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Referrals", slug: `alpha-ref-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Referrals", slug: `beta-ref-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-ref-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-ref-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-ref-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_REVIEWS);
    check("MEMBER cannot manage reviews", false);
  } catch (error) {
    check("MEMBER cannot manage reviews", error instanceof ForbiddenError);
  }

  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Ada",
      email: `ada-${randomUUID()}@example.com`,
      phone: "5551112222",
    },
  });
  const customerA2 = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Ned",
      email: `ned-${randomUUID()}@example.com`,
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Bea Customer",
      email: `bea-c-${randomUUID()}@example.com`,
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const openJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });

  try {
    await createReferralRequest(prisma, ownerA, { customerId: customerA.id, jobId: openJob.id });
    check("Open job cannot start a referral request", false);
  } catch (error) {
    check(
      "Open job cannot start a referral request",
      error instanceof ReferralError && /completed job/.test(error.message),
    );
  }

  const referralRequest = await createReferralRequest(prisma, ownerA, {
    customerId: customerA.id,
    jobId: jobA.id,
  });
  check("Referral request is tenant-scoped", referralRequest.businessId === businessA.id);

  try {
    await createReferralRequest(prisma, ownerB, { customerId: customerA.id });
    check("Business B cannot request a referral from A's customer", false);
  } catch {
    check("Business B cannot request a referral from A's customer", true);
  }

  try {
    await createReferralRequest(prisma, memberA, { customerId: customerA.id });
    check("MEMBER cannot create a referral request", false);
  } catch (error) {
    check(
      "MEMBER cannot create a referral request",
      error instanceof ForbiddenError || error instanceof ReferralError,
    );
  }

  const ready = await advanceReferralRequest(prisma, ownerA, { requestId: referralRequest.id });
  check("DRAFT advances to READY", ready.status === "READY");
  const sent = await advanceReferralRequest(prisma, ownerA, { requestId: referralRequest.id });
  check("READY advances to SENT even when adapters are disconnected", sent.status === "SENT");
  const surviving = await prisma.referralRequest.findUnique({ where: { id: referralRequest.id } });
  check("Referral row survives provider failure", surviving?.status === "SENT");

  try {
    await advanceReferralRequest(prisma, ownerA, { requestId: referralRequest.id });
    check("SENT referral request cannot be advanced again", false);
  } catch (error) {
    check("SENT referral request cannot be advanced again", error instanceof ReferralError);
  }

  try {
    await recordReferral(prisma, ownerA, {
      sourceCustomerId: customerA.id,
      referredCustomerId: customerA.id,
    });
    check("A customer cannot refer themselves", false);
  } catch (error) {
    check("A customer cannot refer themselves", error instanceof ReferralError);
  }

  try {
    await recordReferral(prisma, ownerA, {
      sourceCustomerId: customerA.id,
      referredCustomerId: customerB.id,
    });
    check("Cannot attach a foreign referred customer", false);
  } catch {
    check("Cannot attach a foreign referred customer", true);
  }

  const referral = await recordReferral(prisma, ownerA, {
    sourceCustomerId: customerA.id,
    referredCustomerId: customerA2.id,
    referralRequestId: referralRequest.id,
  });
  check("Recorded referral stays on tenant A", referral.businessId === businessA.id && referral.status === "CONVERTED");
  const completedRequest = await prisma.referralRequest.findUnique({ where: { id: referralRequest.id } });
  check("Linked referral request is marked COMPLETED", completedRequest?.status === "COMPLETED");

  const cancellable = await createReferralRequest(prisma, ownerA, { customerId: customerA2.id });
  const cancelled = await cancelReferralRequest(prisma, ownerA, { requestId: cancellable.id });
  check("Owner can cancel an open referral request", cancelled.status === "CANCELLED" && Boolean(cancelled.remindersStoppedAt));

  const followUp = await createCustomerFollowUp(prisma, ownerA, {
    customerId: customerA.id,
    jobId: jobA.id,
    kind: "JOB_COMPLETE",
  });
  check("Follow-up row is created before any send", followUp.status === "OPEN" && followUp.businessId === businessA.id);
  const stopped = await cancelCustomerFollowUp(prisma, ownerA, { followUpId: followUp.id });
  check("Owner can stop a follow-up", stopped.status === "CANCELLED" && Boolean(stopped.cancelledAt));

  try {
    await cancelCustomerFollowUp(prisma, ownerB, { followUpId: followUp.id });
    check("Business B cannot cancel A's follow-up", false);
  } catch {
    check("Business B cannot cancel A's follow-up", true);
  }

  const reviewRequest = await createReviewRequest(prisma, ownerA, {
    customerId: customerA.id,
    jobId: jobA.id,
  });
  await advanceReviewRequestStatus(prisma, ownerA, { requestId: reviewRequest.id });
  const reviewSent = await advanceReviewRequestStatus(prisma, ownerA, { requestId: reviewRequest.id });
  check(
    "Review request is recorded as SENT when adapters are disconnected",
    reviewSent.status === "SENT",
  );
  const firstReminder = await sendReviewRequestReminder(prisma, ownerA, { requestId: reviewRequest.id });
  check("First reminder increments the count", firstReminder.reminderCount === 1);
  const secondReminder = await sendReviewRequestReminder(prisma, ownerA, { requestId: reviewRequest.id });
  check("Second reminder reaches the default max", secondReminder.reminderCount === 2);
  try {
    await sendReviewRequestReminder(prisma, ownerA, { requestId: reviewRequest.id });
    check("Reminder limit is enforced", false);
  } catch (error) {
    check("Reminder limit is enforced", error instanceof ReviewsError && /Reminder limit/.test(error.message));
  }
  const stoppedReminders = await stopReviewRequestReminders(prisma, ownerA, {
    requestId: reviewRequest.id,
  });
  check("Owner can stop further reminders", Boolean(stoppedReminders.remindersStoppedAt));

  const otherRequest = await createReviewRequest(prisma, ownerA, {
    customerId: customerA2.id,
  });
  await advanceReviewRequestStatus(prisma, ownerA, { requestId: otherRequest.id });
  await advanceReviewRequestStatus(prisma, ownerA, { requestId: otherRequest.id });
  await stopReviewRequestReminders(prisma, ownerA, { requestId: otherRequest.id });
  try {
    await sendReviewRequestReminder(prisma, ownerA, { requestId: otherRequest.id });
    check("Stopped reminders cannot be sent", false);
  } catch (error) {
    check("Stopped reminders cannot be sent", error instanceof ReviewsError && /stopped/.test(error.message));
  }

  const betaReferrals = await prisma.referral.findMany({ where: { businessId: businessB.id } });
  const betaRequests = await prisma.referralRequest.findMany({ where: { businessId: businessB.id } });
  check("Business B does not see A's referrals", betaReferrals.length === 0 && betaRequests.length === 0);

  console.log(failures === 0 ? "\nAll referral checks passed." : `\n${failures} referral check(s) failed.`);
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
