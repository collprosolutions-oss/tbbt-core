/**
 * Owner-configurable customer-facing business contact.
 *
 * Stored phone/email/website win. CollPro Reno keeps its existing public
 * phone until the owner saves one. Other tenants get no invented contact.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-contact.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  parsePublicEmail,
  parsePublicPhone,
  parsePublicWebsite,
  resolveBusinessPublicContact,
  ensureBusinessPublicContactSchema,
  resetBusinessPublicContactSchemaEnsure,
  loadActiveWorkspaceMemberships,
} = await import("@/lib/business-contact");
const { COLLPRO_RENO_PHONE, publicPhone } = await import("@/lib/public-site");
const { formatMailingAddress, formatPublicPhoneDisplay } = await import("@/lib/format");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

function expectThrow(label, fn, predicate) {
  try {
    fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

console.log("\nSTATIC — Documents resolve live contact, not a frozen snapshot");
const contactSrc = readRepo("src/lib/business-contact.ts");
const settingsOps = readRepo("src/lib/settings-ops.ts");
const estimateDoc = readRepo("src/lib/estimate-document.ts");
const invoiceDoc = readRepo("src/lib/invoice-document.ts");
check(
  "Contact helper documents live resolution without rewriting prices",
  contactSrc.includes("They are not financial snapshot fields") &&
    contactSrc.includes("ensureBusinessPublicContactSchema"),
);
const contactOpStart = settingsOps.indexOf("export async function updateBusinessPublicContactOp");
const contactOpEnd = settingsOps.indexOf("export async function", contactOpStart + 10);
const contactOp = settingsOps.slice(contactOpStart, contactOpEnd === -1 ? undefined : contactOpEnd);
check(
  "Settings contact mutation updates only Business fields",
  contactOp.includes("publicPhone") &&
    !contactOp.includes("estimateVersion") &&
    !contactOp.includes("invoice.update"),
);
check(
  "Estimate documents resolve stored/fallback contact and stack service addresses",
  estimateDoc.includes("resolveBusinessPublicContact") &&
    estimateDoc.includes("publicPhone: true") &&
    estimateDoc.includes("formatMailingAddress"),
);
check(
  "Invoice documents resolve stored/fallback contact and stack service addresses",
  invoiceDoc.includes("resolveBusinessPublicContact") &&
    invoiceDoc.includes("publicPhone: true") &&
    invoiceDoc.includes("formatMailingAddress") &&
    invoiceDoc.includes("formatPublicPhoneDisplay"),
);
check(
  "Estimate documents format customer phones with the shared display helper",
  estimateDoc.includes("formatPublicPhoneDisplay"),
);
const portalPageSrc = readRepo("src/app/p/[token]/page.tsx");
const portalHeaderSrc = readRepo("src/components/portal/project-portal-header.tsx");
const estimatePdfSrc = readRepo("src/lib/estimate-pdf.ts");
const invoicePdfSrc = readRepo("src/lib/invoice-pdf.ts");
const invoicePageSrc = readRepo("src/app/p/[token]/invoice/page.tsx");
const requestFlowSrc = readRepo("src/components/public/request-flow.tsx");
check(
  "Customer project portal uses the shared mailing-address formatter",
  portalPageSrc.includes("formatMailingAddress") &&
    !portalPageSrc.includes("formatAddress("),
);
check(
  "Portal header preserves stacked mailing-label lines",
  portalHeaderSrc.includes("whitespace-pre-line"),
);
check(
  "Estimate and invoice PDFs render the same document phone/address fields",
  estimatePdfSrc.includes("docView.business.phone") &&
    estimatePdfSrc.includes('docView.serviceAddress.split("\\n")') &&
    invoicePdfSrc.includes("docView.business.phone") &&
    invoicePdfSrc.includes('docView.serviceAddress.split("\\n")'),
);
check(
  "Customer invoice/receipt page reuses InvoiceDocument instead of a second formatter",
  invoicePageSrc.includes("InvoiceDocument") &&
    invoicePageSrc.includes("loadInvoiceDocumentForProjectToken"),
);
check(
  "Public request review uses shared phone and mailing-address display",
  requestFlowSrc.includes("formatPublicPhoneDisplay") &&
    requestFlowSrc.includes("formatStructuredMailingAddress") &&
    requestFlowSrc.includes("formatStructuredAddress(serviceAddress)"),
);
const workspaceSrc = readRepo("src/lib/workspace.ts");
const contactLoaderSrc = readRepo("src/lib/business-contact.ts");
const contactLoaderFn = contactLoaderSrc.slice(
  contactLoaderSrc.indexOf("export async function loadActiveWorkspaceMemberships"),
);
check(
  "Dashboard/workspace Business SELECT runs only after contact schema ensure",
  workspaceSrc.includes("loadActiveWorkspaceMemberships") &&
    contactLoaderFn.includes("await ensureBusinessPublicContactSchema(db)") &&
    contactLoaderFn.indexOf("await ensureBusinessPublicContactSchema(db)") <
      contactLoaderFn.indexOf("include: { business: true }"),
);
check(
  "Contact page metadata no longer hardcodes the CollPro phone",
  !readRepo("src/app/hire/[slug]/contact/page.tsx").includes("239-357-8199") &&
    readRepo("src/app/hire/[slug]/contact/page.tsx").includes("publicPhone(site.business)"),
);

console.log("\nUNIT — parse and resolve");
check("empty phone stores as null", parsePublicPhone("") === null);
check("valid phone is trimmed", parsePublicPhone("  239-357-8199  ") === "239-357-8199");
expectThrow(
  "short phone is rejected",
  () => parsePublicPhone("123"),
  (error) => /valid phone/i.test(error.message),
);
check("empty email stores as null", parsePublicEmail("  ") === null);
check("valid email is trimmed", parsePublicEmail("  hello@collproreno.com ") === "hello@collproreno.com");
expectThrow(
  "invalid email is rejected",
  () => parsePublicEmail("not-an-email"),
  (error) => /valid email/i.test(error.message),
);
check("empty website stores as null", parsePublicWebsite("") === null);
check(
  "https website keeps the origin and drops a trailing slash",
  parsePublicWebsite("https://www.collproreno.com/") === "https://www.collproreno.com",
);
expectThrow(
  "javascript: website is rejected",
  () => parsePublicWebsite("javascript:alert(1)"),
  (error) => /https:\/\//i.test(error.message),
);
expectThrow(
  "website without a protocol is rejected",
  () => parsePublicWebsite("www.collproreno.com"),
  (error) => /https:\/\//i.test(error.message),
);

const collproFallback = resolveBusinessPublicContact({ slug: "collpro-reno" });
check("CollPro fallback does not invent email", collproFallback.email === null);
check("CollPro fallback does not invent website", collproFallback.website === null);
check("CollPro fallback phone is the launch number", collproFallback.phone === "(239) 357-8199");
check(
  "CollPro fallback display formats the stored launch digits without rewriting COLLPRO_RENO_PHONE",
  COLLPRO_RENO_PHONE === "239-357-8199" && collproFallback.phone !== COLLPRO_RENO_PHONE,
);

const stored = resolveBusinessPublicContact({
  slug: "collpro-reno",
  publicPhone: "941-555-0199",
  publicEmail: "office@collproreno.com",
  publicWebsite: "https://www.collproreno.com",
});
check("stored phone wins over the CollPro fallback", stored.phone === "(941) 555-0199");
check("stored email is used when saved", stored.email === "office@collproreno.com");
check("stored website is used when saved", stored.website === "https://www.collproreno.com");

const other = resolveBusinessPublicContact({ slug: "other-handyman" });
check("other tenant has no fallback phone", other.phone === null);
check("other tenant has no invented email", other.email === null);

check(
  "publicPhone(slug) still returns the CollPro fallback",
  publicPhone("collpro-reno") === "(239) 357-8199" && publicPhone("other-handyman") === null,
);
check(
  "publicPhone(business) uses the stored number when present",
  publicPhone({ slug: "collpro-reno", publicPhone: "555-111-2222" }) === "(555) 111-2222",
);
check(
  "publicPhone(business) falls back for CollPro when stored is empty",
  publicPhone({ slug: "collpro-reno", publicPhone: "  " }) === "(239) 357-8199",
);
check(
  "publicPhone(other tenant) does not leak the CollPro number",
  publicPhone({ slug: "other-handyman", publicPhone: null }) === null,
);

console.log("\nUNIT — customer-facing phone and mailing-address display");
check(
  "11-digit U.S. phone beginning with 1 displays as (###) ###-####",
  formatPublicPhoneDisplay("12393578199") === "(239) 357-8199" &&
    formatPublicPhoneDisplay("+1 (239) 357-8199") === "(239) 357-8199",
);
check(
  "10-digit U.S. phone displays as (###) ###-####",
  formatPublicPhoneDisplay("2393578199") === "(239) 357-8199" &&
    formatPublicPhoneDisplay("239-357-8199") === "(239) 357-8199",
);
check(
  "non-standard/non-U.S. phone is displayed as stored",
  formatPublicPhoneDisplay("+44 20 7946 0958") === "+44 20 7946 0958" &&
    formatPublicPhoneDisplay("239-357-819") === "239-357-819" &&
    formatPublicPhoneDisplay("Call the shop") === "Call the shop",
);
check("empty phone display is null", formatPublicPhoneDisplay("  ") === null);
check(
  "structured service address stacks street / city, state / ZIP",
  formatMailingAddress({
    addressLine1: "369 alpha st",
    addressLine2: null,
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
  }) === "369 alpha st\nCape Coral, FL\n33904",
);
check(
  "address 2 stays on the street line and missing parts are omitted",
  formatMailingAddress({
    addressLine1: "10 Cypress Ave",
    addressLine2: "Unit 2",
    city: "Naples",
    region: "FL",
    postalCode: "34102",
  }) === "10 Cypress Ave, Unit 2\nNaples, FL\n34102" &&
    formatMailingAddress({ addressLine1: "10 Cypress Ave" }) === "10 Cypress Ave",
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nSkipping DB persist checks (DATABASE_URL unset).");
  console.log(
    failed === 0
      ? `\nAll business-contact checks passed (${passed}).`
      : `\n${failed} business-contact check(s) failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

const testDbName = "tbbt_business_contact_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business-contact test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Persist and preview-safe ensure");
  resetBusinessPublicContactSchemaEnsure();
  await ensureBusinessPublicContactSchema(prisma);

  const collpro = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: `collpro-reno-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const otherBiz = await prisma.business.create({
    data: {
      name: "Other Subscriber Co",
      slug: `other-contact-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });

  const collproRow = await prisma.business.findUnique({
    where: { id: collpro.id },
    select: { slug: true, publicPhone: true, publicEmail: true, publicWebsite: true },
  });
  check(
    "new CollPro-style row has no stored contact yet",
    collproRow.publicPhone == null && collproRow.publicEmail == null && collproRow.publicWebsite == null,
  );

  await prisma.business.update({
    where: { id: collpro.id },
    data: {
      publicPhone: "239-357-8199",
      publicEmail: "office@collproreno.com",
      publicWebsite: "https://www.collproreno.com",
    },
  });
  const saved = await prisma.business.findUnique({
    where: { id: collpro.id },
    select: { slug: true, publicPhone: true, publicEmail: true, publicWebsite: true },
  });
  const resolved = resolveBusinessPublicContact(saved);
  check(
    "stored contact round-trips onto the resolver",
    saved.publicPhone === "239-357-8199" &&
      resolved.phone === "(239) 357-8199" &&
      resolved.email === "office@collproreno.com" &&
      resolved.website === "https://www.collproreno.com",
  );

  const otherRow = await prisma.business.findUnique({
    where: { id: otherBiz.id },
    select: { slug: true, publicPhone: true, publicEmail: true, publicWebsite: true },
  });
  check(
    "other tenant remains empty when CollPro contact is saved",
    otherRow.publicPhone == null &&
      resolveBusinessPublicContact(otherRow).phone === null,
  );

  const ownerUser = await prisma.user.create({
    data: {
      email: `owner-contact-${randomUUID()}@example.com`,
      name: "Owner",
      passwordHash: "x",
    },
  });
  await prisma.membership.create({
    data: {
      userId: ownerUser.id,
      businessId: collpro.id,
      role: "OWNER",
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: collpro.id,
      status: "SENT",
      total: new Prisma.Decimal("200.00"),
    },
  });

  console.log("\nDB — Preview-skip-migrate recovery when contact columns are missing");
  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicPhone"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicEmail"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicWebsite"`);

  let missingColumnsThrew = false;
  try {
    await prisma.membership.findMany({
      where: { userId: ownerUser.id, active: true },
      include: { business: true },
    });
  } catch {
    missingColumnsThrew = true;
  }
  check(
    "Workspace Business SELECT throws when public contact columns are missing (the #441 crash)",
    missingColumnsThrew,
  );

  resetBusinessPublicContactSchemaEnsure();
  const recoveredMemberships = await loadActiveWorkspaceMemberships(
    prisma,
    ownerUser.id,
  );
  check(
    "loadActiveWorkspaceMemberships recreates the columns and returns the tenant business",
    recoveredMemberships.length === 1 &&
      recoveredMemberships[0].business.id === collpro.id &&
      recoveredMemberships[0].business.publicPhone == null &&
      recoveredMemberships[0].business.publicEmail == null &&
      recoveredMemberships[0].business.publicWebsite == null,
  );

  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicPhone"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicEmail"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicWebsite"`);
  resetBusinessPublicContactSchemaEnsure();

  await ensureBusinessPublicContactSchema(prisma);
  const recoveredSettingsBusiness = await prisma.business.findFirst({
    where: { id: collpro.id },
    select: {
      id: true,
      publicPhone: true,
      publicEmail: true,
      publicWebsite: true,
    },
  });
  check(
    "Settings-style Business SELECT recovers missing contact columns and leaves them empty",
    recoveredSettingsBusiness?.id === collpro.id &&
      recoveredSettingsBusiness.publicPhone == null &&
      recoveredSettingsBusiness.publicEmail == null &&
      recoveredSettingsBusiness.publicWebsite == null,
  );

  const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  const otherAfter = await prisma.business.findUnique({
    where: { id: otherBiz.id },
    select: { publicPhone: true, publicEmail: true, publicWebsite: true },
  });
  check(
    "Recovering contact columns does not rewrite invoice totals",
    invoiceAfter.total.toString() === "200",
  );
  check(
    "Recovering contact columns does not leak CollPro contact onto the other tenant",
    otherAfter.publicPhone == null &&
      otherAfter.publicEmail == null &&
      otherAfter.publicWebsite == null,
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

console.log(
  failed === 0
    ? `\nAll business-contact checks passed (${passed}).`
    : `\n${failed} business-contact check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
