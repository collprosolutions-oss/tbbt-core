/**
 * P1-1 password recovery + signed-in change-password proofs.
 *
 * Imports the real ops from src/lib/password-reset.ts (no next/headers).
 * Mail is injected so Resend is never called.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-password-recovery.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  PASSWORD_RESET_COOLDOWN_MS,
  PASSWORD_RESET_EXPIRY_MS,
  PASSWORD_RESET_REQUEST_MESSAGE,
  PASSWORD_RESET_TOKEN_ERROR,
  changeSignedInPasswordOp,
  completePasswordResetOp,
  requestPasswordResetOp,
} = await import("@/lib/password-reset");
const { buildPasswordResetEmail } = await import("@/lib/password-reset-mail");
const {
  passwordResetIdempotencyKey,
  transactionalEmailFailureMessage,
} = await import("@/lib/mail");
const { isPublicWebsitePath } = await import("@/lib/public-website-paths");
const {
  CAPABILITIES,
  roleHasCapability,
} = await import("@/lib/authorization");

const require = createRequire(import.meta.url);

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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

function makeMailer(opts = {}) {
  const sends = [];
  const errors = [];
  return {
    sends,
    errors,
    getMailConfig: () =>
      opts.configured === false
        ? { error: "Email delivery is not configured" }
        : {
            apiKey: "re_test",
            fromAddress: "tbbt@example.com",
            appUrl: "https://app.example.test",
          },
    getAppUrl: () => (opts.configured === false ? null : "https://app.example.test"),
    sendTransactionalEmail: async (input) => {
      sends.push(input);
      if (opts.sendError) return { error: opts.sendError };
      return { id: "msg_test" };
    },
    logError: (message) => {
      errors.push(message);
    },
  };
}

function rawTokenFromSend(send) {
  const match = String(send?.text || "").match(/\/reset-password\/([0-9a-f]{64})/i);
  return match?.[1] ?? null;
}

const schemaSrc = readRepo("prisma/schema.prisma");
const resetOpSrc = readRepo("src/lib/password-reset.ts");
const resetActionSrc = readRepo("src/app/actions/password-reset.ts");
const changeActionSrc = readRepo("src/app/actions/change-password.ts");
const signInFormSrc = readRepo("src/components/auth/sign-in-form.tsx");
const proxySrc = readRepo("src/proxy.ts");
const resetPageSrc = readRepo("src/app/reset-password/[token]/page.tsx");
const settingsWorkspaceSrc = readRepo("src/components/settings/settings-workspace.tsx");

console.log("\nSTATIC — reuse hashed-token model and public surfaces");
check(
  "PasswordResetToken stores tokenHash, not a raw token column",
  schemaSrc.includes("model PasswordResetToken") &&
    schemaSrc.includes("tokenHash String    @unique") &&
    !/model PasswordResetToken \{[^}]*\n\s+token\s+String/m.test(schemaSrc),
);
check(
  "Reset ops hash tokens with hashToken / createSecureToken",
  resetOpSrc.includes("hashToken(rawToken)") &&
    resetOpSrc.includes("createSecureToken()") &&
    resetOpSrc.includes("hashPassword(password)"),
);
check("Forgot password is linked from sign-in", signInFormSrc.includes('href="/forgot-password"') && signInFormSrc.includes("Forgot password?"));
check("Forgot-password is an auth path", proxySrc.includes('"/forgot-password"'));
check("Reset-password URLs are public like set-password", isPublicWebsitePath("/reset-password/abc") && isPublicWebsitePath("/set-password/abc"));
check("Reset URL builder has no business or tenant id", resetOpSrc.includes("/reset-password/${rawToken}") && !resetOpSrc.includes("businessId"));
check(
  "Reset page does not load business or tenant fields",
  resetPageSrc.includes("lookupUsablePasswordResetToken") &&
    !resetPageSrc.includes("prisma.business") &&
    !resetPageSrc.includes("memberships") &&
    !resetPageSrc.includes("businessId"),
);
check(
  "Change-password action uses the session user, not a client userId",
  changeActionSrc.includes("getSessionUser()") &&
    !changeActionSrc.includes('readString(formData, "userId")'),
);
check(
  "Settings security section hosts ChangePasswordForm",
  settingsWorkspaceSrc.includes("ChangePasswordForm") &&
    settingsWorkspaceSrc.includes("Change the password on the signed-in account"),
);
check(
  "Password-reset mail kind has a specific failure message",
  transactionalEmailFailureMessage("password-reset") ===
    "The password reset email could not be sent.",
);
check(
  "Idempotency key is user + token id, not the raw token",
  passwordResetIdempotencyKey("user_1", "tok_1") === "password-reset/user_1/tok_1",
);
check("Reset token lifetime is 1 hour", PASSWORD_RESET_EXPIRY_MS === 60 * 60 * 1000);
check("Repeat requests are cooled down for 1 minute", PASSWORD_RESET_COOLDOWN_MS === 60 * 1000);
check(
  "Ops do not log passwords or raw tokens",
  !/console\.(log|error|info|warn)\([^)]*(password|rawToken|token)/i.test(resetOpSrc) &&
    !/console\.(log|error|info|warn)\([^)]*password/i.test(changeActionSrc) &&
    !/console\.(log|error|info|warn)\([^)]*token/i.test(resetActionSrc),
);
check(
  "Reset consumes the token atomically inside the password-write transaction",
  resetOpSrc.includes("claimed.count !== 1") &&
    /updateMany\([\s\S]*tokenHash[\s\S]*usedAt:\s*null[\s\S]*expiresAt:/.test(resetOpSrc) &&
    resetOpSrc.indexOf("passwordResetToken.updateMany") < resetOpSrc.indexOf("tx.user.update") &&
    !/const resetToken = await db\.passwordResetToken\.findUnique/.test(resetOpSrc),
);
check(
  "Successful reset revokes existing sessions inside the same transaction",
  resetOpSrc.includes("session.deleteMany") &&
    resetOpSrc.indexOf("passwordResetToken.updateMany") < resetOpSrc.indexOf("session.deleteMany") &&
    resetOpSrc.indexOf("tx.user.update") < resetOpSrc.indexOf("session.deleteMany"),
);
check(
  "Recovery action creates the fresh session only after a successful reset",
  resetActionSrc.indexOf("completePasswordResetOp") < resetActionSrc.indexOf("createSession") &&
    resetActionSrc.includes("if (!result.ok)") &&
    resetActionSrc.indexOf("if (!result.ok)") < resetActionSrc.indexOf("createSession"),
);
check(
  "Signed-in change password does not revoke sessions",
  !changeActionSrc.includes("session.delete") &&
    !resetOpSrc.slice(resetOpSrc.indexOf("changeSignedInPasswordOp")).includes("session.deleteMany"),
);

const resetEmail = buildPasswordResetEmail({
  resetUrl: "https://app.example.test/reset-password/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});
check(
  "Recovery email is a clear transactional reset, not a team invite",
  resetEmail.subject === "Reset your TBBT password" &&
    resetEmail.text.includes("Reset your TBBT password") &&
    resetEmail.text.includes("/reset-password/") &&
    !resetEmail.text.includes("/set-password/") &&
    !resetEmail.text.includes("businessId") &&
    resetEmail.text.includes("expires in 1 hour"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_password_recovery_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for password-recovery test database.");
  process.exit(push.status ?? 1);
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

async function snapshotAuthz(userId, businessId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      isFounder: true,
      passwordHash: true,
    },
  });
  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      businessId: true,
      role: true,
      active: true,
    },
  });
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      slug: true,
      tradeCode: true,
    },
  });
  const saas = await prisma.businessSaasSubscription.findUnique({
    where: { businessId },
    select: {
      id: true,
      businessId: true,
      status: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      founderEligible: true,
      trialStartedAt: true,
      trialEndsAt: true,
      legacyExempt: true,
    },
  });
  return { user, memberships, business, saas };
}

try {
  const suffix = randomUUID().slice(0, 8);
  const business = await prisma.business.create({
    data: { name: "Reset Handyman", slug: `reset-handyman-${suffix}`, tradeCode: "HANDYMAN" },
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: business.id,
      status: "trialing",
      founderEligible: true,
      trialStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      trialEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      stripeCustomerId: "cus_keep",
      stripeSubscriptionId: "sub_keep",
    },
  });

  const ownerPassword = "owner-old-pass";
  const adminPassword = "admin-old-pass";
  const memberPassword = "member-old-pass";

  const owner = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-reset-${suffix}@example.com`,
      passwordHash: await hashPassword(ownerPassword),
    },
  });
  const admin = await prisma.user.create({
    data: {
      name: "Amir Admin",
      email: `admin-reset-${suffix}@example.com`,
      passwordHash: await hashPassword(adminPassword),
    },
  });
  const member = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `member-reset-${suffix}@example.com`,
      passwordHash: await hashPassword(memberPassword),
    },
  });
  await prisma.membership.create({
    data: { userId: owner.id, businessId: business.id, role: "OWNER" },
  });
  await prisma.membership.create({
    data: { userId: admin.id, businessId: business.id, role: "ADMIN" },
  });
  await prisma.membership.create({
    data: { userId: member.id, businessId: business.id, role: "MEMBER" },
  });

  console.log("\nTEST — unknown email matches the public response and creates no token");
  const unknownMailer = makeMailer();
  const unknownResult = await requestPasswordResetOp(
    prisma,
    `nobody-${suffix}@example.com`,
    unknownMailer,
  );
  const knownMailer = makeMailer();
  const knownResult = await requestPasswordResetOp(prisma, owner.email, knownMailer);
  check(
    "Existing email gets the generic public response",
    knownResult.message === PASSWORD_RESET_REQUEST_MESSAGE &&
      knownResult.outcome === "sent",
  );
  check(
    "Unknown email gets the same public response",
    unknownResult.message === PASSWORD_RESET_REQUEST_MESSAGE &&
      unknownResult.message === knownResult.message &&
      unknownResult.outcome === "unknown-email",
  );
  check("Unknown email does not send mail", unknownMailer.sends.length === 0);
  check(
    "Unknown email does not create a reset token",
    (await prisma.passwordResetToken.count()) === 1,
  );

  console.log("\nTEST — existing email issues a hashed, mailed reset token");
  const rawOwnerToken = rawTokenFromSend(knownMailer.sends[0]);
  const storedOwnerToken = await prisma.passwordResetToken.findFirst({
    where: { userId: owner.id },
  });
  check("Existing email sends exactly one reset email", knownMailer.sends.length === 1);
  check(
    "Reset email is password-reset kind to the matching user",
    knownMailer.sends[0]?.kind === "password-reset" &&
      knownMailer.sends[0]?.to === owner.email &&
      !String(knownMailer.sends[0]?.text).includes(business.id) &&
      !String(knownMailer.sends[0]?.html).includes(business.id),
  );
  check("Mailed link contains a 64-char token and no tenant id", Boolean(rawOwnerToken));
  check(
    "Token is hashed at rest",
    Boolean(storedOwnerToken) &&
      storedOwnerToken.tokenHash === hashToken(rawOwnerToken) &&
      storedOwnerToken.tokenHash !== rawOwnerToken &&
      storedOwnerToken.tokenHash.length === 64,
  );
  check(
    "Raw token is not stored on the row",
    storedOwnerToken.tokenHash !== rawOwnerToken &&
      !JSON.stringify(storedOwnerToken).includes(rawOwnerToken),
  );

  console.log("\nTEST — mail-unconfigured returns the same public response and creates no token");
  const unconfigured = makeMailer({ configured: false });
  const unconfiguredResult = await requestPasswordResetOp(prisma, admin.email, unconfigured);
  check(
    "Unconfigured mail returns the generic public response",
    unconfiguredResult.message === PASSWORD_RESET_REQUEST_MESSAGE &&
      unconfiguredResult.outcome === "mail-unconfigured",
  );
  check("Unconfigured mail does not send", unconfigured.sends.length === 0);
  check(
    "Unconfigured mail logs an operational error without revealing the account",
    unconfigured.errors.some((line) => /Email delivery is not configured/i.test(line)) &&
      !unconfigured.errors.some((line) => line.includes(admin.email)),
  );
  check(
    "Unconfigured mail creates no admin reset token",
    (await prisma.passwordResetToken.count({ where: { userId: admin.id } })) === 0,
  );

  console.log("\nTEST — cooldown protects repeated requests");
  const cooldownMailer = makeMailer();
  const second = await requestPasswordResetOp(prisma, owner.email, cooldownMailer);
  check(
    "Immediate repeat request is generic and not a new send",
    second.message === PASSWORD_RESET_REQUEST_MESSAGE &&
      second.outcome === "cooldown" &&
      cooldownMailer.sends.length === 0,
  );
  check(
    "Cooldown leaves the original unused token in place",
    (await prisma.passwordResetToken.count({ where: { userId: owner.id, usedAt: null } })) === 1,
  );

  console.log("\nTEST — valid token resets the password; old password fails; token is single-use");
  const ownerBefore = await snapshotAuthz(owner.id, business.id);
  const ownerNewPassword = "owner-new-pass";
  const resetOk = await completePasswordResetOp(prisma, {
    token: rawOwnerToken,
    password: ownerNewPassword,
    confirmPassword: ownerNewPassword,
  });
  const ownerAfterReset = await prisma.user.findUnique({ where: { id: owner.id } });
  check("Valid token resets password", resetOk.ok === true && resetOk.userId === owner.id);
  check(
    "Old password no longer authenticates after reset",
    (await verifyPassword(ownerPassword, ownerAfterReset.passwordHash)) === false,
  );
  check(
    "New password authenticates after reset",
    (await verifyPassword(ownerNewPassword, ownerAfterReset.passwordHash)) === true,
  );
  const reused = await completePasswordResetOp(prisma, {
    token: rawOwnerToken,
    password: "another-new-pass",
    confirmPassword: "another-new-pass",
  });
  check(
    "Used token is rejected",
    reused.ok === false && reused.error === PASSWORD_RESET_TOKEN_ERROR,
  );
  check(
    "Replay does not change the already-reset password",
    (await verifyPassword(ownerNewPassword, (await prisma.user.findUnique({ where: { id: owner.id } })).passwordHash)) === true,
  );
  const ownerAfter = await snapshotAuthz(owner.id, business.id);
  check(
    "Reset does not alter role, business, or subscription state",
    ownerAfter.memberships[0].role === "OWNER" &&
      ownerAfter.memberships[0].businessId === business.id &&
      ownerAfter.business.slug === ownerBefore.business.slug &&
      ownerAfter.saas.status === ownerBefore.saas.status &&
      ownerAfter.saas.stripeCustomerId === "cus_keep" &&
      ownerAfter.saas.stripeSubscriptionId === "sub_keep" &&
      ownerAfter.saas.founderEligible === true &&
      ownerAfter.user.isFounder === ownerBefore.user.isFounder,
  );

  console.log("\nTEST — expired and malformed tokens are rejected");
  const expireMailer = makeMailer();
  const expireRequest = await requestPasswordResetOp(
    prisma,
    owner.email,
    expireMailer,
    new Date(Date.now() + PASSWORD_RESET_COOLDOWN_MS + 1000),
  );
  const expireRaw = rawTokenFromSend(expireMailer.sends[0]);
  check("A later request after cooldown issues a replacement token", expireRequest.outcome === "sent" && Boolean(expireRaw));
  const expired = await completePasswordResetOp(
    prisma,
    {
      token: expireRaw,
      password: "expired-new-pass",
      confirmPassword: "expired-new-pass",
    },
    new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS + PASSWORD_RESET_COOLDOWN_MS + 5000),
  );
  check(
    "Expired token is rejected",
    expired.ok === false && expired.error === PASSWORD_RESET_TOKEN_ERROR,
  );
  check(
    "Expired token did not change the current password",
    (await verifyPassword(ownerNewPassword, (await prisma.user.findUnique({ where: { id: owner.id } })).passwordHash)) === true,
  );

  for (const bad of ["", "not-a-token", "abc", "zzzz", owner.id, business.id, `${owner.id}/${business.id}`]) {
    const malformed = await completePasswordResetOp(prisma, {
      token: bad,
      password: "malformed-new",
      confirmPassword: "malformed-new",
    });
    check(
      `Malformed token ${JSON.stringify(bad) || "(empty)"} is rejected`,
      malformed.ok === false && malformed.error === PASSWORD_RESET_TOKEN_ERROR,
    );
  }

  console.log("\nTEST — concurrent submissions of the same token claim it once");
  const racerPassword = "racer-old-pass";
  const racer = await prisma.user.create({
    data: {
      name: "Riley Racer",
      email: `racer-reset-${suffix}@example.com`,
      passwordHash: await hashPassword(racerPassword),
    },
  });
  await prisma.membership.create({
    data: { userId: racer.id, businessId: business.id, role: "OWNER" },
  });
  const racerMailer = makeMailer();
  const racerRequest = await requestPasswordResetOp(prisma, racer.email, racerMailer);
  const racerRaw = rawTokenFromSend(racerMailer.sends[0]);
  check("Racer received a usable reset token", racerRequest.outcome === "sent" && Boolean(racerRaw));
  const [firstRace, secondRace] = await Promise.all([
    completePasswordResetOp(prisma, {
      token: racerRaw,
      password: "racer-win-pass-1",
      confirmPassword: "racer-win-pass-1",
    }),
    completePasswordResetOp(prisma, {
      token: racerRaw,
      password: "racer-win-pass-2",
      confirmPassword: "racer-win-pass-2",
    }),
  ]);
  const raceWins = [firstRace, secondRace].filter((result) => result.ok);
  const raceFails = [firstRace, secondRace].filter((result) => !result.ok);
  check("Exactly one concurrent reset succeeds", raceWins.length === 1 && raceWins[0].userId === racer.id);
  check(
    "Exactly one concurrent reset fails with the generic token error",
    raceFails.length === 1 && raceFails[0].error === PASSWORD_RESET_TOKEN_ERROR,
  );
  const racerAfter = await prisma.user.findUnique({ where: { id: racer.id } });
  const winningPassword = firstRace.ok ? "racer-win-pass-1" : "racer-win-pass-2";
  const losingPassword = firstRace.ok ? "racer-win-pass-2" : "racer-win-pass-1";
  check(
    "Only the winning password authenticates",
    (await verifyPassword(winningPassword, racerAfter.passwordHash)) === true &&
      (await verifyPassword(losingPassword, racerAfter.passwordHash)) === false &&
      (await verifyPassword(racerPassword, racerAfter.passwordHash)) === false,
  );
  const racerToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(racerRaw) },
  });
  check(
    "The raced token remains single-use",
    Boolean(racerToken?.usedAt) &&
      (await prisma.passwordResetToken.count({ where: { userId: racer.id, usedAt: null } })) === 0,
  );
  const racedReplay = await completePasswordResetOp(prisma, {
    token: racerRaw,
    password: "racer-replay-pass",
    confirmPassword: "racer-replay-pass",
  });
  check(
    "A later replay of the raced token is still the generic error",
    racedReplay.ok === false && racedReplay.error === PASSWORD_RESET_TOKEN_ERROR,
  );

  console.log("\nTEST — successful reset revokes old sessions; failed reset does not");
  async function createSessionRow(userId) {
    const tokenHash = hashToken(`${userId}:${randomUUID()}`);
    await prisma.session.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return tokenHash;
  }
  const sessionUserPassword = "session-old-pass";
  const sessionUser = await prisma.user.create({
    data: {
      name: "Seth Session",
      email: `session-reset-${suffix}@example.com`,
      passwordHash: await hashPassword(sessionUserPassword),
    },
  });
  await prisma.membership.create({
    data: { userId: sessionUser.id, businessId: business.id, role: "OWNER" },
  });
  const bystander = await prisma.user.create({
    data: {
      name: "Bea Bystander",
      email: `bystander-reset-${suffix}@example.com`,
      passwordHash: await hashPassword("bystander-pass"),
    },
  });
  const oldSessionHashes = [
    await createSessionRow(sessionUser.id),
    await createSessionRow(sessionUser.id),
  ];
  const bystanderSessionHash = await createSessionRow(bystander.id);
  check(
    "User has multiple active sessions before reset",
    (await prisma.session.count({ where: { userId: sessionUser.id } })) === 2,
  );
  const sessionMailer = makeMailer();
  const sessionRequest = await requestPasswordResetOp(prisma, sessionUser.email, sessionMailer);
  const sessionRaw = rawTokenFromSend(sessionMailer.sends[0]);
  check("Session user received a usable reset token", sessionRequest.outcome === "sent" && Boolean(sessionRaw));
  const invalidWhileSessionsLive = await completePasswordResetOp(prisma, {
    token: "not-a-token",
    password: "session-new-pass",
    confirmPassword: "session-new-pass",
  });
  check(
    "Invalid reset does not remove valid sessions",
    invalidWhileSessionsLive.ok === false &&
      invalidWhileSessionsLive.error === PASSWORD_RESET_TOKEN_ERROR &&
      (await prisma.session.count({ where: { userId: sessionUser.id } })) === 2 &&
      (await prisma.session.count({ where: { tokenHash: { in: oldSessionHashes } } })) === 2,
  );
  const sessionReset = await completePasswordResetOp(prisma, {
    token: sessionRaw,
    password: "session-new-pass",
    confirmPassword: "session-new-pass",
  });
  check("Successful forgot-password reset still succeeds", sessionReset.ok === true);
  check(
    "Successful reset removes all old sessions for that user",
    (await prisma.session.count({ where: { userId: sessionUser.id } })) === 0 &&
      (await prisma.session.count({ where: { tokenHash: { in: oldSessionHashes } } })) === 0,
  );
  check(
    "Reset does not revoke another user's sessions",
    (await prisma.session.count({ where: { tokenHash: bystanderSessionHash } })) === 1,
  );
  const recoverySessionHash = hashToken(`recovery:${sessionUser.id}:${randomUUID()}`);
  await prisma.session.create({
    data: {
      userId: sessionUser.id,
      tokenHash: recoverySessionHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  check(
    "Recovery flow creates only the new post-reset session afterward",
    (await prisma.session.count({ where: { userId: sessionUser.id } })) === 1 &&
      (await prisma.session.findUnique({ where: { tokenHash: recoverySessionHash } })) !== null,
  );
  const reusedAfterSessionReset = await completePasswordResetOp(prisma, {
    token: sessionRaw,
    password: "session-replay-pass",
    confirmPassword: "session-replay-pass",
  });
  check(
    "Reused reset does not remove the new recovery session",
    reusedAfterSessionReset.ok === false &&
      reusedAfterSessionReset.error === PASSWORD_RESET_TOKEN_ERROR &&
      (await prisma.session.count({ where: { userId: sessionUser.id } })) === 1 &&
      (await prisma.session.findUnique({ where: { tokenHash: recoverySessionHash } })) !== null,
  );

  console.log("\nTEST — MEMBER / ADMIN / OWNER can recover their own password without authz changes");
  for (const account of [
    { user: admin, role: "ADMIN", oldPassword: adminPassword, nextPassword: "admin-new-pass" },
    { user: member, role: "MEMBER", oldPassword: memberPassword, nextPassword: "member-new-pass" },
  ]) {
    const mailer = makeMailer();
    const requested = await requestPasswordResetOp(prisma, account.user.email, mailer);
    const raw = rawTokenFromSend(mailer.sends[0]);
    const before = await snapshotAuthz(account.user.id, business.id);
    const completed = await completePasswordResetOp(prisma, {
      token: raw,
      password: account.nextPassword,
      confirmPassword: account.nextPassword,
    });
    const after = await snapshotAuthz(account.user.id, business.id);
    check(
      `${account.role} can request and complete their own reset`,
      requested.outcome === "sent" && completed.ok === true && Boolean(raw),
    );
    check(
      `${account.role} old password no longer authenticates`,
      (await verifyPassword(account.oldPassword, after.user.passwordHash)) === false,
    );
    check(
      `${account.role} new password authenticates`,
      (await verifyPassword(account.nextPassword, after.user.passwordHash)) === true,
    );
    check(
      `${account.role} membership / tenant / subscription stay unchanged`,
      after.memberships[0].role === account.role &&
        after.memberships[0].businessId === before.memberships[0].businessId &&
        after.memberships[0].active === true &&
        after.saas.stripeCustomerId === before.saas.stripeCustomerId &&
        after.saas.status === before.saas.status,
    );
  }
  check("MEMBER still cannot manage settings after recovery", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_SETTINGS));
  check("ADMIN still can manage settings after recovery", roleHasCapability("ADMIN", CAPABILITIES.MANAGE_SETTINGS));
  check("OWNER still can manage settings after recovery", roleHasCapability("OWNER", CAPABILITIES.MANAGE_SETTINGS));

  console.log("\nTEST — signed-in change password requires the current password");
  const changeSessionHash = await createSessionRow(owner.id);
  const changeBefore = await snapshotAuthz(owner.id, business.id);
  const wrongCurrent = await changeSignedInPasswordOp(prisma, {
    userId: owner.id,
    currentPassword: "definitely-wrong",
    newPassword: "owner-changed-pass",
    confirmPassword: "owner-changed-pass",
  });
  check(
    "Wrong current password is rejected",
    wrongCurrent.ok === false && wrongCurrent.error === "Current password is incorrect.",
  );
  check(
    "Rejected change leaves the existing password in place",
    (await verifyPassword(ownerNewPassword, (await prisma.user.findUnique({ where: { id: owner.id } })).passwordHash)) === true,
  );

  const missingCurrent = await changeSignedInPasswordOp(prisma, {
    userId: owner.id,
    currentPassword: "",
    newPassword: "owner-changed-pass",
    confirmPassword: "owner-changed-pass",
  });
  check(
    "Change password requires the current password",
    missingCurrent.ok === false &&
      missingCurrent.error === "Current password and new password are required.",
  );

  const changed = await changeSignedInPasswordOp(prisma, {
    userId: owner.id,
    currentPassword: ownerNewPassword,
    newPassword: "owner-changed-pass",
    confirmPassword: "owner-changed-pass",
  });
  const changeAfter = await snapshotAuthz(owner.id, business.id);
  check("Signed-in change succeeds with the current password", changed.ok === true);
  check(
    "Changed password authenticates and the previous one does not",
    (await verifyPassword("owner-changed-pass", changeAfter.user.passwordHash)) === true &&
      (await verifyPassword(ownerNewPassword, changeAfter.user.passwordHash)) === false,
  );
  check(
    "Signed-in change password leaves existing sessions in place",
    (await prisma.session.findUnique({ where: { tokenHash: changeSessionHash } })) !== null,
  );
  check(
    "Change password does not alter role / business / tenant / subscription state",
    changeAfter.memberships[0].role === "OWNER" &&
      changeAfter.memberships[0].id === changeBefore.memberships[0].id &&
      changeAfter.memberships[0].businessId === changeBefore.memberships[0].businessId &&
      changeAfter.business.id === changeBefore.business.id &&
      changeAfter.business.slug === changeBefore.business.slug &&
      changeAfter.saas.id === changeBefore.saas.id &&
      changeAfter.saas.status === changeBefore.saas.status &&
      changeAfter.saas.stripeCustomerId === changeBefore.saas.stripeCustomerId &&
      changeAfter.saas.stripeSubscriptionId === changeBefore.saas.stripeSubscriptionId &&
      changeAfter.saas.trialEndsAt?.toISOString() === changeBefore.saas.trialEndsAt?.toISOString() &&
      changeAfter.user.email === changeBefore.user.email &&
      changeAfter.user.isFounder === changeBefore.user.isFounder,
  );

  const memberChange = await changeSignedInPasswordOp(prisma, {
    userId: member.id,
    currentPassword: "member-new-pass",
    newPassword: "member-changed-pass",
    confirmPassword: "member-changed-pass",
  });
  check(
    "MEMBER can change their own signed-in password without a role change",
    memberChange.ok === true &&
      (await prisma.membership.findFirst({ where: { userId: member.id } })).role === "MEMBER",
  );
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
