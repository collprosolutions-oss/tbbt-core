/**
 * Owner day-route view proofs.
 *
 * Same-business scheduled jobs and structured property addresses only.
 * Incomplete and foreign addresses stay out of the maps link. Loading the
 * page does not write schedule fields.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-owner-day-route.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for owner day-route checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, canAccessManagementConsole } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const {
  FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS,
  OWNER_DAY_ROUTE_EXCLUDED_HEADING,
  OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL,
  OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
  OWNER_DAY_ROUTE_JOBS_TAKE,
  OWNER_DAY_ROUTE_MAPS_DISCLAIMER,
  OWNER_DAY_ROUTE_MAPS_LINK_LABEL,
  OWNER_DAY_ROUTE_MAPS_STOP_LIMIT,
  OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD,
  OWNER_DAY_ROUTE_NO_PROPERTY_LABEL,
  OWNER_DAY_ROUTE_PATH,
  OWNER_DAY_ROUTE_READ_ONLY_MESSAGE,
  buildOwnerDayRouteMapsHref,
  buildOwnerDayRouteView,
  completeStructuredRouteAddress,
  extractOwnerDayRouteMapsAddresses,
  loadOwnerDayRoute,
  ownerDayRouteExclusionLine,
  ownerDayRouteMapsContainsAddress,
  ownerDayRouteMapsFollowsAppointmentOrder,
  ownerDayRouteRoleAllowed,
  ownerDayRouteTextHasForbiddenClaim,
  ownerDayRouteViewText,
  readOwnerDayRouteScheduleSnapshots,
} = await import("@/lib/owner-day-route");
const { dayRange, parseScheduleDate } = await import("@/lib/schedule");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const libFiles = [
  "src/lib/owner-day-route/constants.ts",
  "src/lib/owner-day-route/types.ts",
  "src/lib/owner-day-route/access.ts",
  "src/lib/owner-day-route/address.ts",
  "src/lib/owner-day-route/maps.ts",
  "src/lib/owner-day-route/build.ts",
  "src/lib/owner-day-route/load.ts",
  "src/lib/owner-day-route/wording.ts",
  "src/lib/owner-day-route/index.ts",
];
const uiFiles = [
  "src/app/(app)/today/day-route/page.tsx",
  "src/components/today/owner-day-route.tsx",
];
const displaySource = uiFiles.map(readSrc).join("\n");
const allFeatureSource = [...libFiles, ...uiFiles].map(readSrc).join("\n");
const loadSrc = readSrc("src/lib/owner-day-route/load.ts");
const pageSrc = readSrc("src/app/(app)/today/day-route/page.tsx");
const navSrc = readSrc("src/lib/nav.ts");
const appShellSrc = readSrc("src/components/app-shell.tsx");
const packageSrc = readSrc("package.json");
const schemaSrc = readSrc("prisma/schema.prisma");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_owner_day_route_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for owner day-route test database.");
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

const NY = "America/New_York";
const dayIso = "2026-09-27";
const range = dayRange(parseScheduleDate(dayIso, NY), NY);
const morning = new Date("2026-09-27T13:00:00.000Z"); // 9:00 AM ET
const afternoon = new Date("2026-09-27T18:00:00.000Z"); // 2:00 PM ET
const otherDay = new Date("2026-09-28T13:00:00.000Z");

function jobRecord(overrides = {}) {
  return {
    id: overrides.id ?? "job-1",
    businessId: overrides.businessId ?? "biz-a",
    customerId: overrides.customerId ?? "cust-a",
    status: overrides.status ?? "SCHEDULED",
    scheduledAt: overrides.scheduledAt === undefined ? morning : overrides.scheduledAt,
    scheduledDurationMinutes: overrides.scheduledDurationMinutes ?? 60,
    arrivalWindowMinutes: overrides.arrivalWindowMinutes ?? null,
    pickupDurationMinutes: overrides.pickupDurationMinutes ?? null,
    customer: overrides.customer ?? { id: "cust-a", name: "Pat" },
    property: overrides.property === undefined
      ? {
          id: "prop-a",
          businessId: "biz-a",
          addressLine1: "10 Main St",
          addressLine2: null,
          city: "Austin",
          region: "TX",
          postalCode: "78701",
        }
      : overrides.property,
    ...overrides,
  };
}

try {
  console.log("\nSTATIC — isolated read-only page, no global nav, no overclaim");
  check("Route is /today/day-route", OWNER_DAY_ROUTE_PATH === "/today/day-route" && pageSrc.includes("OwnerDayRoutePage"));
  check(
    "Page calls requireManagementPageAccess before loading",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.indexOf("requireManagementPageAccess") < pageSrc.indexOf("loadOwnerDayRoute"),
  );
  check(
    "Shared nav was not given a Day route link",
    !APP_NAV.some((item) => item.href === OWNER_DAY_ROUTE_PATH || item.label === "Day route") &&
      !navSrc.includes("day-route") &&
      !appShellSrc.includes("day-route"),
  );
  check("No npm script was invented for this check", !packageSrc.includes("check-owner-day-route"));
  check(
    "Loader is read-only on page load",
    OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD === false &&
      loadSrc.includes("mutationsOnLoad") &&
      !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(loadSrc),
  );
  check(
    "Page load does not schedule or assign jobs",
    !pageSrc.includes("scheduleJob") &&
      !pageSrc.includes("assignJobMember") &&
      !allFeatureSource.includes("prisma.job.update") &&
      !allFeatureSource.includes("prisma.job.create"),
  );
  check(
    "No schema / migrate / Prisma model edits in this view",
    !/model Job|model Property|prisma migrate|schema\.prisma/.test(allFeatureSource),
  );
  check(
    "Discovery is bounded",
    loadSrc.includes("take: OWNER_DAY_ROUTE_JOBS_TAKE") && OWNER_DAY_ROUTE_JOBS_TAKE === 50,
  );
  check(
    "Query scopes jobs by businessId and the business-day scheduledAt range",
    loadSrc.includes("businessId: input.businessId") &&
      loadSrc.includes("scheduledAt: { gte: range.start, lt: range.end }"),
  );
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("OWNER and ADMIN may open the day route", ownerDayRouteRoleAllowed("OWNER") && ownerDayRouteRoleAllowed("ADMIN"));
  check("MEMBER role is denied by the day-route gate", ownerDayRouteRoleAllowed("MEMBER") === false);
  check(
    "Display copy does not claim traffic optimization, precise GIS, or automatic ETA",
    !ownerDayRouteTextHasForbiddenClaim(displaySource) &&
      !FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS.some((pattern) => pattern.test(displaySource)),
  );
  check(
    "Read-only and maps limits are stated",
    /does not change any schedule/.test(OWNER_DAY_ROUTE_READ_ONLY_MESSAGE) &&
      /does not rearrange stops for travel time/.test(OWNER_DAY_ROUTE_MAPS_DISCLAIMER) &&
      /One maps link is available for the owner to open/.test(OWNER_DAY_ROUTE_MAPS_DISCLAIMER) &&
      OWNER_DAY_ROUTE_MAPS_STOP_LIMIT === 11,
  );
  check(
    "Owner opens one maps href; stops do not get their own maps links",
    displaySource.includes("view.maps.href") &&
      displaySource.includes("OWNER_DAY_ROUTE_MAPS_LINK_LABEL") &&
      OWNER_DAY_ROUTE_MAPS_LINK_LABEL === "Open in maps" &&
      !displaySource.includes("stop.mapsQuery") &&
      !displaySource.includes("directionsHref") &&
      !displaySource.includes("/maps/search"),
  );
  check(
    "Maps card lists excluded stops with reasons",
    displaySource.includes("OWNER_DAY_ROUTE_EXCLUDED_HEADING") &&
      displaySource.includes("view.excludedStops") &&
      displaySource.includes("ownerDayRouteExclusionLine"),
  );
  check(
    "Street-only addresses are not treated as complete structured stops",
    completeStructuredRouteAddress(
      {
        id: "p1",
        businessId: "biz-a",
        addressLine1: "99 One Line Rd, Austin, TX 78701",
        city: null,
        region: null,
        postalCode: null,
      },
      "biz-a",
    ).ok === false,
  );
  check(
    "Foreign property id fails closed even with complete fields",
    completeStructuredRouteAddress(
      {
        id: "p-b",
        businessId: "biz-b",
        addressLine1: "1 Other St",
        city: "Dallas",
        region: "TX",
        postalCode: "75001",
      },
      "biz-a",
    ).reason === "FOREIGN_PROPERTY",
  );

  const unitView = buildOwnerDayRouteView(
    [
      jobRecord({
        id: "job-late",
        scheduledAt: afternoon,
        customer: { name: "Late" },
        property: {
          id: "prop-late",
          businessId: "biz-a",
          addressLine1: "200 Late Ave",
          city: "Austin",
          region: "TX",
          postalCode: "78702",
        },
      }),
      jobRecord({
        id: "job-early",
        scheduledAt: morning,
        customer: { name: "Early" },
        pickupDurationMinutes: 30,
        property: {
          id: "prop-early",
          businessId: "biz-a",
          addressLine1: "10 Early St",
          city: "Austin",
          region: "TX",
          postalCode: "78701",
        },
      }),
      jobRecord({
        id: "job-foreign",
        businessId: "biz-b",
        scheduledAt: morning,
        customer: { name: "Foreign" },
        property: {
          id: "prop-foreign",
          businessId: "biz-b",
          addressLine1: "77 Foreign Secret Ave",
          city: "Dallas",
          region: "TX",
          postalCode: "75002",
        },
      }),
      jobRecord({
        id: "job-incomplete",
        scheduledAt: new Date("2026-09-27T15:00:00.000Z"),
        customer: { name: "Incomplete" },
        property: {
          id: "prop-incomplete",
          businessId: "biz-a",
          addressLine1: "12 Partial Row",
          city: null,
          region: null,
          postalCode: null,
        },
      }),
      jobRecord({
        id: "job-other-day",
        scheduledAt: otherDay,
        customer: { name: "Tomorrow" },
      }),
    ],
    { businessId: "biz-a", range, timeZone: NY },
  );

  check("Stops are ordered by recorded appointment time, not geography", unitView.stops.map((stop) => stop.jobId).join(",") === "job-early,job-incomplete,job-late");
  check("Foreign job never becomes a stop", !unitView.stops.some((stop) => stop.jobId === "job-foreign"));
  check("Other-day job never becomes a stop", !unitView.stops.some((stop) => stop.jobId === "job-other-day"));
  check(
    "Incomplete structured address is listed and excluded from maps",
    unitView.excludedStops.some(
      (stop) =>
        stop.jobId === "job-incomplete" &&
        stop.exclusionReason === "INCOMPLETE_ADDRESS" &&
        stop.exclusionLabel === OWNER_DAY_ROUTE_INCOMPLETE_LABEL &&
        stop.includedInMaps === false,
    ),
  );
  check(
    "Recorded material pickup is shown only when persisted minutes exist",
    unitView.stops.find((stop) => stop.jobId === "job-early")?.materialPickup.recorded === true &&
      unitView.stops.find((stop) => stop.jobId === "job-late")?.materialPickup.recorded === false,
  );
  check(
    "Known appointment window uses the recorded start and duration",
    unitView.stops.find((stop) => stop.jobId === "job-early")?.appointmentWindowLabel?.includes("9:00") === true &&
      unitView.stops.find((stop) => stop.jobId === "job-early")?.appointmentWindowLabel?.includes("10:00") === true,
  );
  const unitAddresses = extractOwnerDayRouteMapsAddresses(unitView.maps.href);
  check(
    "Maps link contains only complete same-business addresses in appointment order",
    unitView.maps.href?.startsWith("https://www.google.com/maps/dir/?") === true &&
      ownerDayRouteMapsFollowsAppointmentOrder(unitView.maps.href, unitView.stops) &&
      unitAddresses[0]?.includes("10 Early St") === true &&
      unitAddresses[1]?.includes("200 Late Ave") === true &&
      unitAddresses.length === 2 &&
      !unitAddresses.some((address) => address.includes("Foreign Secret") || address.includes("12 Partial")),
  );
  check(
    "Incomplete and foreign-property stops are named in the exclusion list",
    unitView.excludedHeading === OWNER_DAY_ROUTE_EXCLUDED_HEADING &&
      unitView.excludedStops.some(
        (stop) =>
          stop.jobId === "job-incomplete" &&
          ownerDayRouteExclusionLine(stop).includes("Incomplete") &&
          ownerDayRouteViewText(unitView).includes(ownerDayRouteExclusionLine(stop)),
      ),
  );
  check(
    "Foreign and incomplete address text never enter the route link",
    !ownerDayRouteMapsContainsAddress(unitView.maps.href, "77 Foreign Secret Ave") &&
      !ownerDayRouteMapsContainsAddress(unitView.maps.href, "12 Partial Row") &&
      !unitView.maps.href?.includes("Foreign") &&
      !unitView.maps.href?.includes("Partial"),
  );
  check(
    "View copy stays inside the no-overclaim wording",
    !ownerDayRouteTextHasForbiddenClaim(ownerDayRouteViewText(unitView)),
  );
  check(
    "Missing property uses the recorded exclusion label",
    buildOwnerDayRouteView([jobRecord({ id: "job-none", property: null })], {
      businessId: "biz-a",
      range,
      timeZone: NY,
    }).excludedStops[0]?.exclusionLabel === OWNER_DAY_ROUTE_NO_PROPERTY_LABEL,
  );
  check(
    "Single complete stop still produces a working maps destination link",
    buildOwnerDayRouteMapsHref(["10 Early St, Austin, TX 78701"])?.includes("destination=") === true,
  );

  const truncatedView = buildOwnerDayRouteView(
    Array.from({ length: 12 }, (_, index) =>
      jobRecord({
        id: `job-t${index}`,
        scheduledAt: new Date(morning.getTime() + index * 60_000),
        customer: { name: `Trunc ${index + 1}` },
        property: {
          id: `prop-t${index}`,
          businessId: "biz-a",
          addressLine1: `${100 + index} Trunc St`,
          city: "Austin",
          region: "TX",
          postalCode: "78701",
        },
      }),
    ),
    { businessId: "biz-a", range, timeZone: NY },
  );
  const truncatedAddresses = extractOwnerDayRouteMapsAddresses(truncatedView.maps.href);
  check(
    "Maps link keeps the first 11 complete stops in appointment order",
    truncatedView.maps.truncated === true &&
      truncatedView.maps.includedStopCount === 11 &&
      truncatedView.maps.omittedCompleteStopCount === 1 &&
      ownerDayRouteMapsFollowsAppointmentOrder(truncatedView.maps.href, truncatedView.stops) &&
      truncatedAddresses[0]?.includes("100 Trunc St") === true &&
      truncatedAddresses[10]?.includes("110 Trunc St") === true &&
      truncatedAddresses.length === 11,
  );
  check(
    "Twelfth complete stop stays off the maps link",
    !ownerDayRouteMapsContainsAddress(truncatedView.maps.href, "111 Trunc St") &&
      !truncatedAddresses.some((address) => address.includes("111 Trunc St")),
  );

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Route",
      slug: `alpha-route-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Route",
      slug: `beta-route-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-route-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-route-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const completeProperty = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Maple St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
  });
  const laterProperty = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "500 Oak Blvd",
      city: "Austin",
      region: "TX",
      postalCode: "78704",
    },
  });
  const incompleteProperty = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "12 Partial Row",
    },
  });
  const foreignProperty = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      addressLine1: "77 Foreign Secret Ave",
      city: "Dallas",
      region: "TX",
      postalCode: "75002",
    },
  });

  const earlyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: completeProperty.id,
      status: "SCHEDULED",
      scheduledAt: morning,
      scheduledDurationMinutes: 60,
      pickupDurationMinutes: 45,
      arrivalWindowMinutes: null,
      projectToken: randomUUID(),
    },
  });
  const lateJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: laterProperty.id,
      status: "SCHEDULED",
      scheduledAt: afternoon,
      scheduledDurationMinutes: 90,
      projectToken: randomUUID(),
    },
  });
  const incompleteJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: incompleteProperty.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-27T15:30:00.000Z"),
      scheduledDurationMinutes: 30,
      projectToken: randomUUID(),
    },
  });
  const leakedPropertyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: foreignProperty.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-27T16:00:00.000Z"),
      scheduledDurationMinutes: 30,
      projectToken: randomUUID(),
    },
  });
  const otherDayJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: completeProperty.id,
      status: "SCHEDULED",
      scheduledAt: otherDay,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: foreignProperty.id,
      status: "SCHEDULED",
      scheduledAt: morning,
      scheduledDurationMinutes: 60,
      pickupDurationMinutes: 20,
      projectToken: randomUUID(),
    },
  });

  const watchedIds = [
    earlyJob.id,
    lateJob.id,
    incompleteJob.id,
    leakedPropertyJob.id,
    otherDayJob.id,
    foreignJob.id,
  ];
  const before = await readOwnerDayRouteScheduleSnapshots(prisma, businessA.id, watchedIds);
  const beforeForeign = await readOwnerDayRouteScheduleSnapshots(prisma, businessB.id, [foreignJob.id]);

  console.log("\nTEST — MEMBER denied and load stays read-only");
  try {
    await loadOwnerDayRoute(prisma, {
      businessId: businessA.id,
      role: "MEMBER",
      date: dayIso,
      timeZone: NY,
    });
    check("MEMBER denied", false);
  } catch (error) {
    check("MEMBER denied", error instanceof ForbiddenError);
  }

  const view = await loadOwnerDayRoute(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    date: dayIso,
    timeZone: NY,
  });
  const after = await readOwnerDayRouteScheduleSnapshots(prisma, businessA.id, watchedIds);
  const afterForeign = await readOwnerDayRouteScheduleSnapshots(prisma, businessB.id, [foreignJob.id]);

  check(
    "Viewing the page changes no local schedule fields",
    JSON.stringify(before) === JSON.stringify(after),
  );
  check(
    "Viewing the page changes no foreign schedule fields",
    JSON.stringify(beforeForeign) === JSON.stringify(afterForeign),
  );
  check("Load result is marked read-only", view.readOnly === true && view.mutationsOnLoad === false);

  console.log("\nTEST — same-business stops, exclusions, and maps isolation");
  check(
    "Persisted jobs stay in recorded appointment order",
    view.stops.map((stop) => stop.jobId).join(",") ===
      [earlyJob.id, incompleteJob.id, leakedPropertyJob.id, lateJob.id].sort((left, right) => {
        const times = {
          [earlyJob.id]: morning.getTime(),
          [incompleteJob.id]: new Date("2026-09-27T15:30:00.000Z").getTime(),
          [leakedPropertyJob.id]: new Date("2026-09-27T16:00:00.000Z").getTime(),
          [lateJob.id]: afternoon.getTime(),
        };
        return times[left] - times[right];
      }).join(","),
  );
  check("Foreign job is absent from the loaded route", !view.stops.some((stop) => stop.jobId === foreignJob.id));
  check("Other-day job is absent from the loaded route", !view.stops.some((stop) => stop.jobId === otherDayJob.id));
  check(
    "Incomplete address is excluded from maps and labeled",
    view.stops.some(
      (stop) =>
        stop.jobId === incompleteJob.id &&
        stop.includedInMaps === false &&
        stop.exclusionLabel === OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
    ),
  );
  check(
    "Foreign property on a local job is excluded and not displayed",
    view.stops.some(
      (stop) =>
        stop.jobId === leakedPropertyJob.id &&
        stop.includedInMaps === false &&
        stop.exclusionLabel === OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL &&
        stop.address === null &&
        stop.mapsQuery === null,
    ),
  );
  check(
    "Recorded 45-minute material pickup is visible on the morning stop",
    view.stops.find((stop) => stop.jobId === earlyJob.id)?.materialPickup.durationMinutes === 45 &&
      view.stops.find((stop) => stop.jobId === earlyJob.id)?.materialPickup.blockLabel?.includes("Pickup block") === true,
  );
  const loadedAddresses = extractOwnerDayRouteMapsAddresses(view.maps.href);
  check(
    "Maps link includes only the two complete local addresses in appointment order",
    view.maps.includedStopCount === 2 &&
      ownerDayRouteMapsFollowsAppointmentOrder(view.maps.href, view.stops) &&
      loadedAddresses[0]?.includes("10 Maple St") === true &&
      loadedAddresses[1]?.includes("500 Oak Blvd") === true &&
      loadedAddresses.length === 2,
  );
  check(
    "Loaded exclusions name the incomplete and foreign-property stops",
    view.excludedStops.some(
      (stop) =>
        stop.jobId === incompleteJob.id &&
        ownerDayRouteExclusionLine(stop).includes(OWNER_DAY_ROUTE_INCOMPLETE_LABEL),
    ) &&
      view.excludedStops.some(
        (stop) =>
          stop.jobId === leakedPropertyJob.id &&
          ownerDayRouteExclusionLine(stop).includes(OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL),
      ),
  );
  check(
    "No foreign job or address enters the route link",
    !ownerDayRouteMapsContainsAddress(view.maps.href, "77 Foreign Secret Ave") &&
      !view.maps.href?.includes(foreignJob.id) &&
      !view.maps.href?.includes("Foreign Secret") &&
      !view.maps.href?.includes("12 Partial Row") &&
      !loadedAddresses.some((address) => /Foreign|Partial|Beta Secret/i.test(address)),
  );
  check(
    "ADMIN can load the same isolated route",
    (await loadOwnerDayRoute(prisma, {
      businessId: businessA.id,
      role: "ADMIN",
      date: dayIso,
      timeZone: NY,
    })).maps.includedStopCount === 2,
  );

  if (failures > 0) {
    console.error(`\n${failures} owner day-route check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOwner day-route checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
