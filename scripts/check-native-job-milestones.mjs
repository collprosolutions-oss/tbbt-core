/**
 * Native assigned-job milestone reads — OWNER-recorded list on the
 * assigned Job screen only. Completion stays the existing OWNER action.
 *
 * Proves assignment + tenant isolation, reassignment, inactive
 * membership, Open/Completed labels with recorded dates, and the
 * read bound on a dedicated local disposable database.
 *
 * Run with:
 *   npm run test:native-job-milestones
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { ForbiddenError } = await import("@/lib/authorization");
const { formatDateTime } = await import("@/lib/format");
const {
  JOB_MILESTONE_STATUS_LABELS,
  MAX_JOB_MILESTONES,
  milestoneTitleKey,
} = await import("@/lib/job-milestones");
const { completeJobMilestone, recordJobMilestones } = await import(
  "@/lib/job-milestone-ops"
);
const { loadNativeAssignedJob, nativeAssignedJobWhere } = await import(
  "@/lib/native-field"
);
const {
  NATIVE_JOB_MILESTONE_LIMIT,
  NATIVE_JOB_MILESTONE_STATUS_LABELS,
  boundNativeJobMilestones,
  emptyNativeJobMilestones,
  loadNativeAssignedJobMilestones,
  nativeAssignedJobMilestoneAuthorizeWhere,
  nativeAssignedJobMilestoneWhere,
  nativeJobMilestoneTruncatedNotice,
  toNativeJobMilestone,
} = await import("@/lib/native-field-milestones");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);

const NY = "America/New_York";
const HIDDEN_TITLE = "Hidden materials ordered";
const OPEN_TITLE = "Site prep";
const COMPLETED_TITLE = "Install";
const FOREIGN_TITLE = "Beta tenant milestone";
const OTHER_JOB_TITLE = "Other worker milestone";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

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

function makeOwnerAccess(businessId, membershipId) {
  return {
    businessId,
    workspace: {
      role: "OWNER",
      membership: { id: membershipId },
      business: { id: businessId, name: "Native Milestone Tenant" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function makeMemberAccess(businessId, membershipId) {
  return {
    ...makeOwnerAccess(businessId, membershipId),
    workspace: {
      role: "MEMBER",
      membership: { id: membershipId },
      business: { id: businessId, name: "Native Milestone Tenant" },
    },
  };
}

const milestoneLibSrc = readRepo("src/lib/job-milestones.ts");
const milestoneOpsSrc = readRepo("src/lib/job-milestone-ops.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const nativeMilestoneSrc = readRepo("src/lib/native-field-milestones.ts");
const jobRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const milestoneScreenSrc = readRepo("apps/native/src/screens/JobMilestonesSection.tsx");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const appSrc = readRepo("apps/native/App.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const packageSrc = readRepo("package.json");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const selfSrc = readRepo("scripts/check-native-job-milestones.mjs");

console.log("\nSTATIC — inspect merged milestones and assigned-job API first");
check(
  "Merged OWNER milestone writes stay OWNER-only and never infer completion",
  milestoneLibSrc.includes("assertCanManageJobMilestones") &&
    milestoneLibSrc.includes('requireBusinessRole(access, "OWNER")') &&
    milestoneLibSrc.includes("resolveRecordedMilestoneStatus") &&
    milestoneOpsSrc.includes("completeJobMilestone") &&
    milestoneOpsSrc.includes("never writes Job.status") &&
    !milestoneOpsSrc.includes("mail") &&
    !milestoneOpsSrc.includes("sendSms"),
);
check(
  "Assigned-job GET still authorizes then loads one assigned job",
  jobRouteSrc.includes("resolveNativeFieldAccess") &&
    jobRouteSrc.includes("loadNativeAssignedJob") &&
    jobRouteSrc.includes("export async function GET") &&
    !jobRouteSrc.includes("export async function POST") &&
    !jobRouteSrc.includes("completeJobMilestone") &&
    !jobRouteSrc.includes("recordJobMilestones"),
);
check(
  "Native milestone read re-authorizes with businessId + assignedMembershipId",
  nativeMilestoneSrc.includes("nativeAssignedJobMilestoneAuthorizeWhere") &&
    nativeMilestoneSrc.includes("assignedMembershipId: field.membershipId") &&
    nativeMilestoneSrc.includes("nativeAssignedJobMilestoneWhere") &&
    nativeMilestoneSrc.includes("where: { jobId, businessId }") &&
    nativeFieldSrc.includes("loadNativeAssignedJobMilestones") &&
    nativeFieldSrc.includes("nativeAssignedJobWhere"),
);
check(
  "Every milestone query is bounded and uses Open/Completed wording",
  NATIVE_JOB_MILESTONE_LIMIT === MAX_JOB_MILESTONES &&
    nativeMilestoneSrc.includes("take: NATIVE_JOB_MILESTONE_LIMIT + 1") &&
    NATIVE_JOB_MILESTONE_STATUS_LABELS.OPEN === "Open" &&
    NATIVE_JOB_MILESTONE_STATUS_LABELS.COMPLETED === "Completed" &&
    JOB_MILESTONE_STATUS_LABELS.OPEN === "Not yet marked complete" &&
    nativeMilestoneSrc.includes("resolveRecordedMilestoneStatus") &&
    !nativeMilestoneSrc.includes("Not yet marked complete"),
);
check(
  "Native milestone module is read-only and sends no messages",
  !/\bjobMilestone\.(create|update|updateMany|delete|deleteMany)\b/.test(
    nativeMilestoneSrc,
  ) &&
    !nativeMilestoneSrc.includes("completeJobMilestone") &&
    !nativeMilestoneSrc.includes("recordJobMilestones") &&
    !/mail|sendSms|notifyCustomer|resend/i.test(nativeMilestoneSrc) &&
    nativeMilestoneSrc.includes("never writes milestones"),
);
check(
  "Job screen reloads assigned job on open and shows read-only Open/Completed dates",
  jobScreenSrc.includes("void loadNativeJob(token, jobId)") &&
    jobScreenSrc.includes("JobMilestonesSection") &&
    jobScreenSrc.includes("job.milestones") &&
    !jobScreenSrc.includes("Mark complete") &&
    milestoneScreenSrc.includes("Open") === false &&
    milestoneScreenSrc.includes("milestone.statusLabel") &&
    milestoneScreenSrc.includes("Recorded ${milestone.recordedAtLabel}") &&
    milestoneScreenSrc.includes("Completed ${milestone.completedAtLabel}") &&
    milestoneScreenSrc.includes("Only the owner can mark milestones complete.") &&
    !milestoneScreenSrc.includes("Mark complete") &&
    !milestoneScreenSrc.includes("completeNative") &&
    nativeTypesSrc.includes("NativeJobMilestones") &&
    nativeTypesSrc.includes('status: "OPEN" | "COMPLETED"'),
);
check(
  "No native milestone write route, global nav item, or website navigation change",
  !existsSync(
      fileURLToPath(new URL("../src/app/api/native/v1/jobs/[jobId]/milestones", import.meta.url)),
    ) &&
    !jobRouteSrc.includes("completeJobMilestone") &&
    !navSrc.includes("milestone") &&
    !appSrc.includes("Milestone") &&
    appSrc.includes("JobScreen") &&
    packageSrc.includes("test:native-job-milestones") &&
    docsSrc.includes("test:native-job-milestones") &&
    docsSrc.includes("read-only") &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('namePrefix: "tbbt_native_job_milestones"'),
);
check(
  "boundNativeJobMilestones keeps the cap and marks overflow",
  boundNativeJobMilestones(["a", "b", "c"], 2).truncated === true &&
    boundNativeJobMilestones(["a", "b", "c"], 2).items.join(",") === "a,b" &&
    boundNativeJobMilestones(["a", "b"], 2).truncated === false,
);
check(
  "Authorize where matches nativeAssignedJobWhere(businessId + assignedMembershipId)",
  JSON.stringify(
    nativeAssignedJobMilestoneAuthorizeWhere("job-1", {
      businessId: "biz-1",
      membershipId: "mem-1",
    }),
  ) ===
    JSON.stringify(
      nativeAssignedJobWhere("job-1", { businessId: "biz-1", membershipId: "mem-1" }),
    ) &&
    JSON.stringify(nativeAssignedJobMilestoneWhere("job-1", "biz-1")) ===
      JSON.stringify({ jobId: "job-1", businessId: "biz-1" }),
);

const completedLabel = toNativeJobMilestone(
  {
    id: "ms-1",
    title: COMPLETED_TITLE,
    sortOrder: 2,
    status: "COMPLETED",
    createdAt: new Date("2026-09-30T14:00:00.000Z"),
    completedAt: new Date("2026-10-01T18:00:00.000Z"),
  },
  NY,
);
const openLabel = toNativeJobMilestone(
  {
    id: "ms-2",
    title: OPEN_TITLE,
    sortOrder: 1,
    status: "OPEN",
    createdAt: new Date("2026-09-29T13:00:00.000Z"),
    completedAt: null,
  },
  NY,
);
const inferredOpen = toNativeJobMilestone(
  {
    id: "ms-3",
    title: "Job already done",
    sortOrder: 3,
    status: "OPEN",
    createdAt: new Date("2026-09-28T13:00:00.000Z"),
    completedAt: null,
  },
  NY,
);
check(
  "Mapper uses Open/Completed labels and recorded dates",
  completedLabel.statusLabel === "Completed" &&
    completedLabel.completedAtLabel ===
      formatDateTime(new Date("2026-10-01T18:00:00.000Z"), NY) &&
    openLabel.statusLabel === "Open" &&
    openLabel.recordedAtLabel ===
      formatDateTime(new Date("2026-09-29T13:00:00.000Z"), NY) &&
    openLabel.completedAtLabel === null &&
    inferredOpen.statusLabel === "Open",
);

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_native_job_milestones",
  pushSchema: true,
});
const prisma = session.prisma;

try {
  const password = "native-milestone-pass-9";
  const passwordHash = await hashPassword(password);
  const onboarding = {
    firstRunSetupCompletedAt: new Date(),
    starterServicesSetupCompletedAt: new Date(),
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: new Date(),
    websiteSetupChoice: "SKIPPED",
  };

  async function makeBusiness(name, slug) {
    return prisma.business.create({
      data: {
        name,
        slug,
        tradeCode: "HANDYMAN",
        timezone: NY,
        ...onboarding,
      },
    });
  }

  async function makeUser(name, email, extras = {}) {
    return prisma.user.create({
      data: { name, email, passwordHash, ...extras },
    });
  }

  async function makeMembership(userId, businessId, role, extras = {}) {
    return prisma.membership.create({
      data: { userId, businessId, role, ...extras },
    });
  }

  async function makeJob(businessId, extras = {}) {
    return prisma.job.create({
      data: {
        businessId,
        projectToken: extras.projectToken ?? randomUUID(),
        status: extras.status ?? "SCHEDULED",
        assignedMembershipId: extras.assignedMembershipId ?? null,
        customerId: extras.customerId ?? null,
      },
    });
  }

  const businessA = await makeBusiness("Alpha Milestones", "alpha-native-milestones");
  const businessB = await makeBusiness("Beta Milestones", "beta-native-milestones");

  const ownerUser = await makeUser("Olivia Owner", "owner@native-milestones.example");
  const memberUser = await makeUser("Mia Member", "member@native-milestones.example");
  const otherUser = await makeUser("Max Member", "other@native-milestones.example");
  const inactiveUser = await makeUser("Ivy Inactive", "inactive@native-milestones.example");
  const laterInactiveUser = await makeUser(
    "Leo Later",
    "later-inactive@native-milestones.example",
  );
  const betaUser = await makeUser("Bree Beta", "bree@beta-native-milestones.example");

  const ownerMembership = await makeMembership(ownerUser.id, businessA.id, "OWNER");
  const memberMembership = await makeMembership(memberUser.id, businessA.id, "MEMBER");
  const otherMembership = await makeMembership(otherUser.id, businessA.id, "MEMBER");
  await makeMembership(inactiveUser.id, businessA.id, "MEMBER", { active: false });
  const laterInactiveMembership = await makeMembership(
    laterInactiveUser.id,
    businessA.id,
    "MEMBER",
  );
  const betaMembership = await makeMembership(betaUser.id, businessB.id, "MEMBER");

  const assignedJob = await makeJob(businessA.id, {
    assignedMembershipId: memberMembership.id,
    status: "COMPLETED",
  });
  const unassignedJob = await makeJob(businessA.id);
  const otherJob = await makeJob(businessA.id, {
    assignedMembershipId: otherMembership.id,
  });
  const betaJob = await makeJob(businessB.id, {
    assignedMembershipId: betaMembership.id,
  });

  const ownerAccess = makeOwnerAccess(businessA.id, ownerMembership.id);
  const memberWriteAccess = makeMemberAccess(businessA.id, memberMembership.id);
  const recorded = await recordJobMilestones(prisma, ownerAccess, {
    jobId: assignedJob.id,
    items: [
      { title: HIDDEN_TITLE, customerVisible: false },
      { title: OPEN_TITLE, customerVisible: true },
      { title: COMPLETED_TITLE, customerVisible: true },
    ],
  });
  const completed = await completeJobMilestone(
    prisma,
    ownerAccess,
    recorded.milestones[2].id,
  );
  await recordJobMilestones(prisma, ownerAccess, {
    jobId: otherJob.id,
    items: [{ title: OTHER_JOB_TITLE }],
  });
  const betaOwnerUser = await makeUser("Bea Owner", "owner@beta-native-milestones.example");
  const betaOwnerMembership = await makeMembership(betaOwnerUser.id, businessB.id, "OWNER");
  await recordJobMilestones(prisma, makeOwnerAccess(businessB.id, betaOwnerMembership.id), {
    jobId: betaJob.id,
    items: [{ title: FOREIGN_TITLE, customerVisible: true }],
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  check("Assigned MEMBER can sign in", memberSignIn.ok === true);
  const memberResolved = memberSignIn.ok
    ? await resolveNativeFieldAccess(prisma, { token: memberSignIn.token })
    : { ok: false };
  check("Assigned MEMBER bearer resolves", memberResolved.ok === true);
  const memberAccess = memberResolved.ok ? memberResolved.access : null;

  console.log("\nDEDICATED DB — assigned worker labels and recorded dates");
  const detail = memberAccess
    ? await loadNativeAssignedJob(prisma, memberAccess, assignedJob.id)
    : null;
  const titles = detail?.milestones.items.map((row) => row.title) ?? [];
  const byTitle = Object.fromEntries(
    (detail?.milestones.items ?? []).map((row) => [row.title, row]),
  );
  check("Assigned job detail includes recorded milestones", Boolean(detail?.milestones));
  check(
    "Assigned worker sees hidden, open, and completed owner-recorded rows in order",
    titles.join("|") === `${HIDDEN_TITLE}|${OPEN_TITLE}|${COMPLETED_TITLE}` &&
      detail?.milestones.count === 3 &&
      detail?.milestones.truncated === false,
  );
  check(
    "Open milestone uses Open wording and the recorded date",
    byTitle[OPEN_TITLE]?.status === "OPEN" &&
      byTitle[OPEN_TITLE]?.statusLabel === "Open" &&
      byTitle[OPEN_TITLE]?.recordedAtLabel ===
        formatDateTime(new Date(byTitle[OPEN_TITLE].recordedAt), NY) &&
      byTitle[OPEN_TITLE]?.completedAtLabel === null,
  );
  check(
    "Completed milestone uses Completed wording and the recorded completed date",
    byTitle[COMPLETED_TITLE]?.status === "COMPLETED" &&
      byTitle[COMPLETED_TITLE]?.statusLabel === "Completed" &&
      byTitle[COMPLETED_TITLE]?.completedAtLabel ===
        formatDateTime(completed.milestone.completedAt, NY) &&
      byTitle[HIDDEN_TITLE]?.statusLabel === "Open",
  );
  check(
    "Completed Job status does not infer milestone completion",
    assignedJob.status === "COMPLETED" &&
      byTitle[OPEN_TITLE]?.status === "OPEN" &&
      byTitle[HIDDEN_TITLE]?.status === "OPEN",
  );
  check(
    "Customer-hidden milestone is still visible to the assigned worker",
    recorded.milestones[0].customerVisible === false &&
      titles.includes(HIDDEN_TITLE),
  );
  check(
    "Payload stays on this assigned job and omits other titles",
    !titles.includes(OTHER_JOB_TITLE) && !titles.includes(FOREIGN_TITLE),
  );

  console.log("\nDEDICATED DB — authorization, tenant isolation, reassignment");
  const unassignedDetail = memberAccess
    ? await loadNativeAssignedJob(prisma, memberAccess, unassignedJob.id)
    : { id: "unexpected" };
  const otherDetail = memberAccess
    ? await loadNativeAssignedJob(prisma, memberAccess, otherJob.id)
    : { id: "unexpected" };
  const betaDetail = memberAccess
    ? await loadNativeAssignedJob(prisma, memberAccess, betaJob.id)
    : { id: "unexpected" };
  check("Unassigned job is not available", unassignedDetail === null);
  check("Other worker's job is not available", otherDetail === null);
  check("Other-tenant job is not available", betaDetail === null);

  const leakedUnassigned = memberAccess
    ? await loadNativeAssignedJobMilestones(
        prisma,
        memberAccess,
        unassignedJob.id,
        NY,
      )
    : emptyNativeJobMilestones();
  const leakedOther = memberAccess
    ? await loadNativeAssignedJobMilestones(prisma, memberAccess, otherJob.id, NY)
    : emptyNativeJobMilestones();
  const leakedBeta = memberAccess
    ? await loadNativeAssignedJobMilestones(prisma, memberAccess, betaJob.id, NY)
    : emptyNativeJobMilestones();
  check(
    "Unassigned, other-worker, and other-tenant milestone reads stay empty",
    leakedUnassigned.items.length === 0 &&
      leakedOther.items.length === 0 &&
      leakedBeta.items.length === 0 &&
      !leakedOther.items.some((row) => row.title === OTHER_JOB_TITLE) &&
      !leakedBeta.items.some((row) => row.title === FOREIGN_TITLE),
  );

  await prisma.job.update({
    where: { id: assignedJob.id },
    data: { assignedMembershipId: otherMembership.id },
  });
  const formerAfterReassign = memberAccess
    ? await loadNativeAssignedJob(prisma, memberAccess, assignedJob.id)
    : { id: "unexpected" };
  const formerMilestones = memberAccess
    ? await loadNativeAssignedJobMilestones(
        prisma,
        memberAccess,
        assignedJob.id,
        NY,
      )
    : emptyNativeJobMilestones();
  check("Reassigned former worker cannot load the job", formerAfterReassign === null);
  check(
    "Reassigned former worker cannot see the recorded milestones",
    formerMilestones.items.length === 0 &&
      !formerMilestones.items.some((row) => row.title === COMPLETED_TITLE),
  );

  const otherSignIn = await signInNativeField(prisma, {
    email: otherUser.email,
    password,
  });
  const otherResolved = otherSignIn.ok
    ? await resolveNativeFieldAccess(prisma, { token: otherSignIn.token })
    : { ok: false };
  const newAssigneeDetail =
    otherResolved.ok
      ? await loadNativeAssignedJob(prisma, otherResolved.access, assignedJob.id)
      : null;
  check(
    "New assignee sees the same recorded Open/Completed milestones",
    newAssigneeDetail?.milestones.items.map((row) => row.title).join("|") ===
      `${HIDDEN_TITLE}|${OPEN_TITLE}|${COMPLETED_TITLE}` &&
      newAssigneeDetail?.milestones.items.find((row) => row.title === COMPLETED_TITLE)
        ?.statusLabel === "Completed",
  );

  const inactiveSignIn = await signInNativeField(prisma, {
    email: inactiveUser.email,
    password,
  });
  check(
    "Inactive membership cannot sign in to the field API",
    inactiveSignIn.ok === false &&
      String(inactiveSignIn.error).includes("not assigned"),
  );

  const laterSignIn = await signInNativeField(prisma, {
    email: laterInactiveUser.email,
    password,
  });
  check("Later-inactive worker can sign in while active", laterSignIn.ok === true);
  if (laterSignIn.ok) {
    await prisma.membership.update({
      where: { id: laterInactiveMembership.id },
      data: { active: false },
    });
    const laterResolved = await resolveNativeFieldAccess(prisma, {
      token: laterSignIn.token,
    });
    check(
      "Deactivated membership cannot resolve assigned-job access",
      laterResolved.ok === false && laterResolved.status === 403,
    );
    check(
      "Inactive worker never reaches the assigned-job milestone read",
      laterResolved.ok === false,
    );
  } else {
    check("Deactivated membership cannot resolve assigned-job access", false);
    check("Inactive worker never reaches the assigned-job milestone read", false);
  }

  try {
    await completeJobMilestone(prisma, memberWriteAccess, recorded.milestones[1].id);
    check("Assigned MEMBER cannot complete a milestone", false);
  } catch (error) {
    check(
      "Assigned MEMBER cannot complete a milestone",
      error instanceof ForbiddenError,
    );
  }

  console.log("\nDEDICATED DB — bound list on the assigned job");
  await prisma.job.update({
    where: { id: assignedJob.id },
    data: { assignedMembershipId: memberMembership.id },
  });
  for (let index = 0; index < 8; index += 1) {
    const title = `Overflow ${index + 4}`;
    await prisma.jobMilestone.create({
      data: {
        businessId: businessA.id,
        jobId: assignedJob.id,
        title,
        titleKey: milestoneTitleKey(title),
        sortOrder: 3 + index,
        status: "OPEN",
      },
    });
  }
  const bounded = memberAccess
    ? await loadNativeAssignedJobMilestones(
        prisma,
        memberAccess,
        assignedJob.id,
        NY,
      )
    : emptyNativeJobMilestones();
  check(
    "Assigned milestone list is capped at NATIVE_JOB_MILESTONE_LIMIT",
    bounded.items.length === NATIVE_JOB_MILESTONE_LIMIT &&
      bounded.truncated === true &&
      bounded.limit === NATIVE_JOB_MILESTONE_LIMIT &&
      bounded.count > NATIVE_JOB_MILESTONE_LIMIT &&
      bounded.truncatedNotice === nativeJobMilestoneTruncatedNotice() &&
      bounded.items[0].title === HIDDEN_TITLE &&
      !bounded.items.some((row) => row.title === "Overflow 11"),
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected native job milestone test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nNative job milestone check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll native job milestone checks passed.");
