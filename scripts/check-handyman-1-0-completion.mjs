/**
 * Handyman 1.0 completion proofs: tenant export, TOTP, ownership transfer,
 * offboarding without silent deletes, and non-CollPro host strategy.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-1-0-completion.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword, hashToken } = await import("@/lib/auth-crypto");
const { CAPABILITIES, roleHasCapability } = await import("@/lib/authorization");
const { verifyTotpCode, generateTotpSecret, currentTotpCode } = await import("@/lib/totp");
const {
  startTotpEnrollmentOp,
  confirmTotpEnrollmentOp,
  consumeBackupCode,
  createTotpSignInChallenge,
  verifyTotpSignInChallenge,
  revokeOtherSessionsOp,
  SENSITIVE_PASSWORD_REQUIRED,
  SENSITIVE_PASSWORD_WRONG,
  SENSITIVE_TOTP_REQUIRED,
  TOTP_CHALLENGE_EXPIRED_MESSAGE,
  TOTP_CHALLENGE_LOCKED_MESSAGE,
  TOTP_CHALLENGE_MAX_ATTEMPTS,
} = await import("@/lib/account-security");
const { buildBusinessExportZip, isExportableField } = await import("@/lib/business-export");
const { transferBusinessOwnershipOp, OWNERSHIP_TRANSFER_CONFIRMATION } = await import(
  "@/lib/ownership-transfer"
);
const {
  requestBusinessOffboardingOp,
  retryOffboardingBillingCancellationOp,
  isOffboardingBillingRetryAvailable,
  OFFBOARDING_CONFIRMATION,
  OFFBOARDING_BILLING_NOT_SCHEDULED_MESSAGE,
  OFFBOARDING_BILLING_SCHEDULED_MESSAGE,
} = await import("@/lib/offboarding");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const { applyParsedSaasBillingEvent, parseSaasBillingEvent, SAAS_CHECKOUT_PURPOSE } =
  await import("@/lib/saas-billing");
const { getTenantAppOrigin, tenantPublicSiteUrl, tenantEstimateUrl } = await import(
  "@/lib/tenant-app-url"
);
const { PRODUCTION_APP_ORIGIN } = await import("@/lib/mail");
const { TBBT_MARKETING_CANONICAL_ORIGIN } = await import("@/lib/tbbt-marketing-host");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_handyman_10_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
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
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function accessFor(membership, business) {
  return {
    businessId: business.id,
    workspace: { membership, role: membership.role, business },
    scope: { businessId: business.id },
    assertOwned: (row) => row,
    assertAttachable: (row) => row,
  };
}

const settingsSrc = readFileSync(new URL("../src/lib/settings.ts", import.meta.url), "utf8");
const browserSrc = readFileSync(
  new URL("../src/components/public/public-services-browser.tsx", import.meta.url),
  "utf8",
);

console.log("\nSTATIC — 1.0 completion honesty");
check("Password hashes are not exportable fields", !isExportableField("passwordHash"));
check("TOTP secrets are not exportable fields", !isExportableField("totpSecret"));
check("Session token hashes are not exportable fields", !isExportableField("tokenHash"));
check("ADMIN cannot transfer ownership", !roleHasCapability("ADMIN", CAPABILITIES.TRANSFER_OWNERSHIP));
check("OWNER can transfer ownership", roleHasCapability("OWNER", CAPABILITIES.TRANSFER_OWNERSHIP));
check(
  "Public services disclaimer is tenant-generic",
  browserSrc.includes("The business reviews the request") &&
    !browserSrc.includes("CollPro reviews the request"),
);
check(
  "Empty catalog still offers other-work intake",
  browserSrc.includes("Select other work to continue") &&
    readFileSync(new URL("../src/components/public/request-flow.tsx", import.meta.url), "utf8").includes(
      "catalogEmpty",
    ) &&
    readFileSync(new URL("../src/components/public/public-home.tsx", import.meta.url), "utf8").includes(
      "A published service list is not available yet",
    ),
);
check(
  "Public request wizard persists a tenant-scoped draft",
  readFileSync(new URL("../src/components/public/request-flow.tsx", import.meta.url), "utf8").includes(
    "tbbt-public-request:",
  ),
);
check(
  "Public request wizard reads submitted FormData on next-step",
  readFileSync(new URL("../src/components/public/request-flow.tsx", import.meta.url), "utf8").includes(
    "readDetailsFromForm",
  ),
);
check(
  "Settings section shortcuts redirect to the settings query",
  readFileSync(
    new URL("../src/app/(app)/settings/[section]/page.tsx", import.meta.url),
    "utf8",
  ).includes("/settings?section="),
);
check(
  "Settings export copy no longer says ZIP is only planned",
  settingsSrc.includes("Download a tenant-scoped ZIP") ||
    settingsSrc.includes("Tenant-scoped ZIP export is available"),
);
const offboardingSrc = readFileSync(new URL("../src/lib/offboarding.ts", import.meta.url), "utf8");
const offboardingFormSrc = readFileSync(
  new URL("../src/components/settings/offboarding-form.tsx", import.meta.url),
  "utf8",
);
const securitySrc = readFileSync(new URL("../src/lib/account-security.ts", import.meta.url), "utf8");
const ownershipSrc = readFileSync(new URL("../src/lib/ownership-transfer.ts", import.meta.url), "utf8");
const ownerPhotoSrc = readFileSync(new URL("../src/app/actions/job-photo.ts", import.meta.url), "utf8");
check(
  "Offboarding never writes cancelAtPeriodEnd locally",
  !offboardingSrc.includes("cancelAtPeriodEnd: true") &&
    offboardingSrc.includes("scheduleCancelAtPeriodEnd") &&
    offboardingSrc.includes("billingCancellationScheduled") &&
    offboardingSrc.includes("Billing cancellation is not yet scheduled."),
);
check(
  "Offboarding retry is available after a recorded request until webhook confirmation",
  offboardingSrc.includes("retryOffboardingBillingCancellationOp") &&
    offboardingSrc.includes("isOffboardingBillingRetryAvailable") &&
    offboardingFormSrc.includes("Retry billing cancellation") &&
    offboardingFormSrc.includes("retryOffboardingBillingAction") &&
    offboardingFormSrc.includes("billingRetryAvailable") &&
    offboardingFormSrc.includes("billingCancellationConfirmed"),
);
check(
  "Owner job-photo uploads use private R2, not Vercel Blob",
  ownerPhotoSrc.includes("Cloudflare R2") &&
    ownerPhotoSrc.includes("authorizeManagementJobPhoto") &&
    ownerPhotoSrc.includes("finalizeManagementJobPhoto") &&
    ownerPhotoSrc.includes("The image body never enters this") &&
    !ownerPhotoSrc.includes("BLOB_READ_WRITE_TOKEN") &&
    !ownerPhotoSrc.includes("Vercel Blob") &&
    !ownerPhotoSrc.includes("uploadJobPhoto") &&
    !ownerPhotoSrc.includes("instanceof File") &&
    !ownerPhotoSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES"),
);
check(
  "Offboarding and ownership require step-up proof before typed confirmation",
  offboardingSrc.includes("requireSensitiveActionProof") &&
    ownershipSrc.includes("requireSensitiveActionProof") &&
    securitySrc.includes("usedAt: null"),
);
check(
  "TOTP challenges persist a failed-attempt counter",
  readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8").includes(
    "failedAttemptCount",
  ) && securitySrc.includes("failedAttemptCount"),
);

const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
process.env.NEXT_PUBLIC_APP_URL = "https://www.collproreno.com";
check(
  "CollPro slug keeps the CollPro production host",
  getTenantAppOrigin("collpro-reno") === "https://www.collproreno.com",
);
check(
  "Non-CollPro slug never uses the CollPro hostname",
  getTenantAppOrigin("acme-handyman") === TBBT_MARKETING_CANONICAL_ORIGIN &&
    tenantPublicSiteUrl("acme-handyman") === `${TBBT_MARKETING_CANONICAL_ORIGIN}/hire/acme-handyman` &&
    tenantEstimateUrl("acme-handyman", "tok_1") === `${TBBT_MARKETING_CANONICAL_ORIGIN}/e/tok_1` &&
    !tenantPublicSiteUrl("acme-handyman").includes("collproreno.com"),
);
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:43217";
check(
  "Local app URL is used for every slug",
  getTenantAppOrigin("acme-handyman") === "http://localhost:43217" &&
    getTenantAppOrigin("collpro-reno") === "http://localhost:43217",
);
if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
check("Production CollPro origin constant remains documented", PRODUCTION_APP_ORIGIN.includes("collproreno.com"));

const secret = generateTotpSecret();
check("Generated TOTP codes verify", verifyTotpCode(secret, currentTotpCode(secret)));
check("Wrong TOTP codes fail", !verifyTotpCode(secret, "000000"));

try {
  console.log("\nDB — export, TOTP, ownership, offboarding");
  const passwordHash = await hashPassword("password12");
  const ownerUser = await prisma.user.create({
    data: { email: `owner-${randomUUID()}@example.com`, name: "Owner One", passwordHash },
  });
  const adminUser = await prisma.user.create({
    data: { email: `admin-${randomUUID()}@example.com`, name: "Admin Two", passwordHash },
  });
  const other = await prisma.business.create({
    data: { name: "Other Co", slug: `other-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const business = await prisma.business.create({
    data: { name: "Acme Handy", slug: `acme-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const owner = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const admin = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
  });
  await prisma.customer.create({
    data: { businessId: business.id, name: "Pat Customer", email: "pat@example.com" },
  });
  await prisma.customer.create({
    data: { businessId: other.id, name: "Other Customer", email: "other@example.com" },
  });

  const exported = await buildBusinessExportZip(prisma, business.id);
  const zipText = exported.bytes.toString("utf8");
  check("Export filename is tenant ZIP", exported.filename.startsWith("tbbt-export-") && exported.filename.endsWith(".zip"));
  check("Export includes this tenant customer", zipText.includes("Pat Customer"));
  check("Export excludes the other tenant customer", !zipText.includes("Other Customer"));
  check("Export zip is non-empty", exported.bytes.length > 100);

  let enrollmentNeedsPassword = false;
  try {
    await startTotpEnrollmentOp(prisma, {
      userId: ownerUser.id,
      accountName: ownerUser.email,
      password: "",
    });
  } catch (error) {
    enrollmentNeedsPassword = error.message === SENSITIVE_PASSWORD_REQUIRED;
  }
  check("TOTP enrollment requires the current password", enrollmentNeedsPassword);

  const started = await startTotpEnrollmentOp(prisma, {
    userId: ownerUser.id,
    accountName: ownerUser.email,
    password: "password12",
  });
  const confirmed = await confirmTotpEnrollmentOp(prisma, {
    userId: ownerUser.id,
    code: currentTotpCode(started.secret),
  });
  check("TOTP enrollment returns backup codes", confirmed.backupCodes.length >= 8);

  const challenge = await createTotpSignInChallenge(prisma, ownerUser.id);
  const verified = await verifyTotpSignInChallenge(prisma, {
    challengeToken: challenge,
    code: currentTotpCode(started.secret),
  });
  check("TOTP sign-in challenge accepts a current code", verified.userId === ownerUser.id);

  const limitedToken = await createTotpSignInChallenge(prisma, ownerUser.id);
  let lockedMessage = "";
  for (let attempt = 0; attempt < TOTP_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await verifyTotpSignInChallenge(prisma, {
        challengeToken: limitedToken,
        code: "000000",
      });
    } catch (error) {
      lockedMessage = error.message;
    }
  }
  const leftoverLimited = await prisma.authChallenge.findMany({
    where: { userId: ownerUser.id, purpose: "TOTP_SIGN_IN" },
  });
  check(
    "Five wrong TOTP codes invalidate the challenge",
    lockedMessage === TOTP_CHALLENGE_LOCKED_MESSAGE && leftoverLimited.length === 0,
  );

  const expiredToken = await createTotpSignInChallenge(prisma, ownerUser.id);
  await prisma.authChallenge.updateMany({
    where: { userId: ownerUser.id, purpose: "TOTP_SIGN_IN" },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  let expiredMessage = "";
  try {
    await verifyTotpSignInChallenge(prisma, {
      challengeToken: expiredToken,
      code: currentTotpCode(started.secret),
    });
  } catch (error) {
    expiredMessage = error.message;
  }
  const leftoverExpired = await prisma.authChallenge.findMany({
    where: { userId: ownerUser.id, purpose: "TOTP_SIGN_IN" },
  });
  check(
    "Expired TOTP challenges are rejected and cleaned up",
    expiredMessage === TOTP_CHALLENGE_EXPIRED_MESSAGE && leftoverExpired.length === 0,
  );

  const backupCode = confirmed.backupCodes[0];
  const [firstUse, secondUse] = await Promise.all([
    consumeBackupCode(prisma, ownerUser.id, backupCode),
    consumeBackupCode(prisma, ownerUser.id, backupCode),
  ]);
  const reused = await consumeBackupCode(prisma, ownerUser.id, backupCode);
  check(
    "Backup codes are consumed once under concurrency",
    (firstUse ? 1 : 0) + (secondUse ? 1 : 0) === 1 && reused === false,
  );

  const currentToken = `current-session-${randomUUID()}`;
  const otherToken = `other-session-${randomUUID()}`;
  await prisma.session.create({
    data: {
      tokenHash: hashToken(currentToken),
      userId: ownerUser.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const otherSession = await prisma.session.create({
    data: {
      tokenHash: hashToken(otherToken),
      userId: ownerUser.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const current = await prisma.session.findFirst({
    where: { tokenHash: hashToken(currentToken) },
  });
  const revoked = await revokeOtherSessionsOp(prisma, {
    userId: ownerUser.id,
    currentSessionId: current.id,
  });
  const otherAfter = await prisma.session.findUnique({ where: { id: otherSession.id } });
  check("Revoke others marks the other session revoked", revoked === 1 && Boolean(otherAfter.revokedAt));

  let adminBlocked = false;
  try {
    await transferBusinessOwnershipOp(prisma, accessFor(admin, business), {
      targetMembershipId: owner.id,
      confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
      currentPassword: "password12",
    });
  } catch {
    adminBlocked = true;
  }
  check("ADMIN cannot transfer ownership", adminBlocked);

  let transferNeedsPassword = false;
  try {
    await transferBusinessOwnershipOp(prisma, accessFor(owner, business), {
      targetMembershipId: admin.id,
      confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
      currentPassword: "",
    });
  } catch (error) {
    transferNeedsPassword = error.message === SENSITIVE_PASSWORD_REQUIRED;
  }
  check("TRANSFER confirmation is not identity proof", transferNeedsPassword);

  let transferNeedsTotp = false;
  try {
    await transferBusinessOwnershipOp(prisma, accessFor(owner, business), {
      targetMembershipId: admin.id,
      confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
      currentPassword: "password12",
    });
  } catch (error) {
    transferNeedsTotp = error.message === SENSITIVE_TOTP_REQUIRED;
  }
  check("Ownership transfer requires TOTP when it is enabled", transferNeedsTotp);

  let wrongPasswordBlocked = false;
  try {
    await transferBusinessOwnershipOp(prisma, accessFor(owner, business), {
      targetMembershipId: admin.id,
      confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
      currentPassword: "wrong-password",
      totpOrBackupCode: currentTotpCode(started.secret),
    });
  } catch (error) {
    wrongPasswordBlocked = error.message === SENSITIVE_PASSWORD_WRONG;
  }
  check("Wrong current password blocks ownership transfer", wrongPasswordBlocked);

  const transferred = await transferBusinessOwnershipOp(prisma, accessFor(owner, business), {
    targetMembershipId: admin.id,
    confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
    currentPassword: "password12",
    totpOrBackupCode: currentTotpCode(started.secret),
  });
  const ownerAfter = await prisma.membership.findUnique({ where: { id: owner.id } });
  const adminAfter = await prisma.membership.findUnique({ where: { id: admin.id } });
  const audit = await prisma.settingsAuditLog.findFirst({
    where: { businessId: business.id, settingKey: "ownership" },
  });
  check(
    "Ownership transfer swaps OWNER/ADMIN and writes audit",
    transferred.newOwnerMembershipId === admin.id &&
      ownerAfter.role === "ADMIN" &&
      adminAfter.role === "OWNER" &&
      Boolean(audit),
  );

  const customerCountBefore = await prisma.customer.count({ where: { businessId: business.id } });
  let cancelIsNotProof = false;
  try {
    await requestBusinessOffboardingOp(prisma, accessFor(adminAfter, business), {
      confirmation: OFFBOARDING_CONFIRMATION,
      acknowledgedExport: true,
      currentPassword: "",
    });
  } catch (error) {
    cancelIsNotProof = error.message === SENSITIVE_PASSWORD_REQUIRED;
  }
  check("CANCEL confirmation is not identity proof", cancelIsNotProof);

  const offboarded = await requestBusinessOffboardingOp(prisma, accessFor(adminAfter, business), {
    confirmation: OFFBOARDING_CONFIRMATION,
    acknowledgedExport: true,
    currentPassword: "password12",
  });
  const customerCountAfter = await prisma.customer.count({ where: { businessId: business.id } });
  const businessAfter = await prisma.business.findUnique({
    where: { id: business.id },
    include: { saasSubscription: true },
  });
  check("Offboarding does not delete customers", customerCountBefore === customerCountAfter && customerCountAfter === 1);
  check(
    "Offboarding without a Stripe subscription records the request and does not claim billing cancel",
    Boolean(businessAfter.offboardingRequestedAt) &&
      offboarded.recordsDeleted === false &&
      offboarded.billingCancellationScheduled === false &&
      offboarded.billingCancellationMessage === OFFBOARDING_BILLING_NOT_SCHEDULED_MESSAGE &&
      businessAfter.saasSubscription == null,
  );

  async function seedOwnedBusiness(name) {
    const user = await prisma.user.create({
      data: {
        email: `${name}-${randomUUID()}@example.com`,
        name,
        passwordHash,
      },
    });
    const row = await prisma.business.create({
      data: {
        name,
        slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
        tradeCode: "HANDYMAN",
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, businessId: row.id, role: "OWNER" },
    });
    return { user, business: row, membership };
  }

  const billed = await seedOwnedBusiness("Billing Success");
  const failed = await seedOwnedBusiness("Billing Fail");
  const totpOffboard = await seedOwnedBusiness("Totp Offboard");
  const successProvider = createFakeSaasBillingProvider();
  const failProvider = createFakeSaasBillingProvider();
  failProvider.failCancel = true;
  const successSubId = `sub_success_${randomUUID()}`;
  const failSubId = `sub_fail_${randomUUID()}`;
  const successCustomerId = `cus_success_${randomUUID()}`;
  const failCustomerId = `cus_fail_${randomUUID()}`;
  successProvider.addSubscription({
    id: successSubId,
    customerId: successCustomerId,
    priceId: "price_saas_test",
    status: "active",
    currentPeriodEnd: new Date("2026-10-24T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
  });
  failProvider.addSubscription({
    id: failSubId,
    customerId: failCustomerId,
    priceId: "price_saas_test",
    status: "active",
    currentPeriodEnd: new Date("2026-10-24T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: billed.business.id,
      stripeCustomerId: successCustomerId,
      stripeSubscriptionId: successSubId,
      stripePriceId: "price_saas_test",
      status: "active",
      cancelAtPeriodEnd: false,
    },
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: failed.business.id,
      stripeCustomerId: failCustomerId,
      stripeSubscriptionId: failSubId,
      stripePriceId: "price_saas_test",
      status: "active",
      cancelAtPeriodEnd: false,
    },
  });

  const totpStarted = await startTotpEnrollmentOp(prisma, {
    userId: totpOffboard.user.id,
    accountName: totpOffboard.user.email,
    password: "password12",
  });
  await confirmTotpEnrollmentOp(prisma, {
    userId: totpOffboard.user.id,
    code: currentTotpCode(totpStarted.secret),
  });
  let offboardNeedsTotp = false;
  try {
    await requestBusinessOffboardingOp(prisma, accessFor(totpOffboard.membership, totpOffboard.business), {
      confirmation: OFFBOARDING_CONFIRMATION,
      acknowledgedExport: true,
      currentPassword: "password12",
    });
  } catch (error) {
    offboardNeedsTotp = error.message === SENSITIVE_TOTP_REQUIRED;
  }
  check("Offboarding requires TOTP when it is enabled", offboardNeedsTotp);
  const totpOffboarded = await requestBusinessOffboardingOp(
    prisma,
    accessFor(totpOffboard.membership, totpOffboard.business),
    {
      confirmation: OFFBOARDING_CONFIRMATION,
      acknowledgedExport: true,
      currentPassword: "password12",
      totpOrBackupCode: currentTotpCode(totpStarted.secret),
    },
  );
  check(
    "TOTP-proven offboarding still preserves records when billing is unavailable",
    totpOffboarded.recordsDeleted === false &&
      totpOffboarded.billingCancellationScheduled === false,
  );

  const scheduled = await requestBusinessOffboardingOp(
    prisma,
    accessFor(billed.membership, billed.business),
    {
      confirmation: OFFBOARDING_CONFIRMATION,
      acknowledgedExport: true,
      currentPassword: "password12",
    },
    { provider: successProvider },
  );
  const billedRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: billed.business.id },
  });
  const billedBusiness = await prisma.business.findUnique({ where: { id: billed.business.id } });
  check(
    "Fake provider success schedules cancel in-memory only",
    scheduled.billingCancellationScheduled === true &&
      scheduled.billingCancellationMessage === OFFBOARDING_BILLING_SCHEDULED_MESSAGE &&
      billedRow.cancelAtPeriodEnd === false &&
      Boolean(billedBusiness.offboardingRequestedAt) &&
      successProvider.subscriptions.get(successSubId).cancelAtPeriodEnd === true,
  );

  const webhookApplied = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent({
      id: `evt_offboard_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          object: "subscription",
          id: successSubId,
          status: "active",
          customer: successCustomerId,
          cancel_at_period_end: true,
          items: {
            data: [
              {
                current_period_end: 1_800_000_000,
                price: { id: "price_saas_test" },
              },
            ],
          },
          metadata: {
            purpose: SAAS_CHECKOUT_PURPOSE,
            businessId: billed.business.id,
          },
        },
      },
    }),
  );
  const billedAfterWebhook = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: billed.business.id },
  });
  check(
    "Webhook snapshot is the authoritative cancelAtPeriodEnd write",
    webhookApplied.applied === true && billedAfterWebhook.cancelAtPeriodEnd === true,
  );

  const failedCancel = await requestBusinessOffboardingOp(
    prisma,
    accessFor(failed.membership, failed.business),
    {
      confirmation: OFFBOARDING_CONFIRMATION,
      acknowledgedExport: true,
      currentPassword: "password12",
    },
    { provider: failProvider },
  );
  const failedRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: failed.business.id },
  });
  const failedBusiness = await prisma.business.findUnique({ where: { id: failed.business.id } });
  check(
    "Provider cancel failure preserves the offboarding request and does not claim billing cancel",
    failedCancel.billingCancellationScheduled === false &&
      failedCancel.billingCancellationMessage === OFFBOARDING_BILLING_NOT_SCHEDULED_MESSAGE &&
      failedRow.cancelAtPeriodEnd === false &&
      Boolean(failedBusiness.offboardingRequestedAt) &&
      failProvider.subscriptions.get(failSubId).cancelAtPeriodEnd === false,
  );
  const originalRequestedAt = failedBusiness.offboardingRequestedAt;
  check(
    "Retry remains available after provider cancel failure",
    isOffboardingBillingRetryAvailable({
      offboardingRequestedAt: originalRequestedAt,
      stripeSubscriptionId: failedRow.stripeSubscriptionId,
      cancelAtPeriodEnd: failedRow.cancelAtPeriodEnd,
    }) === true,
  );

  let retryNeedsPassword = false;
  try {
    await retryOffboardingBillingCancellationOp(
      prisma,
      accessFor(failed.membership, failed.business),
      { currentPassword: "" },
      { provider: failProvider },
    );
  } catch (error) {
    retryNeedsPassword = error.message === SENSITIVE_PASSWORD_REQUIRED;
  }
  check("Billing cancel retry requires current-password step-up", retryNeedsPassword);

  const stillFailed = await retryOffboardingBillingCancellationOp(
    prisma,
    accessFor(failed.membership, failed.business),
    { currentPassword: "password12" },
    { provider: failProvider },
  );
  const stillFailedBusiness = await prisma.business.findUnique({
    where: { id: failed.business.id },
  });
  check(
    "Failed retry preserves the original offboarding timestamp",
    stillFailed.billingCancellationScheduled === false &&
      stillFailed.retryAvailable === true &&
      stillFailedBusiness.offboardingRequestedAt.getTime() === originalRequestedAt.getTime(),
  );

  failProvider.failCancel = false;
  const retried = await retryOffboardingBillingCancellationOp(
    prisma,
    accessFor(failed.membership, failed.business),
    { currentPassword: "password12" },
    { provider: failProvider },
  );
  const afterRetryRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: failed.business.id },
  });
  const afterRetryBusiness = await prisma.business.findUnique({
    where: { id: failed.business.id },
  });
  check(
    "Provider retry success does not write local cancelAtPeriodEnd",
    retried.billingCancellationScheduled === true &&
      retried.billingCancellationMessage === OFFBOARDING_BILLING_SCHEDULED_MESSAGE &&
      afterRetryRow.cancelAtPeriodEnd === false &&
      failProvider.subscriptions.get(failSubId).cancelAtPeriodEnd === true &&
      afterRetryBusiness.offboardingRequestedAt.getTime() === originalRequestedAt.getTime() &&
      retried.retryAvailable === true &&
      isOffboardingBillingRetryAvailable({
        offboardingRequestedAt: afterRetryBusiness.offboardingRequestedAt,
        stripeSubscriptionId: afterRetryRow.stripeSubscriptionId,
        cancelAtPeriodEnd: afterRetryRow.cancelAtPeriodEnd,
      }) === true,
  );

  const retryWebhook = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent({
      id: `evt_offboard_retry_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          object: "subscription",
          id: failSubId,
          status: "active",
          customer: failCustomerId,
          cancel_at_period_end: true,
          items: {
            data: [
              {
                current_period_end: 1_800_000_000,
                price: { id: "price_saas_test" },
              },
            ],
          },
          metadata: {
            purpose: SAAS_CHECKOUT_PURPOSE,
            businessId: failed.business.id,
          },
        },
      },
    }),
  );
  const confirmedRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: failed.business.id },
  });
  const confirmedBusiness = await prisma.business.findUnique({
    where: { id: failed.business.id },
  });
  check(
    "Webhook confirmation is the only local cancelAtPeriodEnd write and hides retry",
    retryWebhook.applied === true &&
      confirmedRow.cancelAtPeriodEnd === true &&
      confirmedBusiness.offboardingRequestedAt.getTime() === originalRequestedAt.getTime() &&
      isOffboardingBillingRetryAvailable({
        offboardingRequestedAt: confirmedBusiness.offboardingRequestedAt,
        stripeSubscriptionId: confirmedRow.stripeSubscriptionId,
        cancelAtPeriodEnd: confirmedRow.cancelAtPeriodEnd,
      }) === false,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nHandyman 1.0 completion checks passed.");
