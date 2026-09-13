/**
 * Public intake customer-identity matching.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-public-intake-identity.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { createPublicServiceRequest } = await import("@/lib/public-intake");
const {
  decideCustomerMatch,
  normalizeEmail,
  normalizePhone,
  parseIntakeIdentityReview,
} = await import("@/lib/customer-identity");
const { requestNotesText } = await import("@/lib/work-area-intake");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const publicIntake = readRepo("src/lib/public-intake.ts");
const identitySrc = readRepo("src/lib/customer-identity.ts");

console.log("\nSTATIC — public intake never guesses customer identity");
check(
  "Public intake uses decideCustomerMatch",
  publicIntake.includes("decideCustomerMatch(existingCustomers"),
);
check(
  "Public intake no longer first-matches raw email then exact phone",
  !publicIntake.includes("where: { businessId: business.id, email }") &&
    !publicIntake.includes("where: { businessId: business.id, phone }"),
);
check(
  "Matching module does not use name or address as identity keys",
  identitySrc.includes("Name and address never establish identity") &&
    !identitySrc.includes("row.name") &&
    !identitySrc.includes("addressLine") &&
    !identitySrc.includes("submitted.name"),
);
check(
  "Conflicting identifiers create an identity-review flag instead of merging",
  publicIntake.includes("appendIntakeIdentityReview") &&
    identitySrc.includes("email_phone_conflict"),
);
check(
  "Repeat matches do not update stored name/email/phone",
  publicIntake.includes("Repeat matches keep the stored name/email/phone") &&
    !/customer\.update\(/.test(publicIntake),
);

console.log("\nUNIT — normalize and match decisions");
check("Email is trimmed and lowercased", normalizeEmail("  Tim@Example.COM ") === "tim@example.com");
check(
  "Phone digits and US country code normalize together",
  normalizePhone("(239) 357-8199") === "2393578199" &&
    normalizePhone("+1 239-357-8199") === "2393578199" &&
    normalizePhone("2393578199") === "2393578199",
);

const tim = {
  id: "cust_tim",
  name: "Tim trump",
  email: "tim.trump@example.com",
  phone: "239-555-0100",
};
const alex = {
  id: "cust_alex",
  name: "Alex Rivera",
  email: "alex.rivera@example.com",
  phone: "239-555-0199",
};

check(
  "New identifiers create a new customer",
  decideCustomerMatch([tim], {
    email: "new.person@example.com",
    phone: "239-555-0200",
  }).kind === "new",
);
check(
  "Exact email match reuses the existing customer",
  decideCustomerMatch([tim], {
    email: "TIM.TRUMP@example.com",
    phone: "555-0000",
  }).kind === "reuse" &&
    decideCustomerMatch([tim], {
      email: "TIM.TRUMP@example.com",
      phone: "555-0000",
    }).customer?.id === "cust_tim",
);
check(
  "Normalized phone match reuses the existing customer",
  decideCustomerMatch([tim], {
    email: "someone-else@example.com",
    phone: "+1 (239) 555-0100",
  }).kind === "reuse" &&
    decideCustomerMatch([tim], {
      email: "someone-else@example.com",
      phone: "+1 (239) 555-0100",
    }).customer?.id === "cust_tim",
);
check(
  "Name-only overlap does not match",
  decideCustomerMatch([tim], {
    email: "not-tim@example.com",
    phone: "239-555-0888",
  }).kind === "new",
);
check(
  "Email and phone pointing at different people is ambiguous",
  decideCustomerMatch([tim, alex], {
    email: "tim.trump@example.com",
    phone: "239-555-0199",
  }).kind === "ambiguous" &&
    decideCustomerMatch([tim, alex], {
      email: "tim.trump@example.com",
      phone: "239-555-0199",
    }).review?.reason === "email_phone_conflict",
);
check(
  "Duplicate emails fail closed",
  decideCustomerMatch(
    [tim, { ...tim, id: "cust_tim_dup", phone: "239-555-0777" }],
    { email: "tim.trump@example.com", phone: "239-555-0100" },
  ).kind === "ambiguous",
);

const testDbName = `tbbt_intake_identity_${randomUUID().slice(0, 8)}`;
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for public-intake-identity test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — public intake identity matching");
  const business = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  const mailbox = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Mailbox Replacement",
      category: "Exterior Repairs",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(175),
      active: true,
    },
  });
  const fan = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Ceiling Fan Replacement",
      category: "Fans & Fixtures",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(180),
      active: true,
    },
  });

  const newCustomer = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "First Time",
    email: "first.time@example.com",
    phone: "239-555-1000",
    address: "",
    streetAddress: "10 Pine St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Brand new.",
    catalogItemIds: [fan.id],
    includeOther: false,
    otherDescription: "",
  });
  const firstRequest = newCustomer.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: newCustomer.requestId },
        include: { customer: true },
      })
    : null;
  check("New customer intake creates a customer", newCustomer.ok === true && Boolean(firstRequest?.customerId));
  const firstCustomerCount = await prisma.customer.count({ where: { businessId: business.id } });
  check("First intake created exactly one customer", firstCustomerCount === 1);

  const repeatEmail = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "First Time Updated Name",
    email: "  FIRST.TIME@example.com ",
    phone: "239-555-1999",
    address: "",
    streetAddress: "22 Oak Ave",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    notes: "Repeat by email.",
    catalogItemIds: [fan.id],
    includeOther: false,
    otherDescription: "",
  });
  const repeatEmailRequest = repeatEmail.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: repeatEmail.requestId },
        include: { customer: true, property: true },
      })
    : null;
  check(
    "Repeat by email reuses the existing customer",
    repeatEmailRequest?.customerId === firstRequest?.customerId,
  );
  check(
    "Repeat by email does not overwrite name, email, or phone",
    repeatEmailRequest?.customer?.name === "First Time" &&
      repeatEmailRequest?.customer?.email === "first.time@example.com" &&
      repeatEmailRequest?.customer?.phone === "239-555-1000",
  );
  check(
    "Repeat customer can still add a new property",
    Boolean(repeatEmailRequest?.propertyId) &&
      repeatEmailRequest?.propertyId !== firstRequest?.propertyId,
  );

  const repeatPhone = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Phone Repeat",
    email: "phone.repeat@example.com",
    phone: "+1 (239) 555-1000",
    address: "",
    streetAddress: "10 Pine St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Repeat by normalized phone.",
    catalogItemIds: [fan.id],
    includeOther: false,
    otherDescription: "",
  });
  const repeatPhoneRequest = repeatPhone.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: repeatPhone.requestId },
        include: { customer: true },
      })
    : null;
  check(
    "Repeat by normalized phone reuses the existing customer",
    repeatPhoneRequest?.customerId === firstRequest?.customerId,
  );
  check(
    "Repeat by phone does not overwrite identity fields",
    repeatPhoneRequest?.customer?.name === "First Time" &&
      repeatPhoneRequest?.customer?.email === "first.time@example.com",
  );

  const tim = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Tim trump",
      email: "tim.trump@example.com",
      phone: "239-555-0101",
    },
  });
  const timProperty = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: tim.id,
      addressLine1: "88 Harbor Ave",
      city: "Cape Coral",
      region: "FL",
      postalCode: "33904",
    },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      customerId: tim.id,
      propertyId: timProperty.id,
      summary: "Fan install",
      description: "Earlier test request",
    },
  });

  const mailboxIntake = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Alex Rivera",
    email: "alex.rivera@example.com",
    phone: "239-555-0444",
    address: "",
    streetAddress: "88 Harbor Ave",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    notes: "Need the mailbox replaced.",
    catalogItemIds: [mailbox.id],
    includeOther: false,
    otherDescription: "",
  });
  const mailboxRequest = mailboxIntake.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: mailboxIntake.requestId },
        include: { customer: true, property: true, items: { include: { serviceCatalogItem: true } } },
      })
    : null;
  check("Mailbox Replacement intake succeeds", mailboxIntake.ok === true);
  check(
    "Mailbox Replacement with a reused address does not attach to Tim trump",
    mailboxRequest?.customerId !== tim.id && mailboxRequest?.customer?.name === "Alex Rivera",
  );
  check(
    "Tim trump identity is unchanged after the reused-address intake",
    (await prisma.customer.findUnique({ where: { id: tim.id } }))?.name === "Tim trump" &&
      (await prisma.customer.findUnique({ where: { id: tim.id } }))?.email === "tim.trump@example.com" &&
      (await prisma.customer.findUnique({ where: { id: tim.id } }))?.phone === "239-555-0101",
  );
  check(
    "Mailbox Replacement is stored on the new customer, not Tim's property",
    mailboxRequest?.items[0]?.serviceCatalogItem?.name === "Mailbox Replacement" &&
      mailboxRequest?.propertyId !== timProperty.id,
  );

  const sameName = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Tim trump",
    email: "another.tim@example.com",
    phone: "239-555-0666",
    address: "",
    streetAddress: "1 Different Rd",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Same name is not identity.",
    catalogItemIds: [mailbox.id],
    includeOther: false,
    otherDescription: "",
  });
  const sameNameRequest = sameName.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: sameName.requestId } })
    : null;
  check(
    "Name alone does not attach a new request to Tim trump",
    sameNameRequest?.customerId !== tim.id,
  );

  const other = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Pat Other",
      email: "pat.other@example.com",
      phone: "239-555-0777",
    },
  });
  const conflict = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Conflicting Person",
    email: "tim.trump@example.com",
    phone: "239-555-0777",
    address: "",
    streetAddress: "9 Conflict St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Email is Tim, phone is Pat.",
    catalogItemIds: [mailbox.id],
    includeOther: false,
    otherDescription: "",
  });
  const conflictRequest = conflict.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: conflict.requestId },
        include: { customer: true },
      })
    : null;
  const review = parseIntakeIdentityReview(conflictRequest?.description);
  check("Conflicting email and phone still create the request", conflict.ok === true);
  check(
    "Conflicting identifiers do not attach to Tim or Pat",
    conflictRequest?.customerId !== tim.id &&
      conflictRequest?.customerId !== other.id &&
      conflictRequest?.customer?.name === "Conflicting Person",
  );
  check(
    "Conflicting identifiers flag the request for owner review",
    review?.reason === "email_phone_conflict",
  );
  check(
    "Owner-facing notes still show the customer message without the encoded flag",
    requestNotesText(conflictRequest?.description) === "Email is Tim, phone is Pat.",
  );
  const timAfter = await prisma.customer.findUnique({ where: { id: tim.id } });
  const patAfter = await prisma.customer.findUnique({ where: { id: other.id } });
  check(
    "Conflicting intake does not mutate the existing customers",
    timAfter?.name === "Tim trump" &&
      timAfter?.email === "tim.trump@example.com" &&
      timAfter?.phone === "239-555-0101" &&
      patAfter?.name === "Pat Other" &&
      patAfter?.email === "pat.other@example.com" &&
      patAfter?.phone === "239-555-0777",
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failed === 0
    ? `\nAll public-intake-identity checks passed (${passed}).`
    : `\n${failed} public-intake-identity check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
