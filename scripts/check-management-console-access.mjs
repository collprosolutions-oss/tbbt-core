/**
 * Focused verification for the Step 2 follow-up: MEMBER must not be able
 * to READ business-wide management pages (Dashboard, Requests, Customers,
 * Estimates, Jobs, Invoices, Services, Settings), not just be blocked from
 * mutating them. See requireManagementPageAccess() in src/lib/access.ts,
 * canAccessManagementConsole() in src/lib/authorization.ts, and
 * src/app/(app)/layout.tsx / src/app/access-restricted/page.tsx.
 *
 * Unlike the other scripts/check-*.mjs files (which mirror server action
 * logic directly, since requireBusinessAccess()/requireWorkspace() need
 * next/headers request context that a plain script doesn't have), this
 * check needs a REAL HTTP request through Next's routing to prove "direct
 * URL access is rejected server-side, not merely hidden in nav" -- AND,
 * importantly, that no business data is ever present in the raw HTTP
 * response body a MEMBER receives, not just hidden from the rendered DOM.
 *
 * That last point matters because of a real Next.js App Router subtlety
 * this script caught during development: a parent layout that merely
 * decides NOT to render `{children}` (a plain conditional return, not a
 * thrown redirect/notFound) does NOT stop the matched page segment below
 * it from still executing its data fetching and being serialized into the
 * response's Flight payload -- so a naive "hide it in the layout" fix
 * would still leak full business data into the raw HTTP response text
 * (visible via curl/view-source/devtools) even though the rendered page
 * looked correctly restricted. The actual fix has to run INSIDE each
 * page's own render, before any Prisma call, and abort by throwing
 * (redirect()) rather than branching. This script asserts on the RAW,
 * unfollowed response body (fetch with redirect: "manual") specifically
 * to catch a regression back to the insufficient layout-only approach.
 *
 * This script:
 *   1. Pushes the schema to a disposable sibling Postgres database.
 *   2. Seeds a Business with an OWNER, ADMIN, and MEMBER (each with their
 *      own real Session row, so no sign-in flow / server action is
 *      needed) plus one "canary" record per resource type, so a leak would
 *      be trivially visible in a response body.
 *   3. Boots the already-built app (`next start`) against that database.
 *   4. Sends real GET requests with each role's session+workspace cookies
 *      directly at every current management URL (list AND detail routes).
 *
 * Requires the app to already be built (`npm run build`) so `next start`
 * has a `.next` directory to serve; DATABASE_URL is read at runtime by the
 * server process, so no rebuild is needed to point it at the test database.
 *
 * Run with:
 *   npm run build && node scripts/check-management-console-access.mjs
 */
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;

if (!existsSync(`${repoRoot}.next`)) {
  console.error(
    "No .next build output found. Run `npm run build` before this check (see script header).",
  );
  process.exit(1);
}

const testDbName = "tbbt_management_console_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for management-console-access test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

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

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

const PORT = 43819;
const APP_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
      if (res.status < 500) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function cookieHeader(session) {
  return `tbbt_session=${session.token}; tbbt_workspace=${session.businessId}`;
}

/** The RAW, un-followed response: what actually goes over the wire for this request. */
async function fetchRaw(session, path) {
  const res = await fetch(`${APP_URL}${path}`, {
    redirect: "manual",
    headers: { cookie: cookieHeader(session) },
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, location: res.headers.get("location"), body };
}

/** What a real browser would ultimately land on/render, following any redirect. */
async function fetchFinal(session, path) {
  const res = await fetch(`${APP_URL}${path}`, {
    redirect: "follow",
    headers: { cookie: cookieHeader(session) },
  });
  const body = await res.text();
  return { status: res.status, url: res.url, body };
}

const NAV_MARKER = "Schedule / Jobs";
const RESTRICTED_MARKER = "Access restricted";

let serverProcess;

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-console", tradeCode: "HANDYMAN" },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner@console-test.example", passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: "admin@console-test.example", passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member@console-test.example", passwordHash: "x" },
  });

  await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });

  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  async function makeSession(user) {
    const token = randomUUID();
    await prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: farFuture },
    });
    return { token, businessId: businessA.id };
  }
  const ownerSession = await makeSession(ownerUser);
  const adminSession = await makeSession(adminUser);
  const memberSession = await makeSession(memberUser);

  // Canary business data: if any of it appears in a MEMBER's raw response,
  // the read boundary has leaked.
  const CANARY_CUSTOMER = "Canary Customer Zx9";
  const CANARY_CATALOG_ITEM = "Canary Catalog Item Zx9";

  const canaryCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: CANARY_CUSTOMER, email: "canary@example.com" },
  });
  const canaryProperty = await prisma.property.create({
    data: { businessId: businessA.id, customerId: canaryCustomer.id, addressLine1: "9 Canary Ln" },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: CANARY_CATALOG_ITEM,
      pricingMode: "FLAT_RATE",
      price: new Prisma.Decimal(100),
    },
  });
  const canaryRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: canaryCustomer.id,
      propertyId: canaryProperty.id,
      description: "Canary leaky faucet",
    },
  });
  const canaryEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: canaryCustomer.id,
      propertyId: canaryProperty.id,
      serviceRequestId: canaryRequest.id,
      total: new Prisma.Decimal(150),
      publicToken: randomUUID(),
      status: "APPROVED",
    },
  });
  const canaryJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: canaryCustomer.id,
      propertyId: canaryProperty.id,
      estimateId: canaryEstimate.id,
      status: "COMPLETED",
    },
  });
  const canaryInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: canaryCustomer.id,
      jobId: canaryJob.id,
      total: new Prisma.Decimal(150),
      status: "SENT",
    },
  });

  console.log(`\nStarting built app on ${APP_URL} against the test database...`);
  serverProcess = spawn(
    "node_modules/.bin/next",
    ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: repoRoot.replace(/\/$/, ""),
      env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "production" },
      stdio: "pipe",
    },
  );
  let serverOutput = "";
  serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

  const up = await waitForServer(30_000);
  if (!up) {
    console.error("Server did not start in time. Output so far:\n" + serverOutput);
    process.exit(1);
  }

  // Routes every currently-implemented role can currently only reach
  // through this one shared layout + requireManagementPageAccess(). `marker`
  // is real business data (or a real page-specific string) that MUST be
  // visible to OWNER/ADMIN and MUST NEVER appear in a MEMBER's raw response.
  const routes = [
    { path: "/dashboard", label: "Dashboard business-wide metrics", marker: CANARY_CUSTOMER },
    { path: "/requests", label: "Requests list", marker: CANARY_CUSTOMER },
    { path: "/customers", label: "Customers list", marker: CANARY_CUSTOMER },
    { path: `/customers/${canaryCustomer.id}`, label: "Customer detail", marker: CANARY_CUSTOMER },
    { path: "/estimates", label: "Estimates list", marker: CANARY_CUSTOMER },
    { path: `/estimates/${canaryEstimate.id}`, label: "Estimate detail", marker: CANARY_CUSTOMER },
    // Marker is the canary customer name (appears as a dropdown option
    // sourced from a real Prisma query on this page), not the static page
    // title: an unauthorized page's <title> is resolved by Next's metadata
    // system independently of the page component's own body/redirect and
    // isn't sensitive (it doesn't reveal any business data), so it isn't a
    // meaningful leak signal here.
    { path: "/estimates/new", label: "Create estimate", marker: CANARY_CUSTOMER },
    { path: "/jobs", label: "Jobs list", marker: CANARY_CUSTOMER },
    { path: `/jobs/${canaryJob.id}`, label: "Job detail", marker: CANARY_CUSTOMER },
    { path: "/invoices", label: "Invoices list", marker: CANARY_CUSTOMER },
    { path: `/invoices/${canaryInvoice.id}`, label: "Invoice detail", marker: CANARY_CUSTOMER },
    { path: "/services", label: "Services/pricing", marker: CANARY_CATALOG_ITEM },
    { path: "/settings", label: "Business Settings", marker: "Labor Minimum Service Fee" },
  ];

  console.log("\nTEST 1/2 — OWNER and ADMIN can read every current management page");
  for (const route of routes) {
    for (const [roleLabel, session] of [["OWNER", ownerSession], ["ADMIN", adminSession]]) {
      const { status, body } = await fetchRaw(session, route.path);
      check(`${roleLabel} GET ${route.path} (${route.label}) returns 200 (no redirect)`, status === 200);
      check(
        `${roleLabel} GET ${route.path} shows the real page (nav present, not restricted)`,
        body.includes(NAV_MARKER) && !body.includes(RESTRICTED_MARKER),
      );
      check(
        `${roleLabel} GET ${route.path} shows its expected content ("${route.marker}")`,
        body.includes(route.marker),
      );
    }
  }

  const memberRouteTestNumbers = {
    "/dashboard": "TEST 3",
    "/requests": "TEST 4",
    "/customers": "TEST 5",
    [`/customers/${canaryCustomer.id}`]: "TEST 5",
    "/estimates": "TEST 6",
    [`/estimates/${canaryEstimate.id}`]: "TEST 6",
    "/estimates/new": "TEST 6",
    "/jobs": "TEST 7",
    [`/jobs/${canaryJob.id}`]: "TEST 7",
    "/invoices": "TEST 8",
    [`/invoices/${canaryInvoice.id}`]: "TEST 8",
    "/services": "TEST 9",
    "/settings": "TEST 10",
  };

  console.log(
    "\nTEST 3-10 — MEMBER cannot read Dashboard/Requests/Customers/Estimates/Jobs/Invoices/Services/Settings",
  );
  for (const route of routes) {
    const testNumber = memberRouteTestNumbers[route.path] ?? "TEST";
    const raw = await fetchRaw(memberSession, route.path);
    check(
      `${testNumber} - MEMBER GET ${route.path} (${route.label}) is redirected server-side (307 -> /access-restricted), not rendered`,
      raw.status === 307 && raw.location === "/access-restricted",
    );
    check(
      `${testNumber} - MEMBER GET ${route.path} RAW response body never contains "${route.marker}" (not just hidden -- never fetched/serialized)`,
      !raw.body.includes(route.marker),
    );
    check(
      `${testNumber} - MEMBER GET ${route.path} RAW response body never contains the management nav either`,
      !raw.body.includes(NAV_MARKER),
    );

    const final = await fetchFinal(memberSession, route.path);
    check(
      `${testNumber} - MEMBER GET ${route.path}: following the redirect lands on the safe restricted page`,
      final.status === 200 && final.url.endsWith("/access-restricted") && final.body.includes(RESTRICTED_MARKER),
    );
    check(
      `${testNumber} - MEMBER GET ${route.path}: the final landing page also has no management nav and no leaked data`,
      !final.body.includes(NAV_MARKER) && !final.body.includes(route.marker),
    );
  }

  console.log(
    "\nTEST 11 — Direct URL access is rejected server-side (not merely hidden in nav): hitting a\n" +
    "          never-linked-from-a-MEMBER-nav detail URL directly still redirects before any data is fetched",
  );
  const directHit = await fetchRaw(memberSession, `/customers/${canaryCustomer.id}`);
  check(
    "Direct navigation to a customer detail URL (never shown in any MEMBER nav/link) is rejected server-side with a redirect",
    directHit.status === 307 && directHit.location === "/access-restricted",
  );
  check(
    "...and the customer's data was never present in that raw response",
    !directHit.body.includes(CANARY_CUSTOMER),
  );
  const memberStillAuthenticated = await fetchFinal(memberSession, "/dashboard");
  check(
    "MEMBER's session/cookies remain valid (not signed out) -- this is a page-level allow/deny decision, not an auth failure",
    memberStillAuthenticated.status === 200 && memberStillAuthenticated.body.includes("Sign out"),
  );

  console.log(
    failures === 0
      ? "\nAll management-console access checks passed."
      : `\n${failures} management-console access check(s) failed.`,
  );
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
  }
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
