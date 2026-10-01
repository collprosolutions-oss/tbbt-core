/**
 * Native Today assigned-stop maps handoff — assignment + tenant isolation,
 * recorded appointment order, complete-address eligibility, and the
 * maps stop cap.
 *
 * Reuses completeStructuredRouteAddress and buildOwnerDayRouteMapsHandoff.
 * Does not invent a second Job-detail directionsHref.
 *
 * Dedicated database: tbbt_native_assigned_stops_test
 *
 * Run with:
 *   npm run test:native-assigned-stops
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { loadNativeToday } = await import("@/lib/native-field");
const {
  NATIVE_ASSIGNED_STOPS_CAP_LABEL,
  NATIVE_ASSIGNED_STOPS_DISCLAIMER,
  NATIVE_ASSIGNED_STOPS_MAPS_LINK_LABEL,
  buildNativeAssignedStopsMaps,
  nativeAssignedStopsMapsFollowsAppointmentOrder,
} = await import("@/lib/native-assigned-stops");
const {
  OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
  OWNER_DAY_ROUTE_MAPS_STOP_LIMIT,
  OWNER_DAY_ROUTE_NO_PROPERTY_LABEL,
  completeStructuredRouteAddress,
  extractOwnerDayRouteMapsAddresses,
  ownerDayRouteMapsContainsAddress,
  ownerDayRouteTextHasForbiddenClaim,
} = await import("@/lib/owner-day-route");
const { formatStructuredAddress } = await import("@/lib/service-address");
const { dayRange } = await import("@/lib/schedule");

const NY = "America/New_York";
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsed = new URL(baseUrl);
if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
  console.error(
    "Refusing to run: DATABASE_URL host must be localhost or 127.0.0.1 because this script runs prisma db push --accept-data-loss.",
  );
  process.exit(1);
}

const testDbName = "tbbt_native_assigned_stops_test";
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native assigned-stops test database.");
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function completeAddress(street) {
  return {
    addressLine1: street,
    addressLine2: null,
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
  };
}

function formatted(street) {
  return formatStructuredAddress({
    streetAddress: street,
    unit: "",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
  });
}

const assignedStopsSrc = readRepo("src/lib/native-assigned-stops.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const todayScreenSrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const directionsSrc = readRepo("src/lib/directions.ts");

console.log("\nSTATIC — Reuse owner address/maps helpers; do not duplicate Job-detail Directions");
check(
  "Assigned-stops maps reuses completeStructuredRouteAddress and the owner maps handoff",
  assignedStopsSrc.includes("completeStructuredRouteAddress") &&
    assignedStopsSrc.includes("buildOwnerDayRouteMapsHandoff") &&
    assignedStopsSrc.includes("OWNER_DAY_ROUTE_MAPS_STOP_LIMIT") &&
    nativeFieldSrc.includes("buildNativeAssignedStopsMaps") &&
    nativeFieldSrc.includes("listNativeAssignedDayJobs") &&
    nativeFieldSrc.includes("assignedStops"),
);
check(
  "Job detail keeps the existing directionsHref and is not given a second maps URL",
  jobScreenSrc.includes("job.directionsHref") &&
    jobScreenSrc.includes("Linking.openURL(job.directionsHref") &&
    !jobScreenSrc.includes("Open assigned stops in maps") &&
    !jobScreenSrc.includes("assignedStops") &&
    nativeFieldSrc.includes("directionsHref: directionsUrl(job.property)") &&
    directionsSrc.includes("export function directionsUrl"),
);
check(
  "Native Today has one Open assigned stops in maps link and lists exclusions",
  todayScreenSrc.includes("Open assigned stops in maps") ||
    (todayScreenSrc.includes("AssignedStopsMapsCard") &&
      todayScreenSrc.includes("stops.label") &&
      todayScreenSrc.includes("stops.excluded") &&
      todayScreenSrc.includes("Linking.openURL(stops.href")),
);
check(
  "Wording stays read-only and makes no optimization or ETA claims",
  !/optimized route|traffic|ETA|geocod/i.test(NATIVE_ASSIGNED_STOPS_DISCLAIMER) &&
    !ownerDayRouteTextHasForbiddenClaim(NATIVE_ASSIGNED_STOPS_DISCLAIMER) &&
    assignedStopsSrc.includes("does not rearrange") &&
    docsSrc.includes("Open assigned stops in maps") &&
    docsSrc.includes("test:native-assigned-stops"),
);

const day = new Date("2026-10-01T16:00:00.000Z");
const range = dayRange(day, NY);
const early = new Date("2026-10-01T13:00:00.000Z");
const late = new Date("2026-10-01T18:00:00.000Z");
const tomorrow = new Date("2026-10-02T13:00:00.000Z");

function jobFixture(input) {
  return {
    id: input.id,
    businessId: input.businessId ?? "biz-a",
    assignedMembershipId: input.assignedMembershipId ?? "mem-a",
    status: "SCHEDULED",
    scheduledAt: input.scheduledAt,
    scheduledDurationMinutes: 60,
    customer: { name: input.name },
    property: input.property,
  };
}

const earlyStreet = "10 Early St";
const lateStreet = "200 Late Ave";
const otherStreet = "55 Other Worker Rd";
const betaStreet = "77 Foreign Secret Ave";
const incompleteStreet = "12 Partial Row";
const builder = buildNativeAssignedStopsMaps(
  [
    jobFixture({
      id: "job-late",
      name: "Late",
      scheduledAt: late,
      property: { id: "p-late", businessId: "biz-a", ...completeAddress(lateStreet) },
    }),
    jobFixture({
      id: "job-early",
      name: "Early",
      scheduledAt: early,
      property: { id: "p-early", businessId: "biz-a", ...completeAddress(earlyStreet) },
    }),
    jobFixture({
      id: "job-other-worker",
      name: "Other Worker",
      assignedMembershipId: "mem-other",
      scheduledAt: new Date("2026-10-01T14:00:00.000Z"),
      property: { id: "p-other", businessId: "biz-a", ...completeAddress(otherStreet) },
    }),
    jobFixture({
      id: "job-beta",
      name: "Beta",
      businessId: "biz-b",
      assignedMembershipId: "mem-beta",
      scheduledAt: new Date("2026-10-01T14:30:00.000Z"),
      property: { id: "p-beta", businessId: "biz-b", ...completeAddress(betaStreet) },
    }),
    jobFixture({
      id: "job-incomplete",
      name: "Incomplete",
      scheduledAt: new Date("2026-10-01T15:00:00.000Z"),
      property: {
        id: "p-incomplete",
        businessId: "biz-a",
        addressLine1: incompleteStreet,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
      },
    }),
    jobFixture({
      id: "job-none",
      name: "No Property",
      scheduledAt: new Date("2026-10-01T15:30:00.000Z"),
      property: null,
    }),
    jobFixture({
      id: "job-tomorrow",
      name: "Tomorrow",
      scheduledAt: tomorrow,
      property: { id: "p-tomorrow", businessId: "biz-a", ...completeAddress("9 Later St") },
    }),
  ],
  { businessId: "biz-a", membershipId: "mem-a", range },
);

const builderAddresses = extractOwnerDayRouteMapsAddresses(builder.href);
check(
  "Builder keeps recorded appointment order and the existing maps handoff",
  builder.href?.startsWith("https://www.google.com/maps/dir/?") === true &&
    nativeAssignedStopsMapsFollowsAppointmentOrder(builder.href, [
      formatted(earlyStreet),
      formatted(lateStreet),
    ]) &&
    builderAddresses[0].includes("10 Early St") &&
    builderAddresses[1].includes("200 Late Ave") &&
    builder.includedStopCount === 2 &&
    builder.label === NATIVE_ASSIGNED_STOPS_MAPS_LINK_LABEL,
);
check(
  "Other-worker, other-tenant, and other-day jobs never enter the maps link or exclusion list",
  !ownerDayRouteMapsContainsAddress(builder.href, otherStreet) &&
    !ownerDayRouteMapsContainsAddress(builder.href, betaStreet) &&
    !builder.excluded.some((stop) =>
      ["job-other-worker", "job-beta", "job-tomorrow"].includes(stop.jobId),
    ) &&
    !builder.href?.includes("Foreign Secret") &&
    !builder.href?.includes("Other Worker"),
);
check(
  "Incomplete and missing addresses are named as excluded",
  builder.excluded.some(
    (stop) =>
      stop.jobId === "job-incomplete" &&
      stop.reason === "INCOMPLETE_ADDRESS" &&
      stop.label === OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
  ) &&
    builder.excluded.some(
      (stop) =>
        stop.jobId === "job-none" &&
        stop.reason === "NO_PROPERTY" &&
        stop.label === OWNER_DAY_ROUTE_NO_PROPERTY_LABEL,
    ),
);

const overflowJobs = [];
for (let i = 1; i <= OWNER_DAY_ROUTE_MAPS_STOP_LIMIT + 1; i += 1) {
  overflowJobs.push(
    jobFixture({
      id: `job-cap-${String(i).padStart(2, "0")}`,
      name: `Cap ${i}`,
      scheduledAt: new Date(early.getTime() + i * 60_000),
      property: {
        id: `p-cap-${i}`,
        businessId: "biz-a",
        ...completeAddress(`${100 + i} Cap St`),
      },
    }),
  );
}
const overflow = buildNativeAssignedStopsMaps(overflowJobs, {
  businessId: "biz-a",
  membershipId: "mem-a",
  range,
});
const overflowAddresses = extractOwnerDayRouteMapsAddresses(overflow.href);
check(
  "Maps link includes at most 11 complete assigned stops",
  overflow.includedStopCount === OWNER_DAY_ROUTE_MAPS_STOP_LIMIT &&
    overflow.truncated === true &&
    overflow.omittedCompleteStopCount === 1 &&
    overflowAddresses.length === OWNER_DAY_ROUTE_MAPS_STOP_LIMIT &&
    overflow.excluded.some(
      (stop) =>
        stop.jobId === "job-cap-12" &&
        stop.reason === "OVER_CAP" &&
        stop.label === NATIVE_ASSIGNED_STOPS_CAP_LABEL,
    ) &&
    !ownerDayRouteMapsContainsAddress(overflow.href, "112 Cap St"),
);

try {
  const password = "native-assigned-stops-pass-9";
  const passwordHash = await hashPassword(password);
  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Stops",
      slug: `alpha-native-stops-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Stops",
      slug: `beta-native-stops-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });

  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-stops.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-stops.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-stops.example`,
      passwordHash,
    },
  });

  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });

  async function createJob(input) {
    const customer = await prisma.customer.create({
      data: { businessId: input.businessId, name: input.customerName, phone: "555-0142" },
    });
    const property = input.property
      ? await prisma.property.create({
          data: {
            businessId: input.property.businessId ?? input.businessId,
            customerId: customer.id,
            addressLine1: input.property.addressLine1,
            addressLine2: input.property.addressLine2 ?? null,
            city: input.property.city ?? null,
            region: input.property.region ?? null,
            postalCode: input.property.postalCode ?? null,
          },
        })
      : null;
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        propertyId: property?.id ?? null,
        assignedMembershipId: input.assignedMembershipId ?? null,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: input.scheduledAt,
        scheduledDurationMinutes: 60,
      },
    });
  }

  const now = new Date("2026-10-01T16:00:00.000Z");
  const liveEarly = await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Early",
    scheduledAt: new Date("2026-10-01T13:00:00.000Z"),
    property: { ...completeAddress("10 Live Early St") },
  });
  const liveLate = await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Late",
    scheduledAt: new Date("2026-10-01T18:00:00.000Z"),
    property: { ...completeAddress("200 Live Late Ave") },
  });
  await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Incomplete",
    scheduledAt: new Date("2026-10-01T15:00:00.000Z"),
    property: { addressLine1: "12 Live Partial Row", city: null, region: null, postalCode: null },
  });
  await createJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Live Other Worker",
    scheduledAt: new Date("2026-10-01T14:00:00.000Z"),
    property: { ...completeAddress("55 Live Other Rd") },
  });
  await createJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Live Beta",
    scheduledAt: new Date("2026-10-01T14:30:00.000Z"),
    property: { ...completeAddress("77 Live Foreign Ave") },
  });
  await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Yesterday",
    scheduledAt: new Date("2026-09-30T15:00:00.000Z"),
    property: { ...completeAddress("8 Live Yesterday St") },
  });
  await createJob({
    businessId: businessA.id,
    assignedMembershipId: null,
    customerName: "Live Unassigned",
    scheduledAt: new Date("2026-10-01T14:15:00.000Z"),
    property: { ...completeAddress("33 Live Unassigned Rd") },
  });

  for (let i = 1; i <= OWNER_DAY_ROUTE_MAPS_STOP_LIMIT - 1; i += 1) {
    await createJob({
      businessId: businessA.id,
      assignedMembershipId: memberMem.id,
      customerName: `Live Cap ${i}`,
      scheduledAt: new Date(Date.parse("2026-10-01T13:10:00.000Z") + i * 60_000),
      property: { ...completeAddress(`${110 + i} Live Cap St`) },
    });
  }
  await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Cap Overflow",
    scheduledAt: new Date("2026-10-01T19:00:00.000Z"),
    property: { ...completeAddress("199 Live Cap Overflow St") },
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  const otherSignIn = await signInNativeField(prisma, {
    email: otherUser.email,
    password,
  });
  const betaSignIn = await signInNativeField(prisma, {
    email: betaUser.email,
    password,
  });
  check("Assigned worker can sign in", memberSignIn.ok === true);
  if (!memberSignIn.ok || !otherSignIn.ok || !betaSignIn.ok) {
    throw new Error("Native assigned-stops fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  if (!memberAccess.ok || !otherAccess.ok || !betaAccess.ok) {
    throw new Error("Native assigned-stops fixture access failed.");
  }

  console.log("\nLIVE — Assignment, tenant isolation, order, and stop cap");
  const memberToday = await loadNativeToday(prisma, memberAccess.access, { now });
  const otherToday = await loadNativeToday(prisma, otherAccess.access, { now });
  const betaToday = await loadNativeToday(prisma, betaAccess.access, { now });
  const memberHref = memberToday.assignedStops.href;
  const memberAddresses = extractOwnerDayRouteMapsAddresses(memberHref);
  const earlyComplete = completeStructuredRouteAddress(
    {
      id: "x",
      businessId: businessA.id,
      ...completeAddress("10 Live Early St"),
    },
    businessA.id,
  );

  check(
    "Assigned Today maps is read-only and uses the existing maps handoff",
    memberToday.assignedStops.label === NATIVE_ASSIGNED_STOPS_MAPS_LINK_LABEL &&
      memberHref?.startsWith("https://www.google.com/maps/dir/?") === true &&
      memberToday.assignedStops.disclaimer === NATIVE_ASSIGNED_STOPS_DISCLAIMER,
  );
  check(
    "Assigned maps starts with the earliest complete assigned stop",
    earlyComplete.ok === true &&
      memberAddresses[0] === earlyComplete.address.formatted &&
      ownerDayRouteMapsContainsAddress(memberHref, "10 Live Early St"),
  );
  check(
    "Other-worker and other-tenant complete addresses stay out of the assigned maps link",
    !ownerDayRouteMapsContainsAddress(memberHref, "55 Live Other Rd") &&
      !ownerDayRouteMapsContainsAddress(memberHref, "77 Live Foreign Ave") &&
      !ownerDayRouteMapsContainsAddress(memberHref, "8 Live Yesterday St") &&
      !ownerDayRouteMapsContainsAddress(memberHref, "33 Live Unassigned Rd") &&
      !memberToday.assignedStops.excluded.some((stop) =>
        ["Live Other Worker", "Live Beta", "Live Yesterday", "Live Unassigned"].includes(
          stop.customerName,
        ),
      ) &&
      !memberToday.today.some((job) => job.customerName === "Live Other Worker") &&
      !memberToday.today.some((job) => job.customerName === "Live Beta") &&
      !memberToday.today.some((job) => job.customerName === "Live Unassigned"),
  );
  check(
    "Incomplete assigned stop is excluded from maps and named",
    memberToday.assignedStops.excluded.some(
      (stop) =>
        stop.customerName === "Live Incomplete" &&
        stop.reason === "INCOMPLETE_ADDRESS" &&
        stop.label === OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
    ) && !ownerDayRouteMapsContainsAddress(memberHref, "12 Live Partial Row"),
  );
  check(
    "Stop cap keeps the 12th complete assigned stop off the maps link",
    memberToday.assignedStops.includedStopCount === OWNER_DAY_ROUTE_MAPS_STOP_LIMIT &&
      memberToday.assignedStops.truncated === true &&
      memberToday.assignedStops.excluded.some(
        (stop) =>
          stop.customerName === "Live Cap Overflow" &&
          stop.reason === "OVER_CAP" &&
          stop.label === NATIVE_ASSIGNED_STOPS_CAP_LABEL,
      ) &&
      !ownerDayRouteMapsContainsAddress(memberHref, "199 Live Cap Overflow St") &&
      !ownerDayRouteMapsContainsAddress(memberHref, "200 Live Late Ave"),
  );
  check(
    "Another worker only sees their own assigned complete stop",
    otherToday.assignedStops.includedStopCount === 1 &&
      ownerDayRouteMapsContainsAddress(otherToday.assignedStops.href, "55 Live Other Rd") &&
      !ownerDayRouteMapsContainsAddress(otherToday.assignedStops.href, "10 Live Early St"),
  );
  check(
    "Other-tenant Today maps cannot include this tenant's assigned stops",
    ownerDayRouteMapsContainsAddress(betaToday.assignedStops.href, "77 Live Foreign Ave") &&
      !ownerDayRouteMapsContainsAddress(betaToday.assignedStops.href, "10 Live Early St") &&
      betaToday.assignedStops.excluded.every((stop) => stop.jobId !== liveEarly.id && stop.jobId !== liveLate.id),
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} native assigned-stops check(s) failed.`);
  process.exit(1);
}

console.log("\nNative assigned-stops maps checks passed.");
