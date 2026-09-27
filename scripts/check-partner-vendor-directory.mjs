/**
 * Partner / vendor opportunity directory — authorization and isolation.
 *
 * Imports the REAL production helpers. Uses a dedicated sibling Postgres
 * database. Proves foreign-business Supplier / Referral / opportunity
 * rows cannot be read or linked.
 *
 * Run with:
 *   npm run test:partner-vendor-directory
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, canAccessManagementConsole } = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  DIRECTORY_LIMITS_MESSAGE,
  DIRECTORY_LINK_MESSAGE,
  DIRECTORY_ROUTE,
  DIRECTORY_SEARCH_MESSAGE,
  FORBIDDEN_DIRECTORY_CLAIM_PATTERNS,
  PartnerVendorDirectoryError,
  createPartnerVendorOpportunity,
  loadPartnerVendorDirectory,
  matchesDirectorySearch,
  needsDirectoryReview,
  parseDirectoryKindFilter,
  partnerVendorDirectoryRoleAllowed,
  requirePartnerVendorDirectoryAccess,
  reviewPartnerVendorOpportunity,
  updatePartnerVendorOpportunity,
} = await import("@/lib/partner-vendor-directory");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_partner_vendor_directory_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for partner-vendor-directory test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
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

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

try {
  console.log("\nSTATIC — Domain helpers and honesty limits");
  check("Invalid kind filter falls back to all", parseDirectoryKindFilter("marketplace") === "all");
  check("Pending review needs review", needsDirectoryReview("PENDING_REVIEW"));
  check("Reviewed does not need review", needsDirectoryReview("REVIEWED") === false);
  check("Search matches name", matchesDirectorySearch(["Acme Lumber", "notes"], "lumber"));
  check("Search matches linked supplier", matchesDirectorySearch(["title", null, "Home Depot"], "depot"));
  check("Empty search matches", matchesDirectorySearch(["x"], ""));
  check(
    "Limits message denies marketplace, inventory, affiliate, and Network membership",
    /not an external marketplace/.test(DIRECTORY_LIMITS_MESSAGE) &&
      /not live supplier inventory/.test(DIRECTORY_LIMITS_MESSAGE) &&
      /not an affiliate payout/.test(DIRECTORY_LIMITS_MESSAGE) &&
      /not BSOS Network membership/.test(DIRECTORY_LIMITS_MESSAGE),
  );
  check("Search message stays tenant-scoped", /this workspace/.test(DIRECTORY_SEARCH_MESSAGE));
  check("Link message forbids foreign rows", /Foreign-business rows cannot be read or linked/.test(DIRECTORY_LINK_MESSAGE));

  const copyFiles = [
    "src/lib/partner-vendor-directory/ops.ts",
    "src/lib/partner-vendor-directory/load.ts",
    "src/app/(app)/partner-vendor-directory/page.tsx",
    "src/components/partner-vendor-directory/workspace.tsx",
    "src/components/partner-vendor-directory/create-form.tsx",
    "src/components/partner-vendor-directory/review-form.tsx",
    "src/app/actions/partner-vendor-directory.ts",
  ];
  const moduleText = copyFiles.map((path) => readRepo(path)).join("\n");
  for (const pattern of FORBIDDEN_DIRECTORY_CLAIM_PATTERNS) {
    check(`User-facing copy does not claim ${pattern}`, !pattern.test(moduleText));
  }
  check(
    "Page and workspace surface the recorded limits",
    /DIRECTORY_LIMITS_MESSAGE/.test(readRepo("src/app/(app)/partner-vendor-directory/page.tsx")) &&
      /workspace\.limitsMessage/.test(readRepo("src/components/partner-vendor-directory/workspace.tsx")),
  );

  const navSrc = readRepo("src/lib/nav.ts");
  check("Global nav does not list the directory", !navSrc.includes(DIRECTORY_ROUTE));
  check("OWNER sidebar still omits the directory", !visibleAppNav("OWNER").some((item) => item.href === DIRECTORY_ROUTE));
  check("ADMIN sidebar still omits the directory", !visibleAppNav("ADMIN").some((item) => item.href === DIRECTORY_ROUTE));

  const pageSrc = readRepo("src/app/(app)/partner-vendor-directory/page.tsx");
  check(
    "Page requires management access before loading",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.includes("requirePartnerVendorDirectoryAccess(access)") &&
      pageSrc.includes("loadPartnerVendorDirectory(prisma, access, params)"),
  );

  const actionSrc = readRepo("src/app/actions/partner-vendor-directory.ts");
  check(
    "Actions never accept a client businessId",
    actionSrc.includes("requireOperatingBusinessAccess()") &&
      !actionSrc.includes('readString(formData, "businessId")'),
  );

  check("OWNER may use the directory", partnerVendorDirectoryRoleAllowed("OWNER"));
  check("ADMIN may use the directory", partnerVendorDirectoryRoleAllowed("ADMIN"));
  check("MEMBER cannot use the directory", partnerVendorDirectoryRoleAllowed("MEMBER") === false);
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);

  const businessA = await prisma.business.create({
    data: { name: "Alpha Directory", slug: `alpha-dir-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Directory", slug: `beta-dir-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-dir-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-dir-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-dir-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-dir-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const supplierA = await prisma.supplier.create({
    data: { businessId: businessA.id, name: "Alpha Lumber", preferred: true },
  });
  const supplierB = await prisma.supplier.create({
    data: { businessId: businessB.id, name: "Beta Secret Supplier" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret Customer" },
  });
  const referralA = await prisma.referral.create({
    data: { businessId: businessA.id, sourceCustomerId: customerA.id, notes: "Neighbor intro" },
  });
  const referralB = await prisma.referral.create({
    data: { businessId: businessB.id, sourceCustomerId: customerB.id, notes: "Secret intro" },
  });

  console.log("\nTEST — Authorization");
  await expectError(
    "MEMBER cannot pass the directory access gate",
    () => {
      requirePartnerVendorDirectoryAccess(memberA);
    },
    (error) => error instanceof ForbiddenError,
  );
  requirePartnerVendorDirectoryAccess(ownerA);
  requirePartnerVendorDirectoryAccess(adminA);
  check("OWNER and ADMIN pass the directory access gate", true);

  await expectError(
    "MEMBER cannot create an opportunity",
    () =>
      createPartnerVendorOpportunity(prisma, memberA, {
        kind: "VENDOR",
        name: "Member leak",
        source: "MANUAL",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot load the directory",
    () => loadPartnerVendorDirectory(prisma, memberA, {}),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nTEST — Create, search, and manual review");
  const manual = await createPartnerVendorOpportunity(prisma, ownerA, {
    kind: "PARTNER",
    name: "Local electrician",
    summary: "Possible overflow partner for electrical call-outs",
    notes: "Met at the supply house",
    category: "Electrical",
    source: "MANUAL",
  });
  check("Manual opportunity is scoped to business A", manual.businessId === businessA.id);
  check("Manual source persists", manual.source === "MANUAL");
  check("New opportunity starts pending review", manual.reviewStatus === "PENDING_REVIEW");
  check("Created-by membership is the owner", manual.createdByMembershipId === ownerMem.id);

  const fromSupplier = await createPartnerVendorOpportunity(prisma, adminA, {
    kind: "VENDOR",
    source: "SUPPLIER",
    supplierId: supplierA.id,
    summary: "Reuse the existing lumber supplier record",
  });
  check("Supplier-sourced name reuses the owned supplier", fromSupplier.name === "Alpha Lumber");
  check("Supplier id is the same-business row", fromSupplier.supplierId === supplierA.id);
  check("Supplier-sourced row stays on business A", fromSupplier.businessId === businessA.id);
  check("Admin can record an opportunity", fromSupplier.createdByMembershipId === adminMem.id);

  const fromReferral = await createPartnerVendorOpportunity(prisma, ownerA, {
    kind: "PARTNER",
    source: "REFERRAL",
    referralId: referralA.id,
    notes: "Owner wants to remember this introduction",
  });
  check("Referral-sourced name uses the owned customer", fromReferral.name === "Referral from Ada Homeowner");
  check("Referral id is the same-business row", fromReferral.referralId === referralA.id);

  const searched = await loadPartnerVendorDirectory(prisma, ownerA, { q: "lumber" });
  check("Search finds the supplier-linked opportunity", searched.opportunities.some((row) => row.id === fromSupplier.id));
  check("Search does not invent extra rows", searched.opportunities.every((row) => row.id !== fromReferral.id || /lumber/i.test(row.name)));
  check(
    "Search haystacks stay on this business",
    searched.opportunities.every((row) => !/Beta Secret/i.test(`${row.name} ${row.supplierName ?? ""} ${row.referralLabel ?? ""}`)),
  );

  const reviewed = await reviewPartnerVendorOpportunity(prisma, adminA, {
    opportunityId: fromSupplier.id,
    reviewStatus: "REVIEWED",
    reviewNotes: "Confirmed as this business's lumber vendor note",
  });
  check("Manual review persists REVIEWED", reviewed.reviewStatus === "REVIEWED");
  check("Reviewer membership is recorded", reviewed.lastReviewedByMembershipId === adminMem.id);
  check("Review notes persist", reviewed.reviewNotes === "Confirmed as this business's lumber vendor note");

  const pendingOnly = await loadPartnerVendorDirectory(prisma, ownerA, { review: "PENDING_REVIEW" });
  check("Review filter hides reviewed rows", pendingOnly.opportunities.every((row) => row.reviewStatus === "PENDING_REVIEW"));
  check("Review filter still includes the unreviewed partner", pendingOnly.opportunities.some((row) => row.id === manual.id));

  console.log("\nTEST — Foreign-business records cannot be read or linked");
  await expectError(
    "Cannot link a foreign-business supplier",
    () =>
      createPartnerVendorOpportunity(prisma, ownerA, {
        kind: "VENDOR",
        source: "SUPPLIER",
        supplierId: supplierB.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Cannot link a foreign-business referral",
    () =>
      createPartnerVendorOpportunity(prisma, ownerA, {
        kind: "PARTNER",
        source: "REFERRAL",
        referralId: referralB.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Manual source cannot smuggle a foreign supplier id",
    () =>
      createPartnerVendorOpportunity(prisma, ownerA, {
        kind: "VENDOR",
        name: "Smuggle",
        source: "MANUAL",
        supplierId: supplierB.id,
      }),
    (error) => error instanceof PartnerVendorDirectoryError,
  );
  await expectError(
    "Business B cannot review business A's opportunity",
    () =>
      reviewPartnerVendorOpportunity(prisma, ownerB, {
        opportunityId: manual.id,
        reviewStatus: "REVIEWED",
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business B cannot update business A's opportunity",
    () =>
      updatePartnerVendorOpportunity(prisma, ownerB, {
        opportunityId: fromSupplier.id,
        kind: "VENDOR",
        name: "Hijacked",
        source: "SUPPLIER",
        supplierId: supplierB.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business A cannot retarget an owned row onto a foreign supplier",
    () =>
      updatePartnerVendorOpportunity(prisma, ownerA, {
        opportunityId: fromSupplier.id,
        kind: "VENDOR",
        source: "SUPPLIER",
        supplierId: supplierB.id,
      }),
    (error) => error instanceof Error,
  );

  const loadedB = await loadPartnerVendorDirectory(prisma, ownerB, { q: "Alpha" });
  check("Business B load does not return A's opportunities", loadedB.opportunities.length === 0);
  check(
    "Business B cannot see A's suppliers as linkable",
    loadedB.linkableSuppliers.every((row) => row.id !== supplierA.id) &&
      !loadedB.linkableSuppliers.some((row) => /Alpha Lumber/i.test(row.name)),
  );
  check(
    "Business B cannot see A's referrals as linkable",
    loadedB.linkableReferrals.every((row) => row.id !== referralA.id) &&
      !loadedB.linkableReferrals.some((row) => /Ada Homeowner/i.test(row.label)),
  );

  const loadedA = await loadPartnerVendorDirectory(prisma, ownerA, {});
  check(
    "Business A load never includes B's secret supplier or referral",
    loadedA.linkableSuppliers.every((row) => row.id !== supplierB.id) &&
      loadedA.linkableReferrals.every((row) => row.id !== referralB.id) &&
      loadedA.opportunities.every((row) => !/Beta Secret/i.test(`${row.name} ${row.supplierName ?? ""} ${row.referralLabel ?? ""}`)),
  );
  check("Business A still sees its own supplier as linkable", loadedA.linkableSuppliers.some((row) => row.id === supplierA.id));
  check("Business A still sees its own referral as linkable", loadedA.linkableReferrals.some((row) => row.id === referralA.id));

  const poisoned = await prisma.partnerVendorOpportunity.create({
    data: {
      businessId: businessA.id,
      kind: "VENDOR",
      name: "Poisoned link",
      source: "SUPPLIER",
      supplierId: supplierB.id,
      createdByMembershipId: ownerMem.id,
    },
  });
  const afterPoison = await loadPartnerVendorDirectory(prisma, ownerA, { q: "Poisoned" });
  const poisonedView = afterPoison.opportunities.find((row) => row.id === poisoned.id);
  check("Poisoned foreign supplier id does not leak B's supplier name", poisonedView?.supplierName == null);
  check("Poisoned foreign supplier id is not returned as a readable link", poisonedView?.supplierId == null);

  const afterPoisonB = await loadPartnerVendorDirectory(prisma, ownerB, { q: "Poisoned" });
  check("Business B still cannot read the poisoned A row", afterPoisonB.opportunities.length === 0);

  const leftover = await prisma.partnerVendorOpportunity.findMany({
    where: { businessId: businessB.id },
  });
  check("No directory rows were written into business B", leftover.length === 0);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("\nPartner / vendor directory authorization and isolation checks passed.");
