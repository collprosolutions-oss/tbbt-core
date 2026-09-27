/**
 * OWNER-reviewed external lead import proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-external-lead-import.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for external lead import checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, requireBusinessRole } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  applySameBusinessDuplicates,
  BLOCKED_SOURCE_URL_MESSAGE,
  decodeCsvBytes,
  evaluateImportRow,
  EXTERNAL_LEAD_IMPORT_ROUTE,
  FILE_TOO_LARGE_MESSAGE,
  fetchOwnerSuppliedCsv,
  hashCsvBytes,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  importRowFingerprint,
  importRowSubmissionId,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  MAX_EXTERNAL_LEAD_IMPORT_ROWS,
  MISSING_NAME_HEADER_MESSAGE,
  OWNER_ONLY_IMPORT_MESSAGE,
  parseCsv,
  parseExternalLeadCsv,
  sanitizeImportText,
  sanitizeSourceFilename,
  SOURCE_URL_NOT_CSV_MESSAGE,
  TOO_MANY_ROWS_MESSAGE,
  validateOwnerSourceUrl,
} = await import("@/lib/external-lead-import");
const {
  confirmExternalLeadImport,
  loadOwnedImport,
  previewCsvUpload,
  previewOwnerSourceUrl,
} = await import("@/lib/external-lead-import-ops");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const featureFiles = [
  "src/lib/external-lead-import.ts",
  "src/lib/external-lead-import-ops.ts",
  "src/app/actions/external-lead-import.ts",
  "src/app/(app)/requests/import-leads/page.tsx",
  "src/app/(app)/requests/import-leads/[importId]/page.tsx",
  "src/components/requests/import-leads-form.tsx",
  "src/components/requests/import-leads-preview.tsx",
];
const featureSource = featureFiles.map(readSrc).join("\n");
const uiSource = [
  "src/app/(app)/requests/import-leads/page.tsx",
  "src/app/(app)/requests/import-leads/[importId]/page.tsx",
  "src/components/requests/import-leads-form.tsx",
  "src/components/requests/import-leads-preview.tsx",
]
  .map(readSrc)
  .join("\n");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_external_lead_import_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for external lead import test database.");
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
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function csv(rows) {
  return ["name,email,phone,summary,notes,street,city,region,postal,source", ...rows].join("\n");
}

try {
  console.log("\nSTATIC — bounds, wording, isolation of shared files");
  check("File bound is 256 KB", MAX_EXTERNAL_LEAD_IMPORT_BYTES === 256 * 1024);
  check("Row bound is 200", MAX_EXTERNAL_LEAD_IMPORT_ROWS === 200);
  check("Dedicated route is /requests/import-leads", EXTERNAL_LEAD_IMPORT_ROUTE === "/requests/import-leads");
  check("Owner-only copy is present", OWNER_ONLY_IMPORT_MESSAGE.includes("business owner"));
  check("No-scrape copy is present", /does not scrape/.test(IMPORT_NO_SCRAPE_MESSAGE));
  check("No-score copy is present", /does not invent a lead score/.test(IMPORT_NO_SCORE_MESSAGE));
  check("No-outreach copy is present", /does not send email, SMS/.test(IMPORT_NO_OUTREACH_MESSAGE));
  check(
    "Global nav does not add an import destination",
    APP_NAV.every((item) => item.href !== EXTERNAL_LEAD_IMPORT_ROUTE) &&
      !readSrc("src/lib/nav.ts").includes("import-leads"),
  );
  check(
    "Requests list and dashboard were not used as shared entry points",
    !readSrc("src/app/(app)/requests/page.tsx").includes("import-leads") &&
      !readSrc("src/app/(app)/dashboard/page.tsx").includes("import-leads") &&
      !readSrc("src/app/(app)/growth/page.tsx").includes("import-leads"),
  );
  check(
    "UI does not invent scores, scrape, or bought lists",
    !/lead score|bought list|scrape|crawl|autonomous outreach|ranking/i.test(uiSource),
  );
  check(
    "Ops require OWNER and scope every load by businessId",
    readSrc("src/lib/external-lead-import-ops.ts").includes('requireBusinessRole(access, "OWNER")') &&
      readSrc("src/lib/external-lead-import-ops.ts").includes("businessId: access.businessId"),
  );
  check(
    "Confirm creates leads only after explicit confirmation",
    readSrc("src/lib/external-lead-import-ops.ts").includes("confirmExternalLeadImport") &&
      readSrc("src/app/actions/external-lead-import.ts").includes("confirmExternalLeadImport") &&
      !readSrc("src/lib/external-lead-import-ops.ts").includes("createOwnerLoggedLead") === false,
  );
  check(
    "Submission ids stay within the intake token shape",
    /^[A-Za-z0-9_-]{8,80}$/.test(importRowSubmissionId("import123", "abc123def456")),
  );
  check(
    "Fingerprint is stable for the same sanitized identity",
    importRowFingerprint({ name: "Ada", email: "ada@example.com", phone: "2393578199", summary: "Faucet" }) ===
      importRowFingerprint({ name: "Ada", email: "ada@example.com", phone: "2393578199", summary: "Faucet" }),
  );

  console.log("\nSTATIC — parse, sanitize, URL bounds");
  const quoted = parseCsv('name,summary\n"Lee, Jr.","Fix, now"');
  check(
    "CSV parser keeps quoted commas",
    quoted[1][0] === "Lee, Jr." && quoted[1][1] === "Fix, now",
  );
  check(
    "Sanitize strips tags and control characters",
    sanitizeImportText("Ada\u0000<script>x</script> Smith", 80) === "Ada Smith",
  );
  check(
    "Filename is sanitized",
    sanitizeSourceFilename("../../bought leads!.csv") === "bought_leads_.csv",
  );
  const invalid = evaluateImportRow(2, { name: "", email: "not-an-email", summary: "" });
  check("Missing name is invalid", invalid.previewStatus === "INVALID");
  const badEmail = evaluateImportRow(2, { name: "Ada", email: "not-an-email", summary: "Faucet" });
  check("Invalid email is invalid", badEmail.previewStatus === "INVALID");
  try {
    parseExternalLeadCsv("email,phone\nada@example.com,2393578199");
    check("CSV without a name column is rejected", false);
  } catch (error) {
    check("CSV without a name column is rejected", error.message === MISSING_NAME_HEADER_MESSAGE);
  }
  try {
    const many = ["name,summary", ...Array.from({ length: 201 }, (_, i) => `N${i},Work`)].join("\n");
    parseExternalLeadCsv(many);
    check("Row bound rejects 201 data rows", false);
  } catch (error) {
    check("Row bound rejects 201 data rows", error.message === TOO_MANY_ROWS_MESSAGE);
  }
  try {
    decodeCsvBytes(Buffer.alloc(MAX_EXTERNAL_LEAD_IMPORT_BYTES + 1));
    check("Byte bound rejects oversized buffers", false);
  } catch (error) {
    check("Byte bound rejects oversized buffers", error.message === FILE_TOO_LARGE_MESSAGE);
  }
  check(
    "Localhost source URL is blocked",
    validateOwnerSourceUrl("http://127.0.0.1/leads.csv").ok === false &&
      validateOwnerSourceUrl("http://localhost/leads.csv").error === BLOCKED_SOURCE_URL_MESSAGE,
  );
  check(
    "Metadata and private hosts are blocked",
    validateOwnerSourceUrl("http://169.254.169.254/latest/meta-data").ok === false &&
      validateOwnerSourceUrl("http://192.168.1.10/leads.csv").ok === false &&
      validateOwnerSourceUrl("http://10.0.0.8/leads.csv").ok === false,
  );
  check(
    "Credentialed and non-http URLs are blocked",
    validateOwnerSourceUrl("https://user:pass@example.com/leads.csv").ok === false &&
      validateOwnerSourceUrl("javascript:alert(1)").ok === false,
  );
  check(
    "Public https CSV URL is accepted",
    validateOwnerSourceUrl("https://owner.example.com/leads.csv").ok === true,
  );

  let fetched = false;
  try {
    await fetchOwnerSuppliedCsv("http://127.0.0.1/leads.csv", {
      fetchImpl: async () => {
        fetched = true;
        return new Response("name,summary\nAda,Faucet");
      },
      lookup: async () => ["127.0.0.1"],
    });
    check("Blocked URL does not fetch", false);
  } catch (error) {
    check("Blocked URL does not fetch", error.message === BLOCKED_SOURCE_URL_MESSAGE && fetched === false);
  }

  const htmlFetch = await fetchOwnerSuppliedCsv("https://owner.example.com/leads.csv", {
    fetchImpl: async () =>
      new Response("<html>directory</html>", { headers: { "content-type": "text/html" } }),
    lookup: async () => ["203.0.113.10"],
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error: error.message }),
  );
  check("HTML source URL is rejected", htmlFetch.ok === false && htmlFetch.error === SOURCE_URL_NOT_CSV_MESSAGE);

  const csvBytes = Buffer.from(csv(['Ada,ada@example.com,2393578199,Faucet,"Call back",1 Main,Naples,FL,34102,GOOGLE']));
  const ownerCsv = await fetchOwnerSuppliedCsv("https://owner.example.com/owner-leads.csv", {
    fetchImpl: async () =>
      new Response(csvBytes, { headers: { "content-type": "text/csv" } }),
    lookup: async () => ["203.0.113.10"],
  });
  check(
    "Owner CSV URL returns the supplied bytes",
    hashCsvBytes(ownerCsv.bytes) === hashCsvBytes(csvBytes),
  );

  const sameBusinessDupes = applySameBusinessDuplicates(
    parseExternalLeadCsv(csv(["Ada,ada@example.com,2393578199,Faucet,,,Naples,FL,34102,MANUAL"])),
    [{ id: "cust-a", name: "Ada", email: "ada@example.com", phone: "2393578199" }],
    [{ id: "req-a", customerId: "cust-a", customer: { email: "ada@example.com", phone: "2393578199" } }],
  );
  check(
    "Same-business email/phone is a possible duplicate, not a score",
    sameBusinessDupes[0].previewStatus === "POSSIBLE_DUPLICATE" &&
      sameBusinessDupes[0].possibleDuplicateCustomerId === "cust-a" &&
      sameBusinessDupes[0].possibleDuplicateRequestId === "req-a",
  );
  const crossTenant = applySameBusinessDuplicates(
    parseExternalLeadCsv(csv(["Ada,ada@example.com,2393578199,Faucet,,,Naples,FL,34102,MANUAL"])),
    [],
    [],
  );
  check(
    "Other-business identities are not duplicates when omitted from the same-business set",
    crossTenant[0].previewStatus === "VALID",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Import", slug: `alpha-eli-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Import", slug: `beta-eli-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerAUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Mia", email: `member-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `owner-b-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerAMem = await prisma.membership.create({
    data: { userId: ownerAUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminAMem = await prisma.membership.create({
    data: { userId: adminAUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberAMem = await prisma.membership.create({
    data: { userId: memberAUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerBMem = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerAMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminAMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberAMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", ownerBMem.id);

  await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Existing Ada",
      email: "existing-ada@example.com",
      phone: "2395550100",
    },
  });
  await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Ada",
      email: "ada@example.com",
      phone: "2393578199",
    },
  });

  console.log("\nAUTH — OWNER review only");
  try {
    requireBusinessRole(adminA, "OWNER");
    check("ADMIN fails the OWNER role floor", false);
  } catch (error) {
    check("ADMIN fails the OWNER role floor", error instanceof ForbiddenError);
  }
  try {
    await previewCsvUpload(prisma, adminA, {
      filename: "leads.csv",
      bytes: Buffer.from(csv(["Ada,ada@example.com,2393578199,Faucet,,,,,,MANUAL"])),
    });
    check("ADMIN cannot preview", false);
  } catch (error) {
    check("ADMIN cannot preview", error instanceof ForbiddenError);
  }
  try {
    await previewCsvUpload(prisma, memberA, {
      filename: "leads.csv",
      bytes: Buffer.from(csv(["Ada,ada@example.com,2393578199,Faucet,,,,,,MANUAL"])),
    });
    check("MEMBER cannot preview", false);
  } catch (error) {
    check("MEMBER cannot preview", error instanceof ForbiddenError);
  }

  console.log("\nPREVIEW — source, capture date, invalid, same-business duplicates");
  const mixedCsv = Buffer.from(
    [
      "name,email,phone,summary,source",
      "Ada Lovelace,ada@example.com,2393578199,Kitchen faucet,GOOGLE",
      ",missing@example.com,2395550111,No name,MANUAL",
      "Existing Ada,existing-ada@example.com,2395550100,Repeat visit,MANUAL",
    ].join("\n"),
  );
  const previewA = await previewCsvUpload(prisma, ownerA, {
    filename: "owner-leads.csv",
    bytes: mixedCsv,
  });
  check("Preview stays PREVIEW until confirm", previewA.status === "PREVIEW");
  check("Preview records source label and capture date", previewA.sourceLabel === "owner-leads.csv" && previewA.capturedAt instanceof Date);
  check("Valid / invalid / duplicate counts are exact", previewA.validCount === 1 && previewA.invalidCount === 1 && previewA.possibleDuplicateCount === 1);
  check(
    "Possible duplicate points at the same-business customer only",
    previewA.rows.some(
      (row) =>
        row.previewStatus === "POSSIBLE_DUPLICATE" &&
        row.email === "existing-ada@example.com" &&
        row.possibleDuplicateCustomerId,
    ),
  );
  check(
    "Cross-tenant Beta Ada email is not a duplicate on Alpha",
    previewA.rows.find((row) => row.email === "ada@example.com")?.previewStatus === "VALID",
  );

  const previewAgain = await previewCsvUpload(prisma, ownerA, {
    filename: "owner-leads.csv",
    bytes: mixedCsv,
  });
  check("Retry of the same CSV reuses the same preview id", previewAgain.id === previewA.id);

  try {
    await loadOwnedImport(prisma, ownerB, previewA.id);
    check("Business B cannot load Business A preview", false);
  } catch (error) {
    check(
      "Business B cannot load Business A preview",
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE,
    );
  }

  const previewB = await previewCsvUpload(prisma, ownerB, {
    filename: "owner-leads.csv",
    bytes: mixedCsv,
  });
  check("Same CSV bytes can be previewed independently per tenant", previewB.id !== previewA.id);
  check(
    "Business B flags its own Ada email as a possible duplicate",
    previewB.rows.find((row) => row.email === "ada@example.com")?.previewStatus === "POSSIBLE_DUPLICATE",
  );

  const urlPreview = await previewOwnerSourceUrl(prisma, ownerA, {
    sourceUrl: "https://owner.example.com/second.csv",
    fetchImpl: async () =>
      new Response("name,summary\nCarl,Deck repair\n", { headers: { "content-type": "text/csv" } }),
    lookup: async () => ["203.0.113.10"],
  });
  check(
    "Owner URL preview stores the supplied URL as the source",
    urlPreview.sourceKind === "SOURCE_URL" &&
      urlPreview.sourceLabel === "https://owner.example.com/second.csv" &&
      urlPreview.validCount === 1,
  );

  console.log("\nCONFIRM — explicit OWNER create, idempotent retry, tenant isolation");
  const requestsBeforeA = await prisma.serviceRequest.count({ where: { businessId: businessA.id } });
  const requestsBeforeB = await prisma.serviceRequest.count({ where: { businessId: businessB.id } });
  const customersBeforeA = await prisma.customer.count({ where: { businessId: businessA.id } });

  try {
    await confirmExternalLeadImport(prisma, ownerB, { importId: previewA.id });
    check("Business B cannot confirm Business A preview", false);
  } catch (error) {
    check(
      "Business B cannot confirm Business A preview",
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE,
    );
  }
  try {
    await confirmExternalLeadImport(prisma, adminA, { importId: previewA.id });
    check("ADMIN cannot confirm", false);
  } catch (error) {
    check("ADMIN cannot confirm", error instanceof ForbiddenError);
  }

  const confirmed = await confirmExternalLeadImport(prisma, ownerA, { importId: previewA.id });
  const requestsAfterA = await prisma.serviceRequest.findMany({
    where: { businessId: businessA.id },
    include: { customer: true },
  });
  const createdAda = requestsAfterA.find((row) => row.customer?.email === "ada@example.com");
  check("Confirm creates only the ready row by default", confirmed.createdRequestIds.length === 1);
  check("Created lead stays on tenant A", createdAda?.businessId === businessA.id);
  check("Recorded CSV source is preserved, not scored", createdAda?.leadSource === "GOOGLE");
  check(
    "Invalid and possible-duplicate rows create no extra A customers",
    (await prisma.customer.count({ where: { businessId: businessA.id } })) === customersBeforeA + 1,
  );
  check(
    "Business B request count is unchanged by A's confirm",
    (await prisma.serviceRequest.count({ where: { businessId: businessB.id } })) === requestsBeforeB,
  );
  check(
    "Business A gained exactly one request",
    requestsAfterA.length === requestsBeforeA + 1,
  );

  const confirmedAgain = await confirmExternalLeadImport(prisma, ownerA, { importId: previewA.id });
  check("Retry confirm is idempotent", confirmedAgain.reused === true);
  check(
    "Retry confirm does not create a second request",
    (await prisma.serviceRequest.count({ where: { businessId: businessA.id } })) === requestsAfterA.length,
  );

  const withDupes = await confirmExternalLeadImport(prisma, ownerB, {
    importId: previewB.id,
    includePossibleDuplicates: true,
  });
  check(
    "OWNER B may explicitly include same-business duplicates for B only",
    withDupes.createdRequestIds.length >= 1 &&
      withDupes.preview.rows
        .filter((row) => row.previewStatus !== "INVALID")
        .every((row) => row.createdRequestId),
  );
  check(
    "B confirm still creates no A rows",
    (await prisma.serviceRequest.count({ where: { businessId: businessA.id } })) === requestsAfterA.length,
  );

  const bRequests = await prisma.serviceRequest.findMany({
    where: { businessId: businessB.id },
    include: { customer: true },
  });
  check(
    "B created requests never attach A customers",
    bRequests.every((row) => !row.customerId || row.customer?.businessId === businessB.id),
  );

  console.log("\nExternal lead import check complete.");
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
  } catch {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

if (failures > 0) {
  console.error(`\n${failures} external lead import check(s) failed.`);
  process.exit(1);
}
console.log("All external lead import checks passed.");
