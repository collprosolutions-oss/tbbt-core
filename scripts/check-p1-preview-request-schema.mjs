/**
 * P1-02 — Preview request paths must not execute schema DDL/backfill
 * against shared production state. Founder decision: fail closed.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-p1-preview-request-schema.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";
import {
  classifyRequestPathSql,
  isPreviewSharedProductionRuntime,
  planRequestPathSchemaEnsure,
  requestPathSchemaWritesBlocked,
} from "./production-migrate-policy.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  ensureSaasBillingSchema,
  resetSaasBillingSchemaEnsure,
  SAAS_BILLING_ENSURE_SQL,
  SAAS_FOUNDER_TRIAL_BACKFILL_SQL,
} = await import("@/lib/saas-billing/schema");
const { RequestPathSchemaUnavailableError } = await import("@/lib/request-path-schema");
const { requireWorkspace } = await import("@/lib/workspace");
const {
  ensureBusinessPublicContactSchema,
  resetBusinessPublicContactSchemaEnsure,
} = await import("@/lib/business-contact");

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

function sqlText(arg) {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object") {
    if (Array.isArray(arg.strings)) return arg.strings.join("?");
    if (typeof arg.sql === "string") return arg.sql;
    if (typeof arg.text === "string") return arg.text;
  }
  return String(arg ?? "");
}

function instrumentPrisma(prisma) {
  const statements = [];
  const rawNames = new Set([
    "$executeRaw",
    "$executeRawUnsafe",
    "$queryRaw",
    "$queryRawUnsafe",
  ]);
  const client = new Proxy(prisma, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && rawNames.has(prop) && typeof value === "function") {
        return async (...args) => {
          statements.push({ name: prop, sql: sqlText(args[0]) });
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
  return { client, statements };
}

function recordedWrites(statements) {
  return statements.filter((row) => {
    const kind = classifyRequestPathSql(row.sql);
    return kind.schemaDdl || kind.backfillDml;
  });
}

console.log("\nSTATIC — request path is not a second migration engine");
const workspaceSrc = readRepo("src/lib/workspace.ts");
const policySrc = readRepo("scripts/production-migrate-policy.mjs");
const billingSrc = readRepo("src/lib/saas-billing/schema.ts");
const contactSrc = readRepo("src/lib/business-contact.ts");
check(
  "Workspace request path no longer calls schema-ensure DDL modules",
  !workspaceSrc.includes("ensureAppointmentConfirmationSchema") &&
    !workspaceSrc.includes("ensureFirstRunSetupSchema") &&
    !workspaceSrc.includes("ensureStarterServicesSetupSchema") &&
    !workspaceSrc.includes("ensureWebsiteSetupSchema") &&
    !workspaceSrc.includes("ensureSaasBillingSchema") &&
    !workspaceSrc.includes("ensureBusinessTimezoneSchema") &&
    !workspaceSrc.includes("ensureCustomerMessagingSchema") &&
    workspaceSrc.includes("loadActiveWorkspaceMemberships") &&
    workspaceSrc.includes("fail closed"),
);
check(
  "Migrate policy exports a Preview/shared-production request-path write ban",
  policySrc.includes("REQUEST_PATH_SCHEMA_WRITES_BLOCKED") &&
    policySrc.includes("isPreviewSharedProductionRuntime") &&
    policySrc.includes("planRequestPathSchemaEnsure") &&
    requestPathSchemaWritesBlocked() === true &&
    isPreviewSharedProductionRuntime({ vercelEnv: "preview" }) === true,
);
check(
  "SaaS billing ensure is a presence probe and does not $executeRawUnsafe",
  billingSrc.includes("assertSaasBillingSchemaPresent") &&
    !billingSrc.includes("$executeRawUnsafe") &&
    billingSrc.includes("Never execute from a request path"),
);
check(
  "Business contact ensure is a presence probe and does not ADD COLUMN",
  contactSrc.includes("assertRequiredColumnsExist") &&
    !contactSrc.includes("ADD COLUMN IF NOT EXISTS") &&
    !contactSrc.includes("$executeRawUnsafe"),
);

const vulnerablePlan = planRequestPathSchemaEnsure({
  statements: [...SAAS_BILLING_ENSURE_SQL, SAAS_FOUNDER_TRIAL_BACKFILL_SQL],
});
check(
  "Historical request-path billing SQL is classified as a forbidden migration engine",
  vulnerablePlan.allowed === false &&
    vulnerablePlan.failClosed === true &&
    classifyRequestPathSql(SAAS_BILLING_ENSURE_SQL[0]).schemaDdl === true &&
    classifyRequestPathSql(SAAS_FOUNDER_TRIAL_BACKFILL_SQL).backfillDml === true,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "P1-02 preview request-schema disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_p1_preview_schema",
});
const prisma = session.prisma;

try {
  console.log("\nDYNAMIC — Preview-mode requireWorkspace on an instrumented client");
  process.env.VERCEL_ENV = "preview";

  const owner = await prisma.user.create({
    data: {
      name: "Preview Owner",
      email: `preview-owner-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: {
      name: "Preview Shared Prod Co",
      slug: `preview-shared-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: owner.id, businessId: business.id, role: "OWNER" },
  });

  const instrumented = instrumentPrisma(prisma);
  resetSaasBillingSchemaEnsure();
  resetBusinessPublicContactSchemaEnsure();
  const workspace = await requireWorkspace({
    db: instrumented.client,
    getSessionUser: async () => ({
      id: owner.id,
      email: owner.email,
      name: owner.name,
      sessionId: "preview-session",
      totpEnabled: false,
    }),
    getWorkspaceCookie: async () => business.id,
    setWorkspaceCookie: async () => {},
    redirect: (path) => {
      throw new Error(`unexpected redirect:${path}`);
    },
  });
  const workspaceWrites = recordedWrites(instrumented.statements);
  check(
    "Preview requireWorkspace resolves the active workspace",
    workspace.business.id === business.id &&
      workspace.membership.id === membership.id &&
      workspace.role === "OWNER",
  );
  check(
    "Preview requireWorkspace executes zero raw schema DDL",
    workspaceWrites.filter((row) => classifyRequestPathSql(row.sql).schemaDdl).length === 0,
  );
  check(
    "Preview requireWorkspace executes zero backfill DML",
    workspaceWrites.filter((row) => classifyRequestPathSql(row.sql).backfillDml).length === 0,
  );
  check(
    "Ordinary workspace load is not a second migration engine",
    planRequestPathSchemaEnsure({
      statements: instrumented.statements.map((row) => row.sql),
    }).allowed === true,
  );

  resetSaasBillingSchemaEnsure();
  const billingProbe = instrumentPrisma(prisma);
  await ensureSaasBillingSchema(billingProbe.client);
  check(
    "ensureSaasBillingSchema is a compatible-read presence probe when schema exists",
    recordedWrites(billingProbe.statements).length === 0 &&
      billingProbe.statements.every((row) => /information_schema|pg_tables/i.test(row.sql)),
  );

  console.log("\nDYNAMIC — missing required schema fail-closes without DDL");
  await prisma.$executeRawUnsafe(`ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicPhone"`);
  resetBusinessPublicContactSchemaEnsure();
  const missingContact = instrumentPrisma(prisma);
  let contactError = null;
  try {
    await requireWorkspace({
      db: missingContact.client,
      getSessionUser: async () => ({
        id: owner.id,
        email: owner.email,
        name: owner.name,
        sessionId: "preview-session",
        totpEnabled: false,
      }),
      getWorkspaceCookie: async () => business.id,
      setWorkspaceCookie: async () => {},
      redirect: (path) => {
        throw new Error(`unexpected redirect:${path}`);
      },
    });
  } catch (error) {
    contactError = error;
  }
  const contactWrites = recordedWrites(missingContact.statements);
  check(
    "Missing publicPhone fail-closes requireWorkspace",
    contactError instanceof RequestPathSchemaUnavailableError &&
      contactError.failClosed === true &&
      /publicPhone/i.test(contactError.message) &&
      /fail closed/i.test(contactError.message),
  );
  check(
    "Missing publicPhone does not run schema DDL or backfill DML",
    contactWrites.length === 0,
  );
  const phoneColumns = await prisma.$queryRaw`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'publicPhone'
  `;
  check("Dropped publicPhone is still absent after the fail-closed probe", phoneColumns.length === 0);

  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessSaasSubscription"`);
  resetSaasBillingSchemaEnsure();
  const missingBilling = instrumentPrisma(prisma);
  let billingError = null;
  try {
    await ensureSaasBillingSchema(missingBilling.client);
  } catch (error) {
    billingError = error;
  }
  check(
    "Missing BusinessSaasSubscription fail-closes billing ensure",
    billingError instanceof RequestPathSchemaUnavailableError &&
      billingError.failClosed === true &&
      /BusinessSaasSubscription/i.test(billingError.message),
  );
  check(
    "Missing billing table does not recreate schema or backfill rows",
    recordedWrites(missingBilling.statements).length === 0,
  );
} finally {
  await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll P1-02 preview request-schema checks passed (${passed}).`
    : `\n${failed} P1-02 preview request-schema check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
