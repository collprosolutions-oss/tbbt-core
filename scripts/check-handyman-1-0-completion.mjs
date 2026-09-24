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
  createTotpSignInChallenge,
  verifyTotpSignInChallenge,
  revokeOtherSessionsOp,
} = await import("@/lib/account-security");
const { buildBusinessExportZip, isExportableField } = await import("@/lib/business-export");
const { transferBusinessOwnershipOp, OWNERSHIP_TRANSFER_CONFIRMATION } = await import(
  "@/lib/ownership-transfer"
);
const { requestBusinessOffboardingOp, OFFBOARDING_CONFIRMATION } = await import(
  "@/lib/offboarding"
);
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
  "Settings export copy no longer says ZIP is only planned",
  settingsSrc.includes("Download a tenant-scoped ZIP") ||
    settingsSrc.includes("Tenant-scoped ZIP export is available"),
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

  const started = await startTotpEnrollmentOp(prisma, {
    userId: ownerUser.id,
    accountName: ownerUser.email,
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

  await prisma.session.create({
    data: {
      tokenHash: hashToken("current-session"),
      userId: ownerUser.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const otherSession = await prisma.session.create({
    data: {
      tokenHash: hashToken("other-session"),
      userId: ownerUser.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const current = await prisma.session.findFirst({
    where: { tokenHash: hashToken("current-session") },
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
    });
  } catch {
    adminBlocked = true;
  }
  check("ADMIN cannot transfer ownership", adminBlocked);

  const transferred = await transferBusinessOwnershipOp(prisma, accessFor(owner, business), {
    targetMembershipId: admin.id,
    confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
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
  const offboarded = await requestBusinessOffboardingOp(prisma, accessFor(adminAfter, business), {
    confirmation: OFFBOARDING_CONFIRMATION,
    acknowledgedExport: true,
  });
  const customerCountAfter = await prisma.customer.count({ where: { businessId: business.id } });
  const businessAfter = await prisma.business.findUnique({ where: { id: business.id } });
  check("Offboarding does not delete customers", customerCountBefore === customerCountAfter && customerCountAfter === 1);
  check("Offboarding records a timestamp and does not claim deletion", Boolean(businessAfter.offboardingRequestedAt) && offboarded.recordsDeleted === false);
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
