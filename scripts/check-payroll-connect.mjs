/**
 * OWNER Gusto payroll-fact connection.
 *
 * Disposable local database. Fake provider and an injected fetch shaped
 * like Gusto demo responses. No Gusto, Plaid, or other provider network
 * call. Does not run payroll or move funds.
 *
 * Run with:
 *   npm run test:payroll-connect
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertLocalDatabaseUrl, openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generate = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generate.status !== 0) {
  console.error("Failed to generate Prisma client for payroll-connect checks.");
  process.exit(generate.status ?? 1);
}

const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const {
  ConnectionTokenCryptoError,
  decryptConnectionToken,
  encryptConnectionToken,
} = await import("@/lib/connection-token-crypto");
const {
  GUSTO_API_VERSION,
  GUSTO_CONNECTED_HEADLINE,
  GUSTO_DEMO_HOST,
  GUSTO_FACTS_NOTE,
  GUSTO_NEEDS_RECONNECT_HEADLINE,
  GUSTO_NOT_AVAILABLE_HEADLINE,
  GUSTO_PRODUCTION_HOST,
  GUSTO_PROVIDER,
  GUSTO_REQUIRED_ENV_NAMES,
  GUSTO_RUN_OVERLAP_NOTE,
  GUSTO_SCOPES,
  PayrollConnectError,
  completePayrollProviderOAuth,
  createFakePayrollProvider,
  createGustoHttpPayrollProvider,
  disconnectPayrollProvider,
  gustoFakeAdapterRefusedInProduction,
  importProcessedPayrollFacts,
  isFakeGustoAdapterEnabled,
  isGustoPayrollCallbackPath,
  loadPayrollConnectView,
  parseGustoPayrollPayload,
  readGustoAvailability,
  refreshPayrollConnection,
  reportedDollarsToCents,
  resetPayrollProvider,
  reviewPayrollProviderFact,
  setPayrollProvider,
  shouldKeepConnectionAfterInvalidGrant,
  startPayrollProviderConnect,
} = await import("@/lib/payroll-connect");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok  - ${label}\n`);
  } else {
    failed += 1;
    process.stderr.write(`FAIL - ${label}\n`);
  }
}

const featureSource = [
  "src/lib/payroll-connect/connection.ts",
  "src/lib/payroll-connect/import-facts.ts",
  "src/lib/payroll-connect/view.ts",
  "src/lib/payroll-connect/gusto-http.ts",
  "src/app/actions/payroll-connect.ts",
  "src/app/api/payroll/gusto/callback/route.ts",
  "src/components/payroll/payroll-provider-panel.tsx",
  "src/app/(app)/payroll/page.tsx",
].map(readRepo).join("\n");
const connectionSrc = readRepo("src/lib/payroll-connect/connection.ts");
const importSrc = readRepo("src/lib/payroll-connect/import-facts.ts");
const panelSrc = readRepo("src/components/payroll/payroll-provider-panel.tsx");
const actionSrc = readRepo("src/app/actions/payroll-connect.ts");
const callbackSrc = readRepo("src/app/api/payroll/gusto/callback/route.ts");
const proxySrc = readRepo("src/proxy.ts");
const migrationSrc = readRepo("prisma/migrations/20261003180000_payroll_provider_connection/migration.sql");

console.log("\nSTATIC — boundary, owner gate, and no money movement");
check(
  "Capability is owner-only",
  readRepo("src/lib/authorization.ts").includes("CONNECT_PAYROLL_PROVIDER") &&
    roleHasCapability("OWNER", CAPABILITIES.CONNECT_PAYROLL_PROVIDER) &&
    !roleHasCapability("ADMIN", CAPABILITIES.CONNECT_PAYROLL_PROVIDER) &&
    !roleHasCapability("MEMBER", CAPABILITIES.CONNECT_PAYROLL_PROVIDER),
);
for (const name of [
  "startPayrollProviderConnect",
  "completePayrollProviderOAuth",
  "refreshPayrollConnection",
  "disconnectPayrollProvider",
]) {
  const idx = connectionSrc.indexOf(`export async function ${name}`);
  check(
    `${name} requires the owner`,
    idx >= 0 && connectionSrc.slice(idx, idx + 500).includes("requirePayrollConnectOwner"),
  );
}
check(
  "Import and review require the owner",
  importSrc.includes("requirePayrollConnectOwner(access)"),
);
check(
  "Refresh is serialized on the connection row",
  connectionSrc.includes("FOR UPDATE") && connectionSrc.includes("shouldKeepConnectionAfterInvalidGrant"),
);
check(
  "Tokens are encrypted for the gusto purpose",
  connectionSrc.includes('encryptConnectionToken(GUSTO_PROVIDER') &&
    connectionSrc.includes("decryptConnectionToken"),
);
check(
  "Import does not mutate payroll runs, payments, expenses, invoices, or bank rows",
  !importSrc.includes("payrollRun.update") &&
    !importSrc.includes("payrollRun.create") &&
    !importSrc.includes("markPayrollProcessed") &&
    !importSrc.includes("processedPayrollOutflows") &&
    !importSrc.includes("payment.create") &&
    !importSrc.includes("expense.create") &&
    !importSrc.includes("invoice.create") &&
    !importSrc.includes("bankReconciliation"),
);
check(
  "Request path does not run DDL",
  !featureSource.includes("CREATE TABLE") && !featureSource.includes("$executeRawUnsafe"),
);
check(
  "Callback is exempt from the session proxy",
  isGustoPayrollCallbackPath("/api/payroll/gusto/callback") &&
    !isGustoPayrollCallbackPath("/api/payroll/gusto/callback/extra") &&
    proxySrc.includes("isGustoPayrollCallbackPath") &&
    proxySrc.includes("api/payroll/gusto/callback"),
);
check(
  "UI connects only when the view allows it and states the fact boundary",
  panelSrc.includes("view.showConnectButton") &&
    panelSrc.includes("{view.factsNote}") &&
    panelSrc.includes("{view.disconnectNote}") &&
    !panelSrc.includes("net pay") &&
    readRepo("package.json").includes('"test:payroll-connect"') &&
    readRepo("README.md").includes("npm run test:payroll-connect"),
);
check(
  "Migration is additive and names the OAuth state table uniquely",
  migrationSrc.includes('CREATE TABLE IF NOT EXISTS "PayrollConnectionOAuthState"') &&
    migrationSrc.includes("IF NOT EXISTS") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
const callbackBody = callbackSrc.slice(callbackSrc.indexOf("export async function GET"));
check(
  "Actions and callback authorize before the provider call",
  actionSrc.includes("requireOperatingBusinessAccess") &&
    callbackBody.includes("requireOperatingBusinessAccess") &&
    callbackBody.indexOf("requireOperatingBusinessAccess") < callbackBody.indexOf("completePayrollProviderOAuth"),
);

const COMPANY_A = "9aa93530-43d5-484e-b608-33214109420d";
const COMPANY_B = "7b1d0df1-6403-4a06-8768-c1dd7d24d27a";
const PAYROLL_ID = "b441a30b-2adb-489e-b7b7-9d094011a3f8";
const UNPROCESSED_ID = "3601a7a2-0562-4e4c-9559-20886658daac";
const PROCESSED_BODY = {
  uuid: PAYROLL_ID,
  payroll_uuid: PAYROLL_ID,
  company_uuid: COMPANY_A,
  processed: true,
  processed_date: "2025-06-16",
  check_date: "2025-06-13",
  pay_period: {
    start_date: "2025-05-25",
    end_date: "2025-06-09",
    pay_schedule_uuid: "40ff5990-0191-4796-9717-32f7dd3e94d5",
  },
  totals: {
    gross_pay: "2791.25",
    employer_taxes: "210.10",
    benefits: "80.00",
    net_pay: "999.99",
    employee_taxes: "111.11",
  },
  employee_compensations: [
    {
      employee_uuid: "5eca5127-6048-43ad-91ee-b56a0c34bc85",
      first_name: "Ada",
      last_name: "Lovelace",
      gross_pay: "2000.00",
      net_pay: "1500.00",
    },
    {
      employee_uuid: "367871c2-3f70-4874-adc9-f1736647e8e1",
      first_name: "Grace",
      last_name: "Hopper",
      gross_pay: "791.25",
    },
  ],
};
const UNPROCESSED_BODY = {
  uuid: UNPROCESSED_ID,
  payroll_uuid: UNPROCESSED_ID,
  processed: false,
  check_date: "2025-07-01",
  totals: { gross_pay: "10.00", net_pay: "8.00" },
  employee_compensations: [],
};

console.log("\nUNIT — token crypto, cents, and Gusto-shaped parsing");
const cryptoKey = "ab".repeat(32);
const previousKey = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY;
process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = cryptoKey;
const businessOne = "biz_one";
const businessTwo = "biz_two";
const envelope = encryptConnectionToken(GUSTO_PROVIDER, businessOne, "access-token-value");
check("Round trip decrypts the same token", decryptConnectionToken(GUSTO_PROVIDER, businessOne, envelope) === "access-token-value");
check("Ciphertext is not the plaintext", !envelope.includes("access-token-value"));
const tampered = `${envelope.slice(0, -2)}${envelope.endsWith("a") ? "b" : "a"}`;
let tamperThrew = false;
try {
  decryptConnectionToken(GUSTO_PROVIDER, businessOne, tampered);
} catch (error) {
  tamperThrew = error instanceof ConnectionTokenCryptoError;
}
check("Tampered envelope is rejected", tamperThrew);
let wrongBusiness = false;
try {
  decryptConnectionToken(GUSTO_PROVIDER, businessTwo, envelope);
} catch (error) {
  wrongBusiness = error instanceof ConnectionTokenCryptoError;
}
check("Wrong business AAD is rejected", wrongBusiness);
let wrongPurpose = false;
try {
  decryptConnectionToken("plaid", businessOne, envelope);
} catch (error) {
  wrongPurpose = error instanceof ConnectionTokenCryptoError;
}
check("Wrong purpose is rejected", wrongPurpose);
delete process.env.CONNECTION_TOKEN_ENCRYPTION_KEY;
let missingKey = false;
try {
  encryptConnectionToken(GUSTO_PROVIDER, businessOne, "access-token-value");
} catch (error) {
  missingKey = error instanceof ConnectionTokenCryptoError;
}
check("Missing key is rejected", missingKey);
process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = "abcd";
let shortKey = false;
try {
  encryptConnectionToken(GUSTO_PROVIDER, businessOne, "access-token-value");
} catch (error) {
  shortKey = error instanceof ConnectionTokenCryptoError;
}
check("Short key is rejected", shortKey);
if (previousKey == null) delete process.env.CONNECTION_TOKEN_ENCRYPTION_KEY;
else process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = previousKey;

check("Reported dollars become cents", reportedDollarsToCents("2791.25") === 279125);
check("Missing dollars stay null", reportedDollarsToCents(undefined) === null);
const parsed = parseGustoPayrollPayload(PROCESSED_BODY, JSON.stringify(PROCESSED_BODY));
check(
  "Processed payroll keeps reported gross and omits net pay",
  parsed?.grossTotalCents === 279125 &&
    parsed?.employerTaxesCents === 21010 &&
    parsed?.employerBenefitsCents === 8000 &&
    parsed?.lines.length === 2 &&
    parsed.lines[0].grossCents === 200000 &&
    !Object.prototype.hasOwnProperty.call(parsed, "netPay") &&
    !JSON.stringify(parsed).includes("999.99") &&
    !JSON.stringify(parsed).includes("1500.00"),
);
check("Unprocessed payroll is not a fact", parseGustoPayrollPayload(UNPROCESSED_BODY, "{}") === null);
check(
  "Lost refresh race keeps a changed ciphertext",
  shouldKeepConnectionAfterInvalidGrant("old", "new") &&
    !shouldKeepConnectionAfterInvalidGrant("same", "same") &&
    !shouldKeepConnectionAfterInvalidGrant("same", null),
);

console.log("\nUNIT — injected fetch uses demo paths and never the network");
const calls = [];
const accessToken = "demo-access-token";
const refreshToken = "demo-refresh-token";
function fixtureResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const demoFetch = async (url, init) => {
  const parsedUrl = new URL(url);
  calls.push({
    host: parsedUrl.host,
    path: parsedUrl.pathname,
    search: parsedUrl.search,
    method: init?.method ?? "GET",
    version: new Headers(init?.headers).get("X-Gusto-API-Version"),
  });
  if (parsedUrl.host !== "api.gusto-demo.com") {
    throw new Error("Refusing non-demo host in the fixture.");
  }
  if (parsedUrl.pathname === "/oauth/token") {
    return fixtureResponse({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 7200,
      token_type: "bearer",
      scope: GUSTO_SCOPES,
    });
  }
  if (parsedUrl.pathname === "/v1/token_info") {
    return fixtureResponse({
      scope: GUSTO_SCOPES,
      resource: { type: "Company", uuid: COMPANY_A },
      resource_owner: { type: "CompanyAdmin", uuid: "8fdc31f0-a8a7-4872-a9f1-dcb5e6f876e3" },
    });
  }
  if (parsedUrl.pathname === `/v1/companies/${COMPANY_A}/payrolls`) {
    return fixtureResponse([PROCESSED_BODY, UNPROCESSED_BODY]);
  }
  if (parsedUrl.pathname === `/v1/companies/${COMPANY_A}/payrolls/${PAYROLL_ID}`) {
    return fixtureResponse(PROCESSED_BODY);
  }
  return fixtureResponse({ error: "not_found" }, 404);
};
const http = createGustoHttpPayrollProvider({ host: GUSTO_DEMO_HOST, fetchImpl: demoFetch });
const exchanged = await http.exchangeAuthorizationCode({
  code: "demo-code",
  redirectUri: "https://example.test/api/payroll/gusto/callback",
  clientId: "client",
  clientSecret: "secret",
});
const info = await http.tokenInfo({ accessToken: exchanged.accessToken });
const listed = await http.listProcessedPayrolls({
  accessToken: exchanged.accessToken,
  companyId: info.companyId,
  startDate: "2025-01-01",
  endDate: "2025-12-01",
});
check("Token exchange reads the demo token response", exchanged.accessToken === accessToken && exchanged.expiresIn === 7200);
check("Token info returns the company", info.companyId === COMPANY_A && info.resourceType === "Company");
check(
  "Only the processed payroll is imported from the fixture",
  listed.length === 1 && listed[0].providerPayrollId === PAYROLL_ID && listed[0].grossTotalCents === 279125,
);
check(
  "Demo calls use the documented paths and version",
  calls.every((call) => call.host === "api.gusto-demo.com") &&
    calls.some((call) => call.path === "/oauth/token" && call.method === "POST") &&
    calls.some((call) => call.path === "/v1/token_info") &&
    calls.some(
      (call) =>
        call.path === `/v1/companies/${COMPANY_A}/payrolls` &&
        call.search.includes("processing_statuses=processed") &&
        call.search.includes("include=totals"),
    ) &&
    calls.some((call) => call.version === GUSTO_API_VERSION) &&
    !calls.some((call) => call.path.includes(UNPROCESSED_ID)),
);
const productionCalls = [];
const production = createGustoHttpPayrollProvider({
  host: GUSTO_PRODUCTION_HOST,
  fetchImpl: async (url, init) => {
    productionCalls.push(new URL(url).host);
    return demoFetch(url.replace("https://api.gusto.com", GUSTO_DEMO_HOST), init);
  },
});
await production.tokenInfo({ accessToken });
check("Explicit production host is api.gusto.com", productionCalls.includes("api.gusto.com"));

console.log("\nUNIT — availability and production fake guard");
const envSnapshot = {
  GUSTO_CLIENT_ID: process.env.GUSTO_CLIENT_ID,
  GUSTO_CLIENT_SECRET: process.env.GUSTO_CLIENT_SECRET,
  GUSTO_ENV: process.env.GUSTO_ENV,
  GUSTO_REDIRECT_URI: process.env.GUSTO_REDIRECT_URI,
  CONNECTION_TOKEN_ENCRYPTION_KEY: process.env.CONNECTION_TOKEN_ENCRYPTION_KEY,
  TBBT_GUSTO_ADAPTER: process.env.TBBT_GUSTO_ADAPTER,
  VERCEL_ENV: process.env.VERCEL_ENV,
};
function restoreEnv() {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
function clearGustoEnv() {
  for (const key of GUSTO_REQUIRED_ENV_NAMES) delete process.env[key];
  delete process.env.TBBT_GUSTO_ADAPTER;
  delete process.env.VERCEL_ENV;
}
clearGustoEnv();
resetPayrollProvider();
const missing = readGustoAvailability();
check(
  "Missing credentials are not available",
  missing.available === false &&
    GUSTO_REQUIRED_ENV_NAMES.every((name) => missing.missing.includes(name)),
);
process.env.VERCEL_ENV = "production";
process.env.TBBT_GUSTO_ADAPTER = "fake";
process.env.GUSTO_CLIENT_ID = "id";
process.env.GUSTO_CLIENT_SECRET = "secret";
process.env.GUSTO_ENV = "production";
process.env.GUSTO_REDIRECT_URI = "https://example.test/callback";
process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = cryptoKey;
resetPayrollProvider();
let productionFakeThrew = false;
try {
  const { getPayrollProvider } = await import("@/lib/payroll-connect/provider");
  getPayrollProvider();
} catch (error) {
  productionFakeThrew = error instanceof PayrollConnectError && error.code === "NOT_AVAILABLE";
}
check(
  "Fake adapter is refused in production",
  gustoFakeAdapterRefusedInProduction() &&
    !isFakeGustoAdapterEnabled() &&
    readGustoAvailability().available === false &&
    productionFakeThrew,
);
restoreEnv();
resetPayrollProvider();

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to a local Postgres for payroll-connect checks.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "payroll-connect disposable database");

process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = cryptoKey;
process.env.GUSTO_CLIENT_ID = "gusto-client-id-test";
process.env.GUSTO_CLIENT_SECRET = "gusto-client-secret-test";
process.env.GUSTO_ENV = "demo";
process.env.GUSTO_REDIRECT_URI = "https://example.test/api/payroll/gusto/callback";
process.env.TBBT_GUSTO_ADAPTER = "fake";
delete process.env.VERCEL_ENV;
resetPayrollProvider();

const fake = createFakePayrollProvider();
fake.setCompanyId(COMPANY_A);
const processedRaw = JSON.stringify(PROCESSED_BODY);
fake.setPayrolls([
  parseGustoPayrollPayload(PROCESSED_BODY, processedRaw),
  {
    providerPayrollId: UNPROCESSED_ID,
    payPeriodStart: "2025-06-10",
    payPeriodEnd: "2025-06-24",
    checkDate: "2025-07-01",
    processed: false,
    grossTotalCents: 1000,
    employerTaxesCents: null,
    employerBenefitsCents: null,
    rawPayloadHash: "unprocessed",
    lines: [],
  },
]);
setPayrollProvider(fake);

function makeAccess(business, role, membershipId) {
  return {
    businessId: business.id,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: business.id, timezone: "America/New_York" },
    },
    scope: businessScope(business.id),
    assertOwned(record) {
      return assertBusinessRecord(record, business.id);
    },
  };
}

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_payroll_connect",
});
const prisma = session.prisma;

try {
  const migration = spawnSync(
    "npx",
    [
      "prisma",
      "db",
      "execute",
      "--file",
      "prisma/migrations/20261003180000_payroll_provider_connection/migration.sql",
      "--url",
      session.testUrl,
    ],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: session.testUrl } },
  );
  if (migration.status !== 0) {
    throw new Error("Payroll connection migration did not apply to the disposable database.");
  }

  async function seed(name, role = "OWNER") {
    const user = await prisma.user.create({
      data: {
        name: `${name} ${role}`,
        email: `${name}.${role}.${randomUUID().slice(0, 8)}@example.com`,
        passwordHash: "x",
      },
    });
    const business = await prisma.business.create({
      data: { name, slug: `${name}-${randomUUID().slice(0, 8)}`, timezone: "America/New_York" },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, businessId: business.id, role },
    });
    return { business, membership, access: makeAccess(business, role, membership.id) };
  }

  const ownerA = await seed("alpha");
  const adminA = await seed("alpha-admin", "ADMIN");
  await prisma.membership.update({
    where: { id: adminA.membership.id },
    data: { businessId: ownerA.business.id },
  });
  const adminAccess = makeAccess(ownerA.business, "ADMIN", adminA.membership.id);
  const memberUser = await prisma.user.create({
    data: { name: "Member", email: `member.${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const member = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: ownerA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(ownerA.business, "MEMBER", member.id);
  const ownerB = await seed("beta");

  async function moneyCounts() {
    const [payrollRun, payment, expense, invoice, match, row, imported] = await Promise.all([
      prisma.payrollRun.count(),
      prisma.payment.count(),
      prisma.expense.count(),
      prisma.invoice.count(),
      prisma.bankReconciliationMatch.count(),
      prisma.bankReconciliationRow.count(),
      prisma.bankReconciliationImport.count(),
    ]);
    return { payrollRun, payment, expense, invoice, match, row, imported };
  }

  console.log("\nDB — owner connect, tenant isolation, refresh, import");
  const unavailableAccess = ownerA.access;
  delete process.env.GUSTO_CLIENT_ID;
  resetPayrollProvider();
  setPayrollProvider(fake);
  let unavailable = false;
  try {
    await startPayrollProviderConnect(prisma, unavailableAccess);
  } catch (error) {
    unavailable = error instanceof PayrollConnectError && error.code === "NOT_AVAILABLE";
  }
  const unavailableView = await loadPayrollConnectView(prisma, ownerA.access);
  check("Not configured refuses connect and hides the button", unavailable && unavailableView.phase === "NOT_AVAILABLE" && unavailableView.headline === GUSTO_NOT_AVAILABLE_HEADLINE && unavailableView.showConnectButton === false);
  process.env.GUSTO_CLIENT_ID = "gusto-client-id-test";

  let adminBlocked = false;
  try {
    await startPayrollProviderConnect(prisma, adminAccess);
  } catch (error) {
    adminBlocked = error instanceof ForbiddenError;
  }
  let memberBlocked = false;
  try {
    await startPayrollProviderConnect(prisma, memberAccess);
  } catch (error) {
    memberBlocked = error instanceof ForbiddenError;
  }
  check("ADMIN and MEMBER cannot start a connection", adminBlocked && memberBlocked);
  const adminView = await loadPayrollConnectView(prisma, adminAccess);
  check("ADMIN view is owner-only and has no facts", adminView.phase === "OWNER_ONLY" && adminView.showConnectButton === false && adminView.facts.length === 0);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  console.error = (...args) => logs.push(args.map(String).join(" "));
  const started = await startPayrollProviderConnect(prisma, ownerA.access);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  check(
    "Authorize URL is the demo host and does not contain a secret",
    started.authorizeUrl.startsWith(`${GUSTO_DEMO_HOST}/oauth/authorize`) &&
      new URL(started.authorizeUrl).searchParams.get("response_type") === "code" &&
      new URL(started.authorizeUrl).searchParams.get("scope") === GUSTO_SCOPES &&
      !started.authorizeUrl.includes("gusto-client-secret-test"),
  );
  let crossTenant = false;
  try {
    await completePayrollProviderOAuth(prisma, ownerB.access, { code: "demo-code", state });
  } catch (error) {
    crossTenant = error instanceof PayrollConnectError && error.code === "STATE_INVALID";
  }
  const stateAfterProbe = await prisma.payrollConnectionOAuthState.findFirst({
    where: { businessId: ownerA.business.id },
  });
  check("State minted for A is rejected for B and stays unused", crossTenant && stateAfterProbe?.consumedAt == null);
  let wrongMembership = false;
  try {
    await completePayrollProviderOAuth(prisma, adminAccess, { code: "demo-code", state });
  } catch (error) {
    wrongMembership = error instanceof ForbiddenError;
  }
  check("Callback membership must be the owner who minted the state", wrongMembership);
  let tamper = false;
  try {
    await completePayrollProviderOAuth(prisma, ownerA.access, { code: "demo-code", state: "tampered-state" });
  } catch (error) {
    tamper = error instanceof PayrollConnectError && error.code === "STATE_INVALID";
  }
  check("Tampered state is rejected", tamper);
  const completed = await completePayrollProviderOAuth(prisma, ownerA.access, { code: "demo-code", state });
  console.log = originalLog;
  console.error = originalError;
  check("Token exchange plus token info marks Connected", completed.status === "CONNECTED" && completed.externalCompanyId === COMPANY_A);
  let replay = false;
  try {
    await completePayrollProviderOAuth(prisma, ownerA.access, { code: "demo-code", state });
  } catch (error) {
    replay = error instanceof PayrollConnectError && error.code === "STATE_INVALID";
  }
  check("OAuth state cannot be replayed", replay);
  const joinedLogs = logs.join("\n");
  check(
    "Tokens are not written to logs",
    !joinedLogs.includes("fake_gusto_access_") && !joinedLogs.includes("fake_gusto_refresh_") && !joinedLogs.includes(state),
  );

  const stored = await prisma.payrollConnection.findFirst({
    where: { businessId: ownerA.business.id, provider: GUSTO_PROVIDER },
  });
  const decryptedAccess = decryptConnectionToken(GUSTO_PROVIDER, ownerA.business.id, stored.accessTokenCiphertext);
  check(
    "Database row stores ciphertext only",
    stored.status === "CONNECTED" &&
      stored.accessTokenCiphertext.startsWith("v1.") &&
      !stored.accessTokenCiphertext.includes(decryptedAccess) &&
      !stored.refreshTokenCiphertext.includes("fake_gusto_") &&
      !JSON.stringify(stored).includes(decryptedAccess),
  );

  const expiredStart = await startPayrollProviderConnect(prisma, ownerA.access);
  const expiredState = new URL(expiredStart.authorizeUrl).searchParams.get("state");
  await prisma.payrollConnectionOAuthState.updateMany({
    where: { businessId: ownerA.business.id, consumedAt: null },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  let expired = false;
  try {
    await completePayrollProviderOAuth(prisma, ownerA.access, { code: "demo-code", state: expiredState });
  } catch (error) {
    expired = error instanceof PayrollConnectError && error.code === "STATE_INVALID";
  }
  check("Expired OAuth state is rejected", expired);

  fake.setCompanyId(COMPANY_A);
  const blockedStart = await startPayrollProviderConnect(prisma, ownerB.access);
  const blockedState = new URL(blockedStart.authorizeUrl).searchParams.get("state");
  let companyBlocked = false;
  try {
    await completePayrollProviderOAuth(prisma, ownerB.access, { code: "demo-code", state: blockedState });
  } catch (error) {
    companyBlocked = error instanceof PayrollConnectError && error.code === "COMPANY_IN_USE";
  }
  const stillA = await prisma.payrollConnection.findFirst({
    where: { businessId: ownerA.business.id, provider: GUSTO_PROVIDER },
  });
  check("The same Gusto company cannot be active on two businesses", companyBlocked && stillA.status === "CONNECTED");

  const before = await moneyCounts();
  await prisma.payrollRun.create({
    data: {
      businessId: ownerA.business.id,
      payPeriodStart: new Date("2025-05-25T00:00:00.000Z"),
      payPeriodEnd: new Date("2025-06-09T00:00:00.000Z"),
      status: "DRAFT",
    },
  });
  const afterRun = await moneyCounts();
  const imported = await importProcessedPayrollFacts(prisma, ownerA.access);
  const again = await importProcessedPayrollFacts(prisma, ownerA.access);
  const facts = await prisma.payrollProviderPayrollFact.findMany({
    where: { businessId: ownerA.business.id },
    include: { lines: true },
  });
  const afterImport = await moneyCounts();
  const run = await prisma.payrollRun.findFirst({ where: { businessId: ownerA.business.id } });
  check(
    "Import is idempotent and does not touch money tables",
    imported.imported === 1 &&
      again.imported === 1 &&
      facts.length === 1 &&
      facts[0].grossTotalCents === 279125 &&
      facts[0].lines.length === 2 &&
      facts[0].processed === true &&
      !JSON.stringify(facts).includes("999.99") &&
      !JSON.stringify(facts).includes("netPay") &&
      afterImport.payment === afterRun.payment &&
      afterImport.expense === afterRun.expense &&
      afterImport.invoice === afterRun.invoice &&
      afterImport.match === afterRun.match &&
      afterImport.row === afterRun.row &&
      afterImport.imported === afterRun.imported &&
      afterImport.payrollRun === afterRun.payrollRun &&
      afterRun.payrollRun === before.payrollRun + 1 &&
      run.status === "DRAFT" &&
      run.processedAt == null &&
      run.processedSource == null,
  );
  await reviewPayrollProviderFact(prisma, ownerA.access, { factId: facts[0].id, reviewStatus: "ACCEPTED" });
  fake.setPayrolls([
    {
      ...parseGustoPayrollPayload(PROCESSED_BODY, processedRaw),
      grossTotalCents: 280000,
    },
  ]);
  await importProcessedPayrollFacts(prisma, ownerA.access);
  const reviewed = await prisma.payrollProviderPayrollFact.findFirst({
    where: { id: facts[0].id, businessId: ownerA.business.id },
  });
  check("Re-import keeps the review status and updates reported gross", reviewed.reviewStatus === "ACCEPTED" && reviewed.grossTotalCents === 280000);
  const view = await loadPayrollConnectView(prisma, ownerA.access);
  check(
    "Connected view lists provider facts and a read-only payroll-run overlap",
    view.phase === "CONNECTED" &&
      view.headline === GUSTO_CONNECTED_HEADLINE &&
      view.factsNote === GUSTO_FACTS_NOTE &&
      view.facts.length === 1 &&
      view.facts[0].reviewStatus === "ACCEPTED" &&
      view.facts[0].recordedPayrollRuns.length === 1 &&
      view.facts[0].recordedPayrollRuns[0].label.includes(GUSTO_RUN_OVERLAP_NOTE) &&
      !JSON.stringify(view).includes(decryptedAccess),
  );
  const betaView = await loadPayrollConnectView(prisma, ownerB.access);
  check("Business B cannot read business A facts", betaView.facts.length === 0 && betaView.externalCompanyId == null);

  let betaSync = false;
  try {
    await importProcessedPayrollFacts(prisma, ownerB.access);
  } catch (error) {
    betaSync = error instanceof PayrollConnectError;
  }
  let betaDisconnect = false;
  try {
    await disconnectPayrollProvider(prisma, ownerB.access);
  } catch (error) {
    betaDisconnect = error instanceof PayrollConnectError;
  }
  const untouched = await prisma.payrollConnection.findFirst({
    where: { businessId: ownerA.business.id },
  });
  check("Business B cannot sync or disconnect business A", betaSync && betaDisconnect && untouched.accessTokenCiphertext);

  await prisma.payrollConnection.update({
    where: { id: untouched.id },
    data: { accessTokenExpiresAt: new Date(Date.now() - 120_000) },
  });
  fake.setDelayMs(150);
  const refreshBefore = fake.refreshCount;
  const raced = await Promise.all([
    refreshPayrollConnection(prisma, ownerA.access),
    refreshPayrollConnection(prisma, ownerA.access),
  ]);
  check(
    "Concurrent refresh leaves one valid pair",
    fake.refreshCount === refreshBefore + 1 && raced.filter((row) => row.rotated).length === 1,
  );
  fake.setDelayMs(0);
  await prisma.payrollConnection.update({
    where: { id: untouched.id },
    data: { accessTokenExpiresAt: new Date(Date.now() - 120_000) },
  });
  const followUp = await refreshPayrollConnection(prisma, ownerA.access);
  check("The stored refresh token still rotates", followUp.rotated === true && fake.refreshCount === refreshBefore + 2);

  await prisma.payrollConnection.update({
    where: { id: untouched.id },
    data: { accessTokenExpiresAt: new Date(Date.now() - 120_000) },
  });
  fake.setInvalidGrantNext(true);
  let needsReconnect = false;
  try {
    await refreshPayrollConnection(prisma, ownerA.access);
  } catch (error) {
    needsReconnect = error instanceof PayrollConnectError && error.code === "NEEDS_RECONNECT";
  }
  const reconnectView = await loadPayrollConnectView(prisma, ownerA.access);
  const cleared = await prisma.payrollConnection.findFirst({ where: { id: untouched.id } });
  check(
    "invalid_grant marks Needs reconnect and the view says so",
    needsReconnect &&
      cleared.status === "NEEDS_RECONNECT" &&
      cleared.accessTokenCiphertext == null &&
      cleared.refreshTokenCiphertext == null &&
      reconnectView.headline === GUSTO_NEEDS_RECONNECT_HEADLINE &&
      reconnectView.showConnectButton === true &&
      reconnectView.canSync === false,
  );

  const reconnectStart = await startPayrollProviderConnect(prisma, ownerA.access);
  const reconnectState = new URL(reconnectStart.authorizeUrl).searchParams.get("state");
  await completePayrollProviderOAuth(prisma, ownerA.access, { code: "demo-code", state: reconnectState });
  const restored = await prisma.payrollConnection.findFirst({ where: { id: untouched.id } });
  check("Reconnect restores Connected ciphertext", restored.status === "CONNECTED" && restored.accessTokenCiphertext?.startsWith("v1."));

  const factCount = await prisma.payrollProviderPayrollFact.count({ where: { businessId: ownerA.business.id } });
  await disconnectPayrollProvider(prisma, ownerA.access);
  const disconnected = await prisma.payrollConnection.findFirst({ where: { id: untouched.id } });
  const factsRemain = await prisma.payrollProviderPayrollFact.count({ where: { businessId: ownerA.business.id } });
  let syncBlocked = false;
  try {
    await importProcessedPayrollFacts(prisma, ownerA.access);
  } catch (error) {
    syncBlocked = error instanceof PayrollConnectError && error.code === "NOT_CONNECTED";
  }
  const disconnectView = await loadPayrollConnectView(prisma, ownerA.access);
  check(
    "Disconnect wipes ciphertext, keeps facts, and blocks sync",
    disconnected.status === "DISCONNECTED" &&
      disconnected.accessTokenCiphertext == null &&
      disconnected.refreshTokenCiphertext == null &&
      factsRemain === factCount &&
      factCount === 1 &&
      syncBlocked &&
      disconnectView.facts.length === 1 &&
      disconnectView.disconnectNote.includes("does not revoke access at Gusto"),
  );

  let adminImport = false;
  try {
    await importProcessedPayrollFacts(prisma, adminAccess);
  } catch (error) {
    adminImport = error instanceof ForbiddenError;
  }
  let adminReview = false;
  try {
    await reviewPayrollProviderFact(prisma, adminAccess, { factId: facts[0].id, reviewStatus: "IGNORED" });
  } catch (error) {
    adminReview = error instanceof ForbiddenError;
  }
  check("ADMIN cannot import or review", adminImport && adminReview);

  console.log(`\nPayroll-connect checks: ${passed} passed, ${failed} failed.`);
} finally {
  await session.cleanup();
  restoreEnv();
  resetPayrollProvider();
}

if (failed > 0) process.exit(1);
