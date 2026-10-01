/**
 * Native assigned-job maps proofs.
 *
 * Reuses /today/day-route same-business structured-address rules.
 * A maps link is available only for the worker's assigned job when that
 * address is complete. Incomplete same-business addresses stay visible
 * with a reason. Foreign property data stays hidden. Loading detail does
 * not write schedule fields or claim traffic optimization.
 *
 * Run with:
 *   npm run test:native-assigned-job-maps
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for native assigned-job maps checks.");
  process.exit(generateEarly.status ?? 1);
}

const {
  FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS,
  completeStructuredRouteAddress,
  extractOwnerDayRouteMapsAddresses,
  ownerDayRouteMapsContainsAddress,
  ownerDayRouteTextHasForbiddenClaim,
} = await import("@/lib/owner-day-route");
const {
  NATIVE_ASSIGNED_JOB_FOREIGN_PROPERTY_MAPS_REASON,
  NATIVE_ASSIGNED_JOB_INCOMPLETE_MAPS_REASON,
  NATIVE_ASSIGNED_JOB_MAPS_DISCLAIMER,
  NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL,
  NATIVE_ASSIGNED_JOB_NO_PROPERTY_MAPS_REASON,
  buildNativeAssignedJobMaps,
  nativeAssignedJobDisplayAddress,
} = await import("@/lib/native-assigned-job-maps");
const { loadNativeAssignedJob, loadNativeToday } = await import("@/lib/native-field");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_native_assigned_job_maps_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native assigned-job maps test database.");
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

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function jsonBlob(value) {
  return JSON.stringify(value);
}

function containsAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(needle));
}

function makeFieldAccess({
  businessId,
  membershipId,
  userId,
  role = "MEMBER",
  name = "Worker",
}) {
  return {
    userId,
    sessionId: `session-${membershipId}`,
    viewer: {
      id: userId,
      name,
      email: `${role.toLowerCase()}@maps.example`,
      role,
    },
    workspace: {
      businessId,
      businessName: "Maps Co",
      membershipId,
      role,
    },
    businessId,
    membershipId,
  };
}

const completeProperty = {
  id: "prop-complete",
  businessId: "biz-a",
  addressLine1: "10 Maple St",
  addressLine2: "Unit 2",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
};

const libSrc = readRepo("src/lib/native-assigned-job-maps.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const todayScreenSrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const packageSrc = readRepo("package.json");
const jobRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/route.ts");
const todayRouteSrc = readRepo("src/app/api/native/v1/today/route.ts");
const uiSource = `${jobScreenSrc}\n${todayScreenSrc}`;
const featureSource = [libSrc, nativeFieldSrc, jobScreenSrc, todayScreenSrc, jobRouteSrc, todayRouteSrc].join(
  "\n",
);

console.log("\nSTATIC — assigned-job maps reuse day-route address rules");
check(
  "Maps helper reuses completeStructuredRouteAddress and day-route href builder",
  libSrc.includes('from "@/lib/owner-day-route"') &&
    libSrc.includes("completeStructuredRouteAddress") &&
    libSrc.includes("buildOwnerDayRouteMapsHref") &&
    libSrc.includes("ownedRouteDisplayAddress"),
);
check(
  "Native job select includes property.businessId for same-business checks",
  nativeFieldSrc.includes("NATIVE_JOB_PROPERTY_SELECT") &&
    nativeFieldSrc.includes("buildNativeAssignedJobMaps") &&
    nativeFieldSrc.includes("nativeAssignedJobDisplayAddress") &&
    !nativeFieldSrc.includes("directionsUrl("),
);
check(
  "Job and Today loaders stay read-only",
  nativeFieldSrc.includes("nativeAssignedJobWhere") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(nativeFieldSrc) &&
    !jobRouteSrc.includes("prisma.job.update") &&
    !todayRouteSrc.includes("prisma.job.update"),
);
check(
  "Native Job screen shows Open in maps or the unavailable reason",
  jobScreenSrc.includes("job.maps?.href") &&
    jobScreenSrc.includes("job.maps.label") &&
    jobScreenSrc.includes("job.maps.unavailableReason") &&
    jobScreenSrc.includes("job.maps.disclaimer") &&
    NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL === "Open in maps" &&
    !jobScreenSrc.includes("Directions"),
);
check(
  "Today list does not invent its own maps link",
  !todayScreenSrc.includes("maps/dir") &&
    !todayScreenSrc.includes("maps/search") &&
    !todayScreenSrc.includes("Open in maps") &&
    todayScreenSrc.includes("job.address"),
);
check(
  "Display copy does not claim traffic optimization, GIS, or automatic ETA",
  !ownerDayRouteTextHasForbiddenClaim(uiSource) &&
    !ownerDayRouteTextHasForbiddenClaim(NATIVE_ASSIGNED_JOB_MAPS_DISCLAIMER) &&
    !FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS.some((pattern) => pattern.test(featureSource)),
);
check(
  "Docs and npm script record the maps eligibility check",
  docsSrc.includes("test:native-assigned-job-maps") &&
    docsSrc.includes("Open in maps") &&
    docsSrc.includes("Foreign property fields are not returned") &&
    packageSrc.includes("test:native-assigned-job-maps"),
);

console.log("\nPURE — address eligibility");
const completeMaps = buildNativeAssignedJobMaps({
  businessId: "biz-a",
  property: completeProperty,
});
check(
  "Complete same-business structured address is maps-eligible",
  completeMaps.available === true &&
    completeMaps.href?.startsWith("https://www.google.com/maps/dir/?") === true &&
    completeMaps.href.includes("destination=") &&
    extractOwnerDayRouteMapsAddresses(completeMaps.href)[0]?.includes("10 Maple St") === true &&
    completeMaps.address?.includes("10 Maple St") === true &&
    completeMaps.unavailableReason === null &&
    completeMaps.label === NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL,
);
check(
  "Street-only one-line address is incomplete and still shown",
  (() => {
    const maps = buildNativeAssignedJobMaps({
      businessId: "biz-a",
      property: {
        id: "prop-one-line",
        businessId: "biz-a",
        addressLine1: "99 One Line Rd, Austin, TX 78701",
        city: null,
        region: null,
        postalCode: null,
      },
    });
    return (
      maps.available === false &&
      maps.href === null &&
      maps.address === "99 One Line Rd, Austin, TX 78701" &&
      maps.unavailableReason === NATIVE_ASSIGNED_JOB_INCOMPLETE_MAPS_REASON &&
      completeStructuredRouteAddress(
        {
          id: "prop-one-line",
          businessId: "biz-a",
          addressLine1: "99 One Line Rd, Austin, TX 78701",
          city: null,
          region: null,
          postalCode: null,
        },
        "biz-a",
      ).ok === false
    );
  })(),
);
check(
  "Foreign complete address is hidden and produces no maps href",
  (() => {
    const maps = buildNativeAssignedJobMaps({
      businessId: "biz-a",
      property: {
        id: "prop-b",
        businessId: "biz-b",
        addressLine1: "77 Foreign Secret Ave",
        city: "Dallas",
        region: "TX",
        postalCode: "75002",
      },
    });
    return (
      maps.available === false &&
      maps.href === null &&
      maps.address === null &&
      maps.unavailableReason === NATIVE_ASSIGNED_JOB_FOREIGN_PROPERTY_MAPS_REASON &&
      nativeAssignedJobDisplayAddress(
        {
          id: "prop-b",
          businessId: "biz-b",
          addressLine1: "77 Foreign Secret Ave",
          city: "Dallas",
          region: "TX",
          postalCode: "75002",
        },
        "biz-a",
      ) === null &&
      !jsonBlob(maps).includes("Foreign Secret")
    );
  })(),
);
check(
  "Missing property explains that a maps link is unavailable",
  (() => {
    const maps = buildNativeAssignedJobMaps({ businessId: "biz-a", property: null });
    return (
      maps.available === false &&
      maps.href === null &&
      maps.address === null &&
      maps.unavailableReason === NATIVE_ASSIGNED_JOB_NO_PROPERTY_MAPS_REASON
    );
  })(),
);

try {
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
      name: "Alpha Native Maps",
      slug: `alpha-native-maps-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Maps",
      slug: `beta-native-maps-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      ...completedOnboarding,
    },
  });

  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Maps",
      email: `mia-${randomUUID()}@native-maps.example`,
      passwordHash: "unused",
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-maps.example`,
      passwordHash: "unused",
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-maps.example`,
      passwordHash: "unused",
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

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Pat Assigned", phone: "555-0100" },
  });
  const customerOther = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Other Worker", phone: "555-0101" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret", phone: "555-0199" },
  });

  const completeOwned = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Maple St",
      addressLine2: "Unit 2",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
  });
  const incompleteOwned = await prisma.property.create({
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
  const betaOwned = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      addressLine1: "500 Oak Blvd",
      city: "Dallas",
      region: "TX",
      postalCode: "75001",
    },
  });

  const scheduledAt = new Date("2026-09-28T14:00:00.000Z");
  async function createJob(input) {
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        propertyId: input.propertyId ?? null,
        assignedMembershipId: input.assignedMembershipId ?? null,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: input.scheduledAt ?? scheduledAt,
        scheduledDurationMinutes: 60,
      },
    });
  }

  const completeJob = await createJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: completeOwned.id,
    assignedMembershipId: memberMem.id,
  });
  const incompleteJob = await createJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: incompleteOwned.id,
    assignedMembershipId: memberMem.id,
    scheduledAt: new Date("2026-09-29T14:00:00.000Z"),
  });
  const foreignAttachedJob = await createJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: foreignProperty.id,
    assignedMembershipId: memberMem.id,
    scheduledAt: new Date("2026-09-30T14:00:00.000Z"),
  });
  const noPropertyJob = await createJob({
    businessId: businessA.id,
    customerId: customerA.id,
    assignedMembershipId: memberMem.id,
    scheduledAt: new Date("2026-10-01T14:00:00.000Z"),
  });
  const otherJob = await createJob({
    businessId: businessA.id,
    customerId: customerOther.id,
    propertyId: completeOwned.id,
    assignedMembershipId: otherMem.id,
  });
  const betaJob = await createJob({
    businessId: businessB.id,
    customerId: customerB.id,
    propertyId: betaOwned.id,
    assignedMembershipId: betaMem.id,
  });

  const memberAccess = makeFieldAccess({
    businessId: businessA.id,
    membershipId: memberMem.id,
    userId: memberUser.id,
    name: "Mia Maps",
  });
  const otherAccess = makeFieldAccess({
    businessId: businessA.id,
    membershipId: otherMem.id,
    userId: otherUser.id,
    name: "Max Other",
  });
  const betaAccess = makeFieldAccess({
    businessId: businessB.id,
    membershipId: betaMem.id,
    userId: betaUser.id,
    name: "Bree Beta",
    role: "MEMBER",
  });

  console.log("\nTEST — assignment, tenant isolation, and address eligibility");
  const completeBefore = await prisma.job.findFirst({
    where: { id: completeJob.id },
    select: { scheduledAt: true, status: true, assignedMembershipId: true, updatedAt: true },
  });
  const completeDetail = await loadNativeAssignedJob(prisma, memberAccess, completeJob.id);
  const completeAfter = await prisma.job.findFirst({
    where: { id: completeJob.id },
    select: { scheduledAt: true, status: true, assignedMembershipId: true, updatedAt: true },
  });
  check("Assigned complete job detail loads", Boolean(completeDetail));
  check(
    "Complete assigned job gets a maps destination href from the recorded address",
    completeDetail?.maps.available === true &&
      completeDetail.maps.href?.startsWith("https://www.google.com/maps/dir/?") === true &&
      ownerDayRouteMapsContainsAddress(completeDetail.maps.href, "10 Maple St") &&
      completeDetail.address?.includes("10 Maple St") === true &&
      completeDetail.directionsHref === completeDetail.maps.href &&
      completeDetail.maps.label === NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL,
  );
  check(
    "Loading assigned job detail does not change the schedule or assignment",
    completeBefore?.scheduledAt?.toISOString() === completeAfter?.scheduledAt?.toISOString() &&
      completeBefore?.status === completeAfter?.status &&
      completeBefore?.assignedMembershipId === completeAfter?.assignedMembershipId &&
      completeBefore?.updatedAt?.toISOString() === completeAfter?.updatedAt?.toISOString(),
  );

  const incompleteDetail = await loadNativeAssignedJob(prisma, memberAccess, incompleteJob.id);
  check(
    "Incomplete assigned address is shown and explains why maps is unavailable",
    incompleteDetail?.maps.available === false &&
      incompleteDetail.maps.href === null &&
      incompleteDetail.directionsHref === null &&
      incompleteDetail.address === "12 Partial Row" &&
      incompleteDetail.maps.address === "12 Partial Row" &&
      incompleteDetail.maps.unavailableReason === NATIVE_ASSIGNED_JOB_INCOMPLETE_MAPS_REASON,
  );

  const foreignDetail = await loadNativeAssignedJob(prisma, memberAccess, foreignAttachedJob.id);
  const foreignJson = jsonBlob(foreignDetail);
  check(
    "Foreign property data is not exposed on the assigned job",
    foreignDetail?.maps.available === false &&
      foreignDetail.maps.href === null &&
      foreignDetail.address === null &&
      foreignDetail.maps.address === null &&
      foreignDetail.maps.unavailableReason === NATIVE_ASSIGNED_JOB_FOREIGN_PROPERTY_MAPS_REASON &&
      !containsAny(foreignJson, ["77 Foreign Secret Ave", "Dallas", "75002", "Foreign Secret"]),
  );

  const noPropertyDetail = await loadNativeAssignedJob(prisma, memberAccess, noPropertyJob.id);
  check(
    "Assigned job with no property has no maps link and says why",
    noPropertyDetail?.maps.available === false &&
      noPropertyDetail.maps.href === null &&
      noPropertyDetail.address === null &&
      noPropertyDetail.maps.unavailableReason === NATIVE_ASSIGNED_JOB_NO_PROPERTY_MAPS_REASON,
  );

  const otherDetail = await loadNativeAssignedJob(prisma, memberAccess, otherJob.id);
  const betaDetail = await loadNativeAssignedJob(prisma, memberAccess, betaJob.id);
  const crossAssignment = await loadNativeAssignedJob(prisma, otherAccess, completeJob.id);
  const crossTenant = await loadNativeAssignedJob(prisma, betaAccess, completeJob.id);
  check("Other worker's job is not available", otherDetail === null);
  check("Cross-tenant job is not available", betaDetail === null);
  check("Another worker cannot load this assigned job", crossAssignment === null);
  check("Another business cannot load this assigned job", crossTenant === null);

  const today = await loadNativeToday(prisma, memberAccess, {
    now: new Date("2026-09-28T15:00:00.000Z"),
  });
  const todayRows = [...today.today, ...today.upcoming, ...today.completed];
  const todayJson = jsonBlob(today);
  const todayComplete = todayRows.find((job) => job.id === completeJob.id);
  const todayIncomplete = todayRows.find((job) => job.id === incompleteJob.id);
  const todayForeign = todayRows.find((job) => job.id === foreignAttachedJob.id);
  check(
    "Today lists only the caller's assigned jobs",
    todayRows.some((job) => job.id === completeJob.id) &&
      todayRows.some((job) => job.id === incompleteJob.id) &&
      todayRows.some((job) => job.id === foreignAttachedJob.id) &&
      todayRows.some((job) => job.id === noPropertyJob.id) &&
      !todayRows.some((job) => job.id === otherJob.id) &&
      !todayRows.some((job) => job.id === betaJob.id),
  );
  check(
    "Today shows the complete and incomplete same-business addresses",
    todayComplete?.address?.includes("10 Maple St") === true &&
      todayIncomplete?.address === "12 Partial Row",
  );
  check(
    "Today does not leak the foreign property address",
    todayForeign?.address === null &&
      !containsAny(todayJson, ["77 Foreign Secret Ave", "500 Oak Blvd", "Beta Secret"]),
  );

  const otherToday = await loadNativeToday(prisma, otherAccess, {
    now: new Date("2026-09-28T15:00:00.000Z"),
  });
  const otherTodayIds = [...otherToday.today, ...otherToday.upcoming, ...otherToday.completed].map(
    (job) => job.id,
  );
  check(
    "Other worker Today stays assignment-scoped",
    otherTodayIds.includes(otherJob.id) && !otherTodayIds.includes(completeJob.id),
  );

  if (failures > 0) {
    throw new Error(`Native assigned-job maps check failed (${failures} case(s)).`);
  }
  console.log(
    "\nNative assigned-job maps check passed: assignment isolation, tenant isolation, and address eligibility held.",
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
