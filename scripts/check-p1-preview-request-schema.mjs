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
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  loadJobAftercareReview,
  loadPublishedAftercareForProjectToken,
} = await import("@/lib/job-aftercare-data");
const {
  loadOwnedJobReassignmentRequests,
  loadSelfJobReassignmentRequests,
} = await import("@/lib/job-reassignment-request-ops");
const {
  JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE,
  missingJobReassignmentRequestSchema,
} = await import("@/lib/job-reassignment-request");
const { loadScheduleCalendarSubscriptionStatus } = await import(
  "@/lib/schedule-calendar-subscription"
);
const {
  countActiveProjectDocuments,
  listProjectDocumentsForOwnerReview,
  listProjectDocumentsForPortal,
} = await import("@/lib/business-storage/project-documents");
const { recordProjectDocumentReview } = await import(
  "@/lib/project-document-review-ops"
);
const { PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE } = await import(
  "@/lib/project-document-review"
);
const { requireWorkspace } = await import("@/lib/workspace-request");
const {
  ensureBusinessPublicContactSchema,
  resetBusinessPublicContactSchemaEnsure,
} = await import("@/lib/business-contact");
const {
  ensureFirstRunSetupSchema,
  resetFirstRunSetupSchemaEnsure,
  FIRST_RUN_SETUP_ENSURE_SQL,
} = await import("@/lib/first-run-setup");
const {
  ensureStarterServicesSetupSchema,
  resetStarterServicesSetupSchemaEnsure,
  STARTER_SERVICES_SETUP_ENSURE_SQL,
} = await import("@/lib/starter-services-setup");
const {
  ensureWebsiteSetupSchema,
  resetWebsiteSetupSchemaEnsure,
  WEBSITE_SETUP_ENSURE_SQL,
  PUBLIC_SERVICE_AREA_LABEL_ENSURE_SQL,
} = await import("@/lib/website-setup");
const {
  ensureBusinessTimezoneSchema,
  resetBusinessTimezoneSchemaEnsure,
  BUSINESS_TIMEZONE_ENSURE_SQL,
} = await import("@/lib/business-timezone");
const {
  ensureAppointmentConfirmationSchema,
  resetAppointmentConfirmationSchemaEnsure,
  ENSURE_APPOINTMENT_SQL,
} = await import("@/lib/appointment-data");
const {
  ensureBusinessEstimatingDefaultTable,
  resetBusinessEstimatingDefaultTableEnsure,
  CREATE_BUSINESS_ESTIMATING_DEFAULT_TABLE_SQL,
} = await import("@/lib/estimating-defaults-db");
const {
  ensurePaymentTable,
  resetPaymentTableEnsure,
  CREATE_PAYMENT_TABLE_SQL,
} = await import("@/lib/project-payments");
const {
  ensureMaterialPriceEngineTables,
  resetMaterialPriceEngineTablesEnsure,
  CREATE_PRICE_SQL,
} = await import("@/lib/material-pricing/db");
const {
  ensureCustomerMessagingSchema,
  resetCustomerMessagingSchemaEnsure,
  CUSTOMER_MESSAGING_ENSURE_SQL,
} = await import("@/lib/customer-messaging/schema");
const {
  ensureBusinessAvailabilitySchema,
  resetBusinessAvailabilitySchemaEnsure,
  ENSURE_AVAILABILITY_SQL,
} = await import("@/lib/availability-data");
const {
  repairMisfiledChangeRequestAccessFields,
  REPAIR_MISFILED_CHANGE_REQUEST_ACCESS_SQL,
} = await import("@/lib/appointment-change-request");

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
const workspaceRequestSrc = readRepo("src/lib/workspace-request.ts");
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
    workspaceSrc.includes("fail closed") &&
    workspaceSrc.includes("requireWorkspaceFromRequest") &&
    workspaceRequestSrc.includes("loadActiveWorkspaceMemberships") &&
    !workspaceRequestSrc.includes("$executeRaw") &&
    !workspaceRequestSrc.includes("ensureSaasBillingSchema"),
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
const convertedEnsureFiles = [
  "src/lib/first-run-setup.ts",
  "src/lib/starter-services-setup.ts",
  "src/lib/website-setup.ts",
  "src/lib/business-timezone.ts",
  "src/lib/appointment-data.ts",
  "src/lib/estimating-defaults-db.ts",
  "src/lib/project-payments.ts",
  "src/lib/material-pricing/db.ts",
  "src/lib/customer-messaging/schema.ts",
  "src/lib/availability-data.ts",
];
check(
  "Converted ensure helpers fail closed and do not $executeRawUnsafe",
  convertedEnsureFiles.every((rel) => {
    const src = readRepo(rel);
    return (
      src.includes("assertRequired") &&
      !src.includes("$executeRawUnsafe") &&
      /fail closed/i.test(src)
    );
  }) &&
    !readRepo("src/lib/appointment-data.ts").includes("repairMisfiledChangeRequestAccessFields") &&
    readRepo("src/lib/appointment-change-request.ts").includes(
      "not a request-path operation",
    ),
);
const aftercareDataSrc = readRepo("src/lib/job-aftercare-data.ts");
const aftercareOpsSrc = readRepo("src/lib/job-aftercare-ops.ts");
const aftercareActionSrc = readRepo("src/app/actions/job-aftercare.ts");
const reassignmentRequestSrc = readRepo("src/lib/job-reassignment-request.ts");
const reassignmentOpsSrc = readRepo("src/lib/job-reassignment-request-ops.ts");
const reassignmentActionSrc = readRepo("src/app/actions/job-reassignment-request.ts");
check(
  "Job aftercare request paths do not ensure or CREATE JobAftercare tables",
  aftercareDataSrc.includes("missingJobAftercareSchema") &&
    aftercareDataSrc.includes("if (missingJobAftercareSchema(error)) return null") &&
    !aftercareDataSrc.includes("$executeRaw") &&
    !aftercareDataSrc.includes("CREATE TABLE") &&
    !aftercareOpsSrc.includes("$executeRaw") &&
    !aftercareOpsSrc.includes("CREATE TABLE") &&
    !aftercareActionSrc.includes("$executeRaw") &&
    !aftercareActionSrc.includes("CREATE TABLE") &&
    aftercareOpsSrc.includes("JOB_AFTERCARE_UNAVAILABLE_MESSAGE"),
);
const calendarSubscriptionOpsSrc = readRepo(
  "src/lib/schedule-calendar-subscription/ops.ts",
);
const calendarSubscriptionFeedSrc = readRepo(
  "src/lib/schedule-calendar-subscription/feed.ts",
);
const calendarSubscriptionActionSrc = readRepo(
  "src/app/actions/schedule-calendar-subscription.ts",
);
check(
  "Calendar subscription request paths do not ensure or CREATE ScheduleCalendarSubscription",
  calendarSubscriptionOpsSrc.includes("missingScheduleCalendarSubscriptionSchema") &&
    calendarSubscriptionFeedSrc.includes("missingScheduleCalendarSubscriptionSchema") &&
    !calendarSubscriptionOpsSrc.includes("$executeRaw") &&
    !calendarSubscriptionOpsSrc.includes("CREATE TABLE") &&
    !calendarSubscriptionFeedSrc.includes("$executeRaw") &&
    !calendarSubscriptionFeedSrc.includes("CREATE TABLE") &&
    !calendarSubscriptionActionSrc.includes("$executeRaw") &&
    !calendarSubscriptionActionSrc.includes("CREATE TABLE") &&
    calendarSubscriptionOpsSrc.includes("SCHEDULE_CALENDAR_SUBSCRIPTION_UNAVAILABLE_MESSAGE"),
);
check(
  "Job reassignment-request loaders degrade on a missing table and never CREATE it",
  reassignmentRequestSrc.includes("missingJobReassignmentRequestSchema") &&
    reassignmentOpsSrc.includes("if (missingJobReassignmentRequestSchema(error)) return []") &&
    reassignmentOpsSrc.includes("JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE") &&
    !reassignmentOpsSrc.includes("$executeRaw") &&
    !reassignmentOpsSrc.includes("CREATE TABLE") &&
    !reassignmentActionSrc.includes("$executeRaw") &&
    !reassignmentActionSrc.includes("CREATE TABLE") &&
    missingJobReassignmentRequestSchema({ code: "P2021" }) &&
    missingJobReassignmentRequestSchema({ code: "P2022" }) &&
    !missingJobReassignmentRequestSchema({ code: "P2002" }) &&
    JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE.includes("not available yet"),
);
const projectDocumentReviewDataSrc = readRepo(
  "src/lib/business-storage/project-documents.ts",
);
const projectDocumentReviewOpsSrc = readRepo(
  "src/lib/project-document-review-ops.ts",
);
const projectDocumentReviewActionSrc = readRepo(
  "src/app/actions/project-document-review.ts",
);
check(
  "Project document review request paths do not ensure or CREATE ProjectDocumentReview",
  projectDocumentReviewDataSrc.includes("missingProjectDocumentReviewSchema") &&
    projectDocumentReviewDataSrc.includes(
      "if (missingProjectDocumentReviewSchema(error)) return []",
    ) &&
    projectDocumentReviewDataSrc.includes(
      "if (missingProjectDocumentReviewSchema(error)) {",
    ) &&
    projectDocumentReviewDataSrc.includes("to_regclass('\"ProjectDocumentReview\"')") &&
    !projectDocumentReviewDataSrc.includes("$executeRaw") &&
    !projectDocumentReviewDataSrc.includes("CREATE TABLE") &&
    !projectDocumentReviewOpsSrc.includes("$executeRaw") &&
    !projectDocumentReviewOpsSrc.includes("CREATE TABLE") &&
    !projectDocumentReviewActionSrc.includes("$executeRaw") &&
    !projectDocumentReviewActionSrc.includes("CREATE TABLE") &&
    projectDocumentReviewOpsSrc.includes(
      "PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE",
    ),
);
check(
  "Historical founder access-repair SQL is classified as forbidden backfill",
  classifyRequestPathSql(REPAIR_MISFILED_CHANGE_REQUEST_ACCESS_SQL).backfillDml === true &&
    planRequestPathSchemaEnsure({
      statements: [REPAIR_MISFILED_CHANGE_REQUEST_ACCESS_SQL],
    }).allowed === false,
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

  const helperCases = [
    {
      name: "first-run setup",
      reset: resetFirstRunSetupSchemaEnsure,
      ensure: ensureFirstRunSetupSchema,
      missingPattern: /firstRunSetupCompletedAt/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "firstRunSetupCompletedAt"`,
        );
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(FIRST_RUN_SETUP_ENSURE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Business'
            AND column_name = 'firstRunSetupCompletedAt'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "starter-services setup",
      reset: resetStarterServicesSetupSchemaEnsure,
      ensure: ensureStarterServicesSetupSchema,
      missingPattern: /starterServicesSetupCompletedAt/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "starterServicesSetupChoice"`,
        );
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "starterServicesSetupCompletedAt"`,
        );
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(STARTER_SERVICES_SETUP_ENSURE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Business'
            AND column_name = 'starterServicesSetupCompletedAt'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "website setup",
      reset: resetWebsiteSetupSchemaEnsure,
      ensure: ensureWebsiteSetupSchema,
      missingPattern: /websiteSetupCompletedAt|publicServiceAreaLabel/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "websiteSetupChoice"`,
        );
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "websiteSetupCompletedAt"`,
        );
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "publicServiceAreaLabel"`,
        );
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(WEBSITE_SETUP_ENSURE_SQL);
        await db.$executeRawUnsafe(PUBLIC_SERVICE_AREA_LABEL_ENSURE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Business'
            AND column_name = 'websiteSetupCompletedAt'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "business timezone",
      reset: resetBusinessTimezoneSchemaEnsure,
      ensure: ensureBusinessTimezoneSchema,
      missingPattern: /timezone/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(
          `ALTER TABLE "Business" DROP COLUMN IF EXISTS "timezone"`,
        );
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(BUSINESS_TIMEZONE_ENSURE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Business'
            AND column_name = 'timezone'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "appointment confirmation",
      reset: resetAppointmentConfirmationSchemaEnsure,
      ensure: ensureAppointmentConfirmationSchema,
      missingPattern: /JobAppointmentEvent/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobAppointmentEvent" CASCADE`);
      },
      restore: async (db) => {
        for (const statement of ENSURE_APPOINTMENT_SQL) {
          await db.$executeRawUnsafe(statement);
        }
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'JobAppointmentEvent'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "estimating defaults",
      reset: resetBusinessEstimatingDefaultTableEnsure,
      ensure: ensureBusinessEstimatingDefaultTable,
      missingPattern: /BusinessEstimatingDefault/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessEstimatingDefault" CASCADE`);
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(CREATE_BUSINESS_ESTIMATING_DEFAULT_TABLE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'BusinessEstimatingDefault'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "project payments",
      reset: resetPaymentTableEnsure,
      ensure: ensurePaymentTable,
      missingPattern: /Payment/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "Payment" CASCADE`);
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(CREATE_PAYMENT_TABLE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'Payment'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "material price engine",
      reset: resetMaterialPriceEngineTablesEnsure,
      ensure: ensureMaterialPriceEngineTables,
      missingPattern: /SupplierPriceRecord/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "SupplierPriceRecord" CASCADE`);
      },
      restore: async (db) => {
        await db.$executeRawUnsafe(CREATE_PRICE_SQL);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'SupplierPriceRecord'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "customer messaging",
      reset: resetCustomerMessagingSchemaEnsure,
      ensure: ensureCustomerMessagingSchema,
      missingPattern: /CustomerCommunication/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "CustomerCommunication" CASCADE`);
      },
      restore: async (db) => {
        const create = CUSTOMER_MESSAGING_ENSURE_SQL.find((sql) =>
          sql.includes('CREATE TABLE IF NOT EXISTS "CustomerCommunication"'),
        );
        await db.$executeRawUnsafe(create);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'CustomerCommunication'
        `;
        return rows.length === 0;
      },
    },
    {
      name: "availability",
      reset: resetBusinessAvailabilitySchemaEnsure,
      ensure: ensureBusinessAvailabilitySchema,
      missingPattern: /BusinessUnavailableDate/i,
      drop: async (db) => {
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessUnavailableDate" CASCADE`);
      },
      restore: async (db) => {
        const create = ENSURE_AVAILABILITY_SQL.find((sql) =>
          sql.includes('CREATE TABLE IF NOT EXISTS "BusinessUnavailableDate"'),
        );
        await db.$executeRawUnsafe(create);
      },
      stillMissing: async (db) => {
        const rows = await db.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'BusinessUnavailableDate'
        `;
        return rows.length === 0;
      },
    },
  ];

  console.log("\nDYNAMIC — converted helpers: current schema + missing object, Preview and Production");
  for (const helper of helperCases) {
    for (const env of ["preview", "production"]) {
      process.env.VERCEL_ENV = env;
      helper.reset();
      const present = instrumentPrisma(prisma);
      await helper.ensure(present.client);
      const presentWrites = recordedWrites(present.statements);
      check(
        `${env} ${helper.name} current schema is a presence probe`,
        presentWrites.length === 0 &&
          present.statements.every((row) => /information_schema|pg_tables/i.test(row.sql)),
      );

      await helper.drop(prisma);
      helper.reset();
      const missing = instrumentPrisma(prisma);
      let missingError = null;
      try {
        await helper.ensure(missing.client);
      } catch (error) {
        missingError = error;
      }
      const missingWrites = recordedWrites(missing.statements);
      check(
        `${env} ${helper.name} missing object → RequestPathSchemaUnavailableError`,
        missingError instanceof RequestPathSchemaUnavailableError &&
          missingError.failClosed === true &&
          helper.missingPattern.test(missingError.message),
      );
      check(
        `${env} ${helper.name} zero schema DDL`,
        missingWrites.filter((row) => classifyRequestPathSql(row.sql).schemaDdl).length === 0,
      );
      check(
        `${env} ${helper.name} zero backfill/repair DML`,
        missingWrites.filter((row) => classifyRequestPathSql(row.sql).backfillDml).length === 0,
      );
      check(
        `${env} ${helper.name} missing schema is not recreated`,
        await helper.stillMissing(prisma),
      );
      await helper.restore(prisma);
    }
  }

  process.env.VERCEL_ENV = "preview";
  const repairProbe = instrumentPrisma(prisma);
  let repairError = null;
  try {
    await repairMisfiledChangeRequestAccessFields(repairProbe.client);
  } catch (error) {
    repairError = error;
  }
  check(
    "Preview repairMisfiledChangeRequestAccessFields fail-closes without DML",
    repairError instanceof RequestPathSchemaUnavailableError &&
      recordedWrites(repairProbe.statements).length === 0,
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

  console.log("\nDYNAMIC — missing JobReassignmentRequest degrades without DDL");
  await prisma.businessSaasSubscription.upsert({
    where: { businessId: business.id },
    update: { status: "active", planCode: "FOUNDER", legacyExempt: true },
    create: { businessId: business.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  const reassignmentAccess = {
    businessId: business.id,
    workspace: {
      role: "OWNER",
      membership: { id: membership.id },
      user: { id: owner.id, email: owner.email, name: owner.name },
      business: { id: business.id, name: business.name },
    },
    scope: businessScope(business.id),
    assertOwned(record) {
      return assertBusinessRecord(record, business.id);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, business.id);
    },
  };
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobReassignmentRequest" CASCADE`);
  const reassignmentProbe = instrumentPrisma(prisma);
  let selfReassignment = "threw";
  let ownedReassignment = "threw";
  let reassignmentLoadError = null;
  try {
    selfReassignment = await loadSelfJobReassignmentRequests(reassignmentProbe.client, {
      businessId: business.id,
      membershipId: membership.id,
    });
    ownedReassignment = await loadOwnedJobReassignmentRequests(
      reassignmentProbe.client,
      reassignmentAccess,
    );
  } catch (error) {
    reassignmentLoadError = error;
  }
  const reassignmentWrites = recordedWrites(reassignmentProbe.statements);
  const reassignmentTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'JobReassignmentRequest'
  `;
  check(
    "Preview loaders return empty lists for missing JobReassignmentRequest",
    Array.isArray(selfReassignment) &&
      selfReassignment.length === 0 &&
      ownedReassignment !== "threw" &&
      ownedReassignment.pending.length === 0 &&
      ownedReassignment.recent.length === 0 &&
      reassignmentLoadError === null,
  );
  check(
    "Missing JobReassignmentRequest does not run schema DDL or backfill DML",
    reassignmentWrites.length === 0,
  );
  check(
    "Dropped JobReassignmentRequest stays absent after the request-path load",
    reassignmentTables.length === 0,
  );

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

  console.log("\nDYNAMIC — missing JobAftercare tables degrade without DDL");
  const aftercareToken = `preview-aftercare-${randomUUID()}`;
  const aftercareJob = await prisma.job.create({
    data: {
      businessId: business.id,
      status: "COMPLETED",
      projectToken: aftercareToken,
    },
  });
  const aftercareAccess = {
    businessId: business.id,
    workspace: {
      role: "OWNER",
      membership: { id: membership.id },
      user: { id: owner.id, email: owner.email, name: owner.name },
      business: { id: business.id, name: business.name },
    },
    scope: businessScope(business.id),
    assertOwned(record) {
      return assertBusinessRecord(record, business.id);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, business.id);
    },
  };
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobAftercareEvent" CASCADE`);
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "JobAftercareInstruction" CASCADE`,
  );
  const aftercareProbe = instrumentPrisma(prisma);
  let tokenAftercare = "threw";
  let ownerAftercare = "threw";
  let aftercareLoadError = null;
  try {
    tokenAftercare = await loadPublishedAftercareForProjectToken(
      aftercareProbe.client,
      aftercareToken,
    );
    ownerAftercare = await loadJobAftercareReview(
      aftercareProbe.client,
      aftercareAccess,
      aftercareJob.id,
    );
  } catch (error) {
    aftercareLoadError = error;
  }
  const aftercareWrites = recordedWrites(aftercareProbe.statements);
  const aftercareTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobAftercareInstruction', 'JobAftercareEvent')
  `;
  check(
    "Preview loaders return null for missing JobAftercareInstruction/JobAftercareEvent",
    tokenAftercare === null &&
      ownerAftercare === null &&
      aftercareLoadError === null,
  );
  check(
    "Missing aftercare tables do not run schema DDL or backfill DML",
    aftercareWrites.length === 0,
  );
  check(
    "Dropped JobAftercare tables stay absent after the request-path load",
    aftercareTables.length === 0,
  );

  console.log("\nDYNAMIC — missing ScheduleCalendarSubscription degrades without DDL");
  const calendarAccess = {
    businessId: business.id,
    workspace: {
      role: "OWNER",
      membership: { id: membership.id, active: true },
      user: { id: owner.id, email: owner.email, name: owner.name },
      business: { id: business.id, name: business.name },
    },
    scope: businessScope(business.id),
    assertOwned(record) {
      return assertBusinessRecord(record, business.id);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, business.id);
    },
  };
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "ScheduleCalendarSubscription" CASCADE`,
  );
  const calendarProbe = instrumentPrisma(prisma);
  let calendarStatus = "threw";
  let calendarLoadError = null;
  try {
    calendarStatus = await loadScheduleCalendarSubscriptionStatus(
      calendarProbe.client,
      calendarAccess,
      "business",
    );
  } catch (error) {
    calendarLoadError = error;
  }
  const calendarWrites = recordedWrites(calendarProbe.statements);
  const calendarTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('ScheduleCalendarSubscription')
  `;
  check(
    "Preview loader degrades for missing ScheduleCalendarSubscription",
    calendarStatus !== "threw" &&
      calendarStatus.available === false &&
      calendarStatus.active === false &&
      calendarLoadError === null,
  );
  check(
    "Missing ScheduleCalendarSubscription does not run schema DDL or backfill DML",
    calendarWrites.length === 0,
  );
  check(
    "Dropped ScheduleCalendarSubscription stays absent after the request-path load",
    calendarTables.length === 0,
  );

  console.log("\nDYNAMIC — missing ProjectDocumentReview degrades without DDL");
  const reviewToken = `preview-pdoc-review-${randomUUID()}`;
  const reviewJob = await prisma.job.create({
    data: {
      businessId: business.id,
      status: "SCHEDULED",
      projectToken: reviewToken,
    },
  });
  const reviewAccess = {
    businessId: business.id,
    workspace: {
      role: "OWNER",
      membership: { id: membership.id },
      user: { id: owner.id, email: owner.email, name: owner.name },
      business: { id: business.id, name: business.name },
    },
    scope: businessScope(business.id),
    assertOwned(record) {
      return assertBusinessRecord(record, business.id);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, business.id);
    },
  };
  const reviewAccount = await prisma.businessStorageAccount.create({
    data: {
      businessId: business.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "preview-pdoc-review",
      namespacePrefix: `businesses/${business.id}`,
      storageLimitBytes: 50 * 1024 * 1024,
    },
  });
  const reviewAsset = await prisma.storedAsset.create({
    data: {
      businessId: business.id,
      storageAccountId: reviewAccount.id,
      jobId: reviewJob.id,
      category: "DOCUMENT",
      purpose: "project-portal-document",
      originalFilename: "preview.pdf",
      storageKey: `businesses/${business.id}/documents/preview.pdf`,
      mimeType: "application/pdf",
      fileSizeBytes: 1024,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "ProjectDocumentReview" CASCADE`);
  const reviewProbe = instrumentPrisma(prisma);
  let portalDocs = "threw";
  let ownerDocs = "threw";
  let activeCount = "threw";
  let reviewLoadError = null;
  try {
    portalDocs = await listProjectDocumentsForPortal(
      reviewProbe.client,
      reviewToken,
    );
    ownerDocs = await listProjectDocumentsForOwnerReview(reviewProbe.client, {
      businessId: business.id,
      jobId: reviewJob.id,
    });
    activeCount = await countActiveProjectDocuments(reviewProbe.client, {
      businessId: business.id,
      jobId: reviewJob.id,
    });
  } catch (error) {
    reviewLoadError = error;
  }
  let reviewWriteError = null;
  try {
    await recordProjectDocumentReview(reviewProbe.client, reviewAccess, {
      jobId: reviewJob.id,
      storedAssetId: reviewAsset.id,
      status: "REVIEWED",
      expectedStatus: "",
    });
  } catch (error) {
    reviewWriteError = error;
  }
  const reviewWrites = recordedWrites(reviewProbe.statements);
  const reviewTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'ProjectDocumentReview'
  `;
  check(
    "Preview document lists and counts degrade when ProjectDocumentReview is missing",
    Array.isArray(portalDocs) &&
      portalDocs.length === 1 &&
      portalDocs[0]?.reviewStatus === null &&
      Array.isArray(ownerDocs) &&
      ownerDocs.length === 1 &&
      ownerDocs[0]?.reviewStatus === null &&
      activeCount === 1 &&
      reviewLoadError === null,
  );
  check(
    "Missing ProjectDocumentReview write fails closed without DDL",
    reviewWriteError instanceof Error &&
      reviewWriteError.message === PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE,
  );
  check(
    "Missing ProjectDocumentReview does not run schema DDL or backfill DML",
    reviewWrites.length === 0,
  );
  check(
    "Dropped ProjectDocumentReview stays absent after the request-path load",
    reviewTables.length === 0,
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
