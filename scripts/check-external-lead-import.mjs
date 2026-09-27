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
  decodeCsvBytes,
  evaluateImportRow,
  ExternalLeadImportError,
  EXTERNAL_LEAD_IMPORT_ROUTE,
  FILE_TOO_LARGE_MESSAGE,
  IMPORT_ALREADY_CONFIRMED_MESSAGE,
  IMPORT_CSV_REQUIRED_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  IMPORT_RESOLVE_INVALID_MESSAGE,
  IMPORT_ROW_NOT_EDITABLE_MESSAGE,
  IMPORT_ROW_NOT_REJECTABLE_MESSAGE,
  IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
  importRowFingerprint,
  importRowSubmissionId,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  MAX_EXTERNAL_LEAD_IMPORT_ROWS,
  MISSING_NAME_HEADER_MESSAGE,
  NOT_CSV_MESSAGE,
  OWNER_ONLY_IMPORT_MESSAGE,
  parseCsv,
  parseExternalLeadCsv,
  ROW_REJECTED_BY_OWNER_MESSAGE,
  sanitizeImportText,
  sanitizeSourceFilename,
  storedRowToParsed,
  TOO_MANY_ROWS_MESSAGE,
} = await import("@/lib/external-lead-import");
const importModule = await import("@/lib/external-lead-import");
const opsModule = await import("@/lib/external-lead-import-ops");
const {
  confirmExternalLeadImport,
  correctExternalLeadImportRow,
  loadOwnedImport,
  previewCsvUpload,
  rejectExternalLeadImportRow,
} = opsModule;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const featureFiles = [
  "src/lib/external-lead-import-copy.ts",
  "src/lib/external-lead-import.ts",
  "src/lib/external-lead-import-ops.ts",
  "src/app/actions/external-lead-import.ts",
  "src/app/(app)/requests/import-leads/page.tsx",
  "src/app/(app)/requests/import-leads/[importId]/page.tsx",
  "src/components/requests/import-leads-form.tsx",
  "src/components/requests/import-leads-preview.tsx",
  "src/components/requests/import-leads-row-review.tsx",
];
const featureSource = featureFiles.map(readSrc).join("\n");
const uiSource = [
  "src/app/(app)/requests/import-leads/page.tsx",
  "src/app/(app)/requests/import-leads/[importId]/page.tsx",
  "src/components/requests/import-leads-form.tsx",
  "src/components/requests/import-leads-preview.tsx",
  "src/components/requests/import-leads-row-review.tsx",
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
    uiSource.includes("IMPORT_NO_SCRAPE_MESSAGE") &&
      uiSource.includes("IMPORT_NO_SCORE_MESSAGE") &&
      uiSource.includes("IMPORT_NO_OUTREACH_MESSAGE") &&
      !/likely to convert|lead ranking|autonomous outreach/i.test(featureSource),
  );
  check(
    "Client forms do not import Node DNS/crypto modules",
    !uiSource.includes("external-lead-import.ts") &&
      uiSource.includes("external-lead-import-copy") &&
      !readSrc("src/lib/external-lead-import-copy.ts").includes("node:"),
  );
  check(
    "Server-side owner CSV URL fetch is disabled",
    !featureSource.includes("fetchOwnerSuppliedCsv") &&
      !featureSource.includes("previewOwnerSourceUrl") &&
      !featureSource.includes("validateOwnerSourceUrl") &&
      !featureSource.includes("node:dns") &&
      !featureSource.includes("sourceUrl") &&
      !uiSource.includes("Owner-supplied source URL") &&
      IMPORT_CSV_REQUIRED_MESSAGE.includes("does not fetch") &&
      !("fetchOwnerSuppliedCsv" in importModule) &&
      !("previewOwnerSourceUrl" in opsModule),
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
    "Owner can correct or reject staged invalid rows before confirm",
    readSrc("src/lib/external-lead-import-ops.ts").includes("correctExternalLeadImportRow") &&
      readSrc("src/lib/external-lead-import-ops.ts").includes("rejectExternalLeadImportRow") &&
      readSrc("src/app/actions/external-lead-import.ts").includes("correctExternalLeadImportRow") &&
      readSrc("src/app/actions/external-lead-import.ts").includes("rejectExternalLeadImportRow") &&
      uiSource.includes("Save correction") &&
      uiSource.includes("Reject this row") &&
      IMPORT_RESOLVE_INVALID_MESSAGE.includes("Correct or reject") &&
      IMPORT_ROW_REJECTED_TERMINAL_MESSAGE.includes("cannot be corrected") &&
      readSrc("src/components/requests/import-leads-preview.tsx").includes(
        "Rejection is final",
      ) &&
      !readSrc("src/components/requests/import-leads-preview.tsx").includes(
        "correctExternalLeadImportRowAction",
      ) &&
      readSrc("src/lib/external-lead-import-ops.ts").includes(
        "IMPORT_ROW_REJECTED_TERMINAL_MESSAGE",
      ) &&
      /previewStatus:\s*"INVALID"/.test(
        readSrc("src/lib/external-lead-import-ops.ts").slice(
          readSrc("src/lib/external-lead-import-ops.ts").indexOf("async function persistReviewedRow"),
          readSrc("src/lib/external-lead-import-ops.ts").indexOf("export type ImportRowCorrectionInput"),
        ),
      ),
  );
  check(
    "Correction and rejection do not create leads or send messages",
    (readSrc("src/lib/external-lead-import-ops.ts").match(/createOwnerLoggedLead/g) || []).length === 2 &&
      !/sendEmail|sendMail|sendSms|resend|appointment-mail|appointment-notify/i.test(
        readSrc("src/lib/external-lead-import-ops.ts"),
      ) &&
      !/sendEmail|sendMail|sendSms|resend|appointment-mail|appointment-notify/i.test(
        readSrc("src/app/actions/external-lead-import.ts"),
      ),
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

  console.log("\nSTATIC — parse, sanitize, upload bounds");
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
  try {
    decodeCsvBytes(Buffer.from("<html>directory</html>"));
    check("HTML upload is rejected as not CSV", false);
  } catch (error) {
    check("HTML upload is rejected as not CSV", error.message === NOT_CSV_MESSAGE);
  }

  const sameBusinessDupes = applySameBusinessDuplicates(
    parseExternalLeadCsv(csv(["Ada,ada@example.com,2393578199,Faucet,,,,,,MANUAL"])),
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
    parseExternalLeadCsv(csv(["Ada,ada@example.com,2393578199,Faucet,,,,,,MANUAL"])),
    [],
    [],
  );
  check(
    "Other-business identities are not duplicates when omitted from the same-business set",
    crossTenant[0].previewStatus === "VALID",
  );
  const rejectedStored = storedRowToParsed({
    rowNumber: 4,
    name: "Skip",
    email: "skip@example.com",
    phone: "",
    summary: "Skip",
    notes: "",
    streetAddress: "",
    unit: "",
    city: "",
    region: "",
    postalCode: "",
    leadSource: "MANUAL",
    previewStatus: "REJECTED",
    invalidReason: ROW_REJECTED_BY_OWNER_MESSAGE,
    rowFingerprint: "abc",
  });
  check(
    "Rejected staged rows stay rejected when re-evaluated for duplicates",
    applySameBusinessDuplicates(
      [rejectedStored],
      [{ id: "cust-skip", name: "Skip", email: "skip@example.com", phone: null }],
      [],
    )[0].previewStatus === "REJECTED",
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

  try {
    await confirmExternalLeadImport(prisma, ownerA, { importId: previewA.id });
    check("Confirm is blocked while invalid rows remain", false);
  } catch (error) {
    check(
      "Confirm is blocked while invalid rows remain",
      error.message === IMPORT_RESOLVE_INVALID_MESSAGE,
    );
  }

  const invalidA = previewA.rows.find((row) => row.previewStatus === "INVALID");
  check("Mixed preview has one invalid row to resolve", Boolean(invalidA));
  const rejectedA = await rejectExternalLeadImportRow(prisma, ownerA, {
    importId: previewA.id,
    rowId: invalidA.id,
  });
  check(
    "Owner rejection clears the invalid count without creating a lead",
    rejectedA.preview.invalidCount === 0 &&
      rejectedA.preview.rejectedCount === 1 &&
      rejectedA.preview.createdCount === 0 &&
      rejectedA.preview.rows.find((row) => row.id === invalidA.id)?.previewStatus === "REJECTED",
  );
  const rejectedAgain = await rejectExternalLeadImportRow(prisma, ownerA, {
    importId: previewA.id,
    rowId: invalidA.id,
  });
  check("Retry reject of the same row is idempotent", rejectedAgain.reused === true);

  const previewAgain = await previewCsvUpload(prisma, ownerA, {
    filename: "owner-leads.csv",
    bytes: mixedCsv,
  });
  check("Retry of the same CSV reuses the same preview id", previewAgain.id === previewA.id);
  check(
    "Retry of the same CSV preserves the owner rejection",
    previewAgain.rows.find((row) => row.rowNumber === invalidA.rowNumber)?.previewStatus ===
      "REJECTED",
  );

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

  check("Preview source kind is CSV upload only", previewA.sourceKind === "CSV_UPLOAD");

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

  const invalidB = previewB.rows.find((row) => row.previewStatus === "INVALID");
  await rejectExternalLeadImportRow(prisma, ownerB, {
    importId: previewB.id,
    rowId: invalidB.id,
  });
  const withDupes = await confirmExternalLeadImport(prisma, ownerB, {
    importId: previewB.id,
    includePossibleDuplicates: true,
  });
  check(
    "OWNER B may explicitly include same-business duplicates for B only",
    withDupes.createdRequestIds.length >= 1 &&
      withDupes.preview.rows
        .filter(
          (row) =>
            row.previewStatus === "VALID" || row.previewStatus === "POSSIBLE_DUPLICATE",
        )
        .every((row) => row.createdRequestId) &&
      withDupes.preview.rows
        .filter((row) => row.previewStatus === "REJECTED")
        .every((row) => !row.createdRequestId),
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

  console.log("\nREVIEW — correct invalid rows, reject, retry, no messages");
  const reviewCsv = Buffer.from(
    [
      "name,email,phone,summary,source",
      "Pat Ready,pat-ready@example.com,2393578210,Paint porch,MANUAL",
      ",not-an-email,2395550211,Missing name,MANUAL",
      "No Summary,no-summary@example.com,2395550212,,MANUAL",
    ].join("\n"),
  );
  const reviewPreview = await previewCsvUpload(prisma, ownerA, {
    filename: "review-leads.csv",
    bytes: reviewCsv,
  });
  const missingName = reviewPreview.rows.find((row) => row.email === "not-an-email");
  const missingSummary = reviewPreview.rows.find((row) => row.email === "no-summary@example.com");
  check(
    "Review preview stages one ready row and two invalid rows",
    reviewPreview.validCount === 1 &&
      reviewPreview.invalidCount === 2 &&
      Boolean(missingName) &&
      Boolean(missingSummary),
  );

  const stillInvalid = await correctExternalLeadImportRow(prisma, ownerA, {
    importId: reviewPreview.id,
    rowId: missingName.id,
    name: "Pat Fixed",
    email: "not-an-email",
    phone: "2395550211",
    summary: "Missing name",
  });
  check(
    "First correction retry stays invalid when email is still bad",
    stillInvalid.rows.find((row) => row.id === missingName.id)?.previewStatus === "INVALID" &&
      stillInvalid.createdCount === 0,
  );

  const requestsBeforeReview = await prisma.serviceRequest.count({
    where: { businessId: businessA.id },
  });
  const corrected = await correctExternalLeadImportRow(prisma, ownerA, {
    importId: reviewPreview.id,
    rowId: missingName.id,
    name: "Pat Fixed",
    email: "pat-fixed@example.com",
    phone: "2395550211",
    summary: "Repair stoop",
    source: "GOOGLE",
  });
  const correctedRow = corrected.rows.find((row) => row.id === missingName.id);
  check(
    "Retry correction with valid fields marks the row ready",
    correctedRow?.previewStatus === "VALID" &&
      correctedRow.email === "pat-fixed@example.com" &&
      correctedRow.leadSource === "GOOGLE" &&
      corrected.invalidCount === 1 &&
      corrected.validCount === 2,
  );
  check(
    "Correction does not create a request before confirm",
    (await prisma.serviceRequest.count({ where: { businessId: businessA.id } })) ===
      requestsBeforeReview,
  );

  try {
    await correctExternalLeadImportRow(prisma, ownerA, {
      importId: reviewPreview.id,
      rowId: correctedRow.id,
      name: "Pat Fixed",
      email: "pat-fixed@example.com",
      summary: "Repair stoop",
    });
    check("Ready rows cannot be edited again", false);
  } catch (error) {
    check(
      "Ready rows cannot be edited again",
      error.message === IMPORT_ROW_NOT_EDITABLE_MESSAGE,
    );
  }

  const rejectedReview = await rejectExternalLeadImportRow(prisma, ownerA, {
    importId: reviewPreview.id,
    rowId: missingSummary.id,
  });
  check(
    "Owner can reject the remaining invalid row",
    rejectedReview.preview.invalidCount === 0 &&
      rejectedReview.preview.rejectedCount === 1 &&
      rejectedReview.preview.rows.find((row) => row.id === missingSummary.id)?.invalidReason ===
        ROW_REJECTED_BY_OWNER_MESSAGE,
  );
  try {
    await correctExternalLeadImportRow(prisma, ownerA, {
      importId: reviewPreview.id,
      rowId: missingSummary.id,
      name: "Unreject",
      email: "no-summary@example.com",
      summary: "Should stay rejected",
    });
    check("Direct correction of a rejected row is refused", false);
  } catch (error) {
    check(
      "Direct correction of a rejected row is refused",
      error.message === IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
    );
  }

  try {
    await rejectExternalLeadImportRow(prisma, ownerA, {
      importId: reviewPreview.id,
      rowId: correctedRow.id,
    });
    check("Ready rows cannot be rejected", false);
  } catch (error) {
    check("Ready rows cannot be rejected", error.message === IMPORT_ROW_NOT_REJECTABLE_MESSAGE);
  }

  try {
    await correctExternalLeadImportRow(prisma, adminA, {
      importId: reviewPreview.id,
      rowId: missingSummary.id,
      name: "Admin",
      summary: "Nope",
    });
    check("ADMIN cannot correct", false);
  } catch (error) {
    check("ADMIN cannot correct", error instanceof ForbiddenError);
  }
  try {
    await rejectExternalLeadImportRow(prisma, memberA, {
      importId: reviewPreview.id,
      rowId: missingSummary.id,
    });
    check("MEMBER cannot reject", false);
  } catch (error) {
    check("MEMBER cannot reject", error instanceof ForbiddenError);
  }
  try {
    await correctExternalLeadImportRow(prisma, ownerB, {
      importId: reviewPreview.id,
      rowId: missingSummary.id,
      name: "Cross",
      summary: "Nope",
    });
    check("Business B cannot correct Business A staged row", false);
  } catch (error) {
    check(
      "Business B cannot correct Business A staged row",
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE,
    );
  }

  const dupeCorrectCsv = Buffer.from(
    [
      "name,email,phone,summary,source",
      ",existing-ada@example.com,2395550100,Repeat later,MANUAL",
    ].join("\n"),
  );
  const dupePreview = await previewCsvUpload(prisma, ownerA, {
    filename: "dupe-correct.csv",
    bytes: dupeCorrectCsv,
  });
  const dupeInvalid = dupePreview.rows[0];
  const dupeCorrected = await correctExternalLeadImportRow(prisma, ownerA, {
    importId: dupePreview.id,
    rowId: dupeInvalid.id,
    name: "Existing Ada",
    email: "existing-ada@example.com",
    phone: "2395550100",
    summary: "Repeat later",
  });
  check(
    "Corrected identity that matches a same-business customer is a possible duplicate",
    dupeCorrected.rows[0].previewStatus === "POSSIBLE_DUPLICATE" &&
      Boolean(dupeCorrected.rows[0].possibleDuplicateCustomerId) &&
      dupeCorrected.createdCount === 0,
  );

  const reviewAgain = await previewCsvUpload(prisma, ownerA, {
    filename: "review-leads.csv",
    bytes: reviewCsv,
  });
  const rejectedAfterRetry = reviewAgain.rows.find(
    (row) => row.rowNumber === missingSummary.rowNumber,
  );
  check("Retry of the review CSV reuses the same preview id", reviewAgain.id === reviewPreview.id);
  check(
    "Retry of the review CSV keeps the corrected and rejected rows",
    reviewAgain.rows.find((row) => row.rowNumber === missingName.rowNumber)?.email ===
      "pat-fixed@example.com" &&
      reviewAgain.rows.find((row) => row.rowNumber === missingName.rowNumber)?.previewStatus ===
        "VALID" &&
      rejectedAfterRetry?.previewStatus === "REJECTED",
  );
  try {
    await correctExternalLeadImportRow(prisma, ownerA, {
      importId: reviewPreview.id,
      rowId: rejectedAfterRetry.id,
      name: "Unreject after retry",
      email: "no-summary@example.com",
      summary: "Should stay rejected",
    });
    check("CSV retry does not reopen a rejected row for correction", false);
  } catch (error) {
    check(
      "CSV retry does not reopen a rejected row for correction",
      error.message === IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
    );
  }

  const confirmedReview = await confirmExternalLeadImport(prisma, ownerA, {
    importId: reviewPreview.id,
  });
  const reviewRequests = await prisma.serviceRequest.findMany({
    where: { businessId: businessA.id },
    include: { customer: true },
  });
  const createdFixed = reviewRequests.find((row) => row.customer?.email === "pat-fixed@example.com");
  const rejectedAfterConfirm = confirmedReview.preview.rows.find(
    (row) => row.rowNumber === missingSummary.rowNumber,
  );
  check(
    "Confirm after review creates only ready rows",
    confirmedReview.createdRequestIds.length === 2 &&
      confirmedReview.preview.rows
        .filter((row) => row.previewStatus === "VALID")
        .every((row) => row.createdRequestId),
  );
  check(
    "Rejected row stays rejected and creates no lead after CSV retry and confirmation",
    rejectedAfterConfirm?.previewStatus === "REJECTED" &&
      !rejectedAfterConfirm.createdRequestId &&
      !reviewRequests.some((row) => row.customer?.email === "no-summary@example.com"),
  );
  check("Corrected row keeps the owner-recorded source", createdFixed?.leadSource === "GOOGLE");

  const confirmedReviewAgain = await confirmExternalLeadImport(prisma, ownerA, {
    importId: reviewPreview.id,
  });
  check("Retry confirm after review is idempotent", confirmedReviewAgain.reused === true);
  check(
    "Retry confirm after review does not create more A requests",
    (await prisma.serviceRequest.count({ where: { businessId: businessA.id } })) ===
      reviewRequests.length,
  );

  try {
    await correctExternalLeadImportRow(prisma, ownerA, {
      importId: reviewPreview.id,
      rowId: missingSummary.id,
      name: "Too late",
      summary: "Too late",
    });
    check("Confirmed preview cannot be corrected", false);
  } catch (error) {
    check(
      "Confirmed preview cannot be corrected",
      error.message === IMPORT_ALREADY_CONFIRMED_MESSAGE,
    );
  }

  console.log("\nRACE — reject wins the INVALID write, correction fails, row stays REJECTED");
  const raceCsv = Buffer.from(
    [
      "name,email,phone,summary,source",
      ",race@example.com,2395550299,Missing name,MANUAL",
    ].join("\n"),
  );
  const racePreview = await previewCsvUpload(prisma, ownerA, {
    filename: "race-leads.csv",
    bytes: raceCsv,
  });
  const raceRow = racePreview.rows[0];
  check(
    "Race preview starts with one invalid staged row",
    racePreview.status === "PREVIEW" &&
      raceRow?.previewStatus === "INVALID" &&
      racePreview.invalidCount === 1,
  );

  let releaseCorrectionWrite;
  const correctionWriteGate = new Promise((resolve) => {
    releaseCorrectionWrite = resolve;
  });
  let notifyCorrectionReachedWrite;
  const correctionReachedWrite = new Promise((resolve) => {
    notifyCorrectionReachedWrite = resolve;
  });
  const racingDb = prisma.$extends({
    query: {
      externalLeadImportRow: {
        async updateMany({ args, query }) {
          if (args.data?.previewStatus === "REJECTED") {
            return query(args);
          }
          notifyCorrectionReachedWrite();
          await correctionWriteGate;
          return query(args);
        },
      },
    },
  });

  const correctionPromise = correctExternalLeadImportRow(racingDb, ownerA, {
    importId: racePreview.id,
    rowId: raceRow.id,
    name: "Race Correct",
    email: "race-correct@example.com",
    phone: "2395550299",
    summary: "Should lose the race",
  });
  await correctionReachedWrite;
  const raceRejected = await rejectExternalLeadImportRow(prisma, ownerA, {
    importId: racePreview.id,
    rowId: raceRow.id,
  });
  check(
    "Reject commits first while the correction write is held",
    raceRejected.reused === false &&
      raceRejected.preview.rows.find((row) => row.id === raceRow.id)?.previewStatus ===
        "REJECTED",
  );
  releaseCorrectionWrite();
  try {
    await correctionPromise;
    check("Concurrent correction loses once the row is no longer INVALID", false);
  } catch (error) {
    check(
      "Concurrent correction loses once the row is no longer INVALID",
      error instanceof ExternalLeadImportError &&
        error.message === IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
    );
  }
  const afterRace = await loadOwnedImport(prisma, ownerA, racePreview.id);
  const afterRaceRow = afterRace.rows.find((row) => row.id === raceRow.id);
  check(
    "Rejected row stays rejected and creates no lead after the lost correction race",
    afterRaceRow?.previewStatus === "REJECTED" &&
      afterRaceRow.name !== "Race Correct" &&
      afterRaceRow.email === "race@example.com" &&
      afterRaceRow.createdRequestId == null &&
      afterRace.createdCount === 0 &&
      afterRace.rejectedCount === 1,
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
