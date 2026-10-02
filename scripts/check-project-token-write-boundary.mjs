/**
 * Final write-boundary proofs for customer projectToken mutations.
 *
 * Change-order approve, additional-work submit, and document finalize
 * each lock the Job and re-check the live token inside the write
 * transaction. Two Prisma connections race rotate against each write
 * in both commit orders.
 *
 * Dedicated local disposable database (name prefix tbbt_token_write).
 *
 * Run with:
 *   npm run test:project-token-write-boundary
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  additionalWorkRequestTestHooks,
  createCustomerAdditionalWorkRequest,
} = await import("@/lib/additional-work-request");
const {
  MemoryStorageProvider,
  StorageAccessError,
  authorizeProjectTokenDocument,
  finalizeProjectTokenDocument,
  projectDocumentTestHooks,
} = await import("@/lib/business-storage/index");
const { JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE } = await import(
  "@/lib/project-link"
);
const {
  approveCustomerChangeOrder,
  CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR,
  publicChangeOrderTestHooks,
} = await import("@/lib/public-change-order-ops");
const { jobProjectLinkTestHooks, rotateJobProjectLink } = await import(
  "@/lib/project-link-ops"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the project-token write-boundary check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "project-token write-boundary dedicated local database");

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

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Token Write Co" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const changeOrderOpsSrc = read("src/lib/public-change-order-ops.ts");
const additionalWorkSrc = read("src/lib/additional-work-request.ts");
const documentSrc = read("src/lib/business-storage/project-documents.ts");
const changeOrderActionSrc = read("src/app/actions/public-change-order.ts");
const finalizeFnSrc = documentSrc.slice(
  documentSrc.indexOf("export async function finalizeProjectTokenDocument"),
);

console.log("\nSTATIC — each final write locks the Job then re-checks the live token");
check(
  "Change-order approve locks then re-checks before updateMany",
  changeOrderOpsSrc.includes("lockTenantOwnedJob") &&
    changeOrderOpsSrc.includes("assertLiveLockedProjectToken") &&
    changeOrderOpsSrc.includes("afterJobLock") &&
    changeOrderOpsSrc.indexOf("await lockTenantOwnedJob") <
      changeOrderOpsSrc.indexOf("assertLiveLockedProjectToken(tx") &&
    changeOrderOpsSrc.indexOf("assertLiveLockedProjectToken(tx") <
      changeOrderOpsSrc.indexOf("changeOrder.updateMany") &&
    changeOrderActionSrc.includes("approveCustomerChangeOrder"),
);
check(
  "Additional-work submit locks then re-checks before create",
  additionalWorkSrc.includes("lockTenantOwnedJob") &&
    additionalWorkSrc.includes("assertLiveLockedProjectToken") &&
    additionalWorkSrc.includes("afterJobLock") &&
    additionalWorkSrc.indexOf("await lockTenantOwnedJob") <
      additionalWorkSrc.indexOf("assertLiveLockedProjectToken(tx") &&
    additionalWorkSrc.indexOf("assertLiveLockedProjectToken(tx") <
      additionalWorkSrc.indexOf("additionalWorkRequest.create"),
);
check(
  "Document finalize locks then re-checks inside beforeClaim",
  finalizeFnSrc.includes("lockJobForProjectDocument") &&
    finalizeFnSrc.includes("assertLiveLockedProjectToken") &&
    finalizeFnSrc.includes('phase: "finalize"') &&
    finalizeFnSrc.indexOf("lockJobForProjectDocument") <
      finalizeFnSrc.indexOf("assertLiveLockedProjectToken") &&
    finalizeFnSrc.indexOf("beforeClaim") <
      finalizeFnSrc.indexOf("lockJobForProjectDocument"),
);

const pdfBytes = Buffer.from("%PDF-1.4 token-write\n%%EOF\n");

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_token_write",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_token_write_")),
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-tw-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-tw-${suffix}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Token Write", slug: `alpha-tw-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Token Write", slug: `beta-tw-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerUser.id);

  async function createJob(businessId, token) {
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: "Portal Customer",
        email: `cust-${randomUUID().slice(0, 6)}@example.com`,
      },
    });
    return prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        status: "SCHEDULED",
        projectToken: token,
      },
    });
  }

  async function createSentChangeOrder(job, title) {
    return prisma.changeOrder.create({
      data: {
        businessId: job.businessId,
        jobId: job.id,
        title,
        status: "SENT",
        total: 40,
        sentAt: new Date(),
      },
    });
  }

  const provider = new MemoryStorageProvider();
  function storageDeps(db) {
    return {
      db,
      provider,
      bucketName: "tbbt-token-write-docs",
      defaultLimitBytes: 50 * 1024 * 1024,
    };
  }

  async function authorizePendingDocument(db, token, filename) {
    const deps = storageDeps(db);
    const authorized = await authorizeProjectTokenDocument(deps, token, {
      originalFilename: filename,
      mimeType: "application/pdf",
      fileSizeBytes: pdfBytes.byteLength,
    });
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: pdfBytes,
      contentType: "application/pdf",
    });
    return authorized.asset;
  }

  async function waitForLockWaiter(admin, ms, label) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const waiting = await admin.$queryRaw`
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = ${session.testDbName}
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      if (waiting.length > 0) return waiting;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${label} timed out waiting for wait_event_type=Lock`);
  }

  async function holdThenRace({
    installHold,
    startHeld,
    startContender,
    label,
  }) {
    let release = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let signalArrived = () => undefined;
    const arrived = new Promise((resolve) => {
      signalArrived = resolve;
    });
    installHold(async () => {
      signalArrived();
      await held;
    });
    const admin = session.createClient();
    let heldPromise;
    let contenderPromise;
    try {
      heldPromise = startHeld();
      await withTimeout(arrived, 8000, `${label} holder afterJobLock`);
      contenderPromise = startContender();
      await waitForLockWaiter(admin, 8000, `${label} contender`);
    } finally {
      release();
      await admin.$disconnect().catch(() => undefined);
    }
    if (!heldPromise || !contenderPromise) {
      throw new Error(`${label} did not start both connections`);
    }
    return withTimeout(
      Promise.allSettled([heldPromise, contenderPromise]),
      8000,
      `${label} both finish`,
    );
  }

  function clearWriteHooks() {
    jobProjectLinkTestHooks.afterJobLock = undefined;
    publicChangeOrderTestHooks.afterJobLock = undefined;
    additionalWorkRequestTestHooks.afterJobLock = undefined;
    projectDocumentTestHooks.afterJobLock = undefined;
  }

  console.log("\nCURRENT TOKEN — valid writes still commit");
  const liveJob = await createJob(businessA.id, `live-${suffix}`);
  const liveChange = await createSentChangeOrder(liveJob, "Live extra outlet");
  const liveApprove = await approveCustomerChangeOrder(prisma, {
    token: liveJob.projectToken,
    changeOrderId: liveChange.id,
  });
  const liveAfter = await prisma.changeOrder.findUnique({
    where: { id: liveChange.id },
    select: { status: true, jobId: true, businessId: true },
  });
  check(
    "Current token approves a SENT change order",
    liveApprove.status === "APPROVED" &&
      liveAfter?.status === "APPROVED" &&
      liveAfter.jobId === liveJob.id &&
      liveAfter.businessId === businessA.id,
  );

  const liveWork = await createCustomerAdditionalWorkRequest(prisma, {
    token: liveJob.projectToken,
    notes: "Please also check the hallway switch.",
  });
  const liveWorkRow = liveWork.ok
    ? await prisma.additionalWorkRequest.findFirst({
        where: { id: liveWork.requestId, jobId: liveJob.id, businessId: businessA.id },
      })
    : null;
  check(
    "Current token submits additional work on the same job",
    liveWork.ok === true &&
      liveWork.jobId === liveJob.id &&
      liveWorkRow?.source === "CUSTOMER",
  );

  const livePending = await authorizePendingDocument(
    prisma,
    liveJob.projectToken,
    "live-permit.pdf",
  );
  const liveFinal = await finalizeProjectTokenDocument(
    storageDeps(prisma),
    liveJob.projectToken,
    livePending.id,
  );
  check(
    "Current token finalizes a private project document",
    liveFinal.status === "READY" &&
      liveFinal.jobId === liveJob.id &&
      liveFinal.businessId === businessA.id &&
      liveFinal.visibility === "PRIVATE",
  );

  console.log("\nTENANT ISOLATION — a foreign live token cannot write this job");
  const foreignJob = await createJob(businessB.id, `beta-${suffix}`);
  const isolatedJob = await createJob(businessA.id, `iso-${suffix}`);
  const isolatedChange = await createSentChangeOrder(isolatedJob, "Alpha only");
  const foreignApprove = await approveCustomerChangeOrder(prisma, {
    token: foreignJob.projectToken,
    changeOrderId: isolatedChange.id,
  });
  const isolatedAfter = await prisma.changeOrder.findUnique({
    where: { id: isolatedChange.id },
    select: { status: true, businessId: true },
  });
  check(
    "Beta token cannot approve Alpha's change order",
    foreignApprove.error === CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR &&
      isolatedAfter?.status === "SENT" &&
      isolatedAfter.businessId === businessA.id,
  );

  const foreignWork = await createCustomerAdditionalWorkRequest(prisma, {
    token: foreignJob.projectToken,
    notes: "Should land on Beta, not Alpha.",
  });
  const alphaWorkCount = await prisma.additionalWorkRequest.count({
    where: { jobId: isolatedJob.id, businessId: businessA.id },
  });
  const betaWork = foreignWork.ok
    ? await prisma.additionalWorkRequest.findFirst({
        where: { id: foreignWork.requestId },
      })
    : null;
  check(
    "Beta token additional-work stays on Beta's job",
    foreignWork.ok === true &&
      foreignWork.jobId === foreignJob.id &&
      betaWork?.businessId === businessB.id &&
      alphaWorkCount === 0,
  );

  const isolatedPending = await authorizePendingDocument(
    prisma,
    isolatedJob.projectToken,
    "alpha-only.pdf",
  );
  let foreignFinalizeError = null;
  try {
    await finalizeProjectTokenDocument(
      storageDeps(prisma),
      foreignJob.projectToken,
      isolatedPending.id,
    );
  } catch (error) {
    foreignFinalizeError = error;
  }
  const isolatedAsset = await prisma.storedAsset.findUnique({
    where: { id: isolatedPending.id },
    select: { status: true, jobId: true, businessId: true },
  });
  check(
    "Beta token cannot finalize Alpha's pending document",
    foreignFinalizeError instanceof StorageAccessError &&
      isolatedAsset?.status === "PENDING" &&
      isolatedAsset.jobId === isolatedJob.id &&
      isolatedAsset.businessId === businessA.id,
  );

  const rotateClient = session.createClient();
  const writeClient = session.createClient();

  console.log("\nRACE — rotate commits first; old token cannot write");
  try {
    const rotateFirstChangeJob = await createJob(businessA.id, `rf-co-${suffix}`);
    const rotateFirstChange = await createSentChangeOrder(
      rotateFirstChangeJob,
      "Race rotate-first change order",
    );
    const rotateFirstChangeToken = rotateFirstChangeJob.projectToken;
    const [rotatedChange, staleChange] = await holdThenRace({
      label: "rotate-first change-order",
      installHold: (barrier) => {
        jobProjectLinkTestHooks.afterJobLock = async ({ kind }) => {
          if (kind === "rotate") await barrier();
        };
      },
      startHeld: () =>
        rotateJobProjectLink(rotateClient, ownerA, { jobId: rotateFirstChangeJob.id }),
      startContender: () =>
        approveCustomerChangeOrder(writeClient, {
          token: rotateFirstChangeToken,
          changeOrderId: rotateFirstChange.id,
        }),
    });
    const rotateFirstChangeAfter = await prisma.changeOrder.findUnique({
      where: { id: rotateFirstChange.id },
      select: { status: true },
    });
    check(
      "Rotate-first change-order: old token is refused and the row stays SENT",
      rotatedChange.status === "fulfilled" &&
        rotatedChange.value.previousToken === rotateFirstChangeToken &&
        staleChange.status === "fulfilled" &&
        staleChange.value.error === CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR &&
        rotateFirstChangeAfter?.status === "SENT",
    );

    const rotateFirstWorkJob = await createJob(businessA.id, `rf-aw-${suffix}`);
    const rotateFirstWorkToken = rotateFirstWorkJob.projectToken;
    const [rotatedWork, staleWork] = await holdThenRace({
      label: "rotate-first additional-work",
      installHold: (barrier) => {
        jobProjectLinkTestHooks.afterJobLock = async ({ kind }) => {
          if (kind === "rotate") await barrier();
        };
      },
      startHeld: () =>
        rotateJobProjectLink(rotateClient, ownerA, { jobId: rotateFirstWorkJob.id }),
      startContender: () =>
        createCustomerAdditionalWorkRequest(writeClient, {
          token: rotateFirstWorkToken,
          notes: "Stale additional work after rotate.",
        }),
    });
    const rotateFirstWorkCount = await prisma.additionalWorkRequest.count({
      where: { jobId: rotateFirstWorkJob.id },
    });
    check(
      "Rotate-first additional-work: old token stores no request",
      rotatedWork.status === "fulfilled" &&
        rotatedWork.value.previousToken === rotateFirstWorkToken &&
        staleWork.status === "fulfilled" &&
        staleWork.value.ok === false &&
        staleWork.value.error === JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE &&
        rotateFirstWorkCount === 0,
    );

    const rotateFirstDocJob = await createJob(businessA.id, `rf-doc-${suffix}`);
    const rotateFirstDocToken = rotateFirstDocJob.projectToken;
    const rotateFirstPending = await authorizePendingDocument(
      prisma,
      rotateFirstDocToken,
      "rotate-first.pdf",
    );
    const [rotatedDoc, staleDoc] = await holdThenRace({
      label: "rotate-first finalize",
      installHold: (barrier) => {
        jobProjectLinkTestHooks.afterJobLock = async ({ kind }) => {
          if (kind === "rotate") await barrier();
        };
      },
      startHeld: () =>
        rotateJobProjectLink(rotateClient, ownerA, { jobId: rotateFirstDocJob.id }),
      startContender: () =>
        finalizeProjectTokenDocument(
          storageDeps(writeClient),
          rotateFirstDocToken,
          rotateFirstPending.id,
        ),
    });
    const rotateFirstAsset = await prisma.storedAsset.findUnique({
      where: { id: rotateFirstPending.id },
      select: { status: true },
    });
    check(
      "Rotate-first finalize: old token leaves the asset PENDING",
      rotatedDoc.status === "fulfilled" &&
        rotatedDoc.value.previousToken === rotateFirstDocToken &&
        staleDoc.status === "rejected" &&
        staleDoc.reason instanceof StorageAccessError &&
        String(staleDoc.reason.message).includes("not available") &&
        rotateFirstAsset?.status === "PENDING",
    );
  } finally {
    clearWriteHooks();
  }

  console.log("\nRACE — current-token write commits first; rotate waits then succeeds");
  try {
    const writeFirstChangeJob = await createJob(businessA.id, `wf-co-${suffix}`);
    const writeFirstChange = await createSentChangeOrder(
      writeFirstChangeJob,
      "Race write-first change order",
    );
    const writeFirstChangeToken = writeFirstChangeJob.projectToken;
    const [writtenChange, rotatedAfterChange] = await holdThenRace({
      label: "write-first change-order",
      installHold: (barrier) => {
        publicChangeOrderTestHooks.afterJobLock = async ({ kind }) => {
          if (kind === "approve") await barrier();
        };
      },
      startHeld: () =>
        approveCustomerChangeOrder(writeClient, {
          token: writeFirstChangeToken,
          changeOrderId: writeFirstChange.id,
        }),
      startContender: () =>
        rotateJobProjectLink(rotateClient, ownerA, { jobId: writeFirstChangeJob.id }),
    });
    const writeFirstChangeAfter = await prisma.changeOrder.findUnique({
      where: { id: writeFirstChange.id },
      select: { status: true },
    });
    const writeFirstChangeJobAfter = await prisma.job.findUnique({
      where: { id: writeFirstChangeJob.id },
      select: { projectToken: true },
    });
    check(
      "Write-first change-order: current token approves, then rotate replaces the token",
      writtenChange.status === "fulfilled" &&
        writtenChange.value.status === "APPROVED" &&
        writeFirstChangeAfter?.status === "APPROVED" &&
        rotatedAfterChange.status === "fulfilled" &&
        rotatedAfterChange.value.previousToken === writeFirstChangeToken &&
        writeFirstChangeJobAfter?.projectToken === rotatedAfterChange.value.projectToken &&
        writeFirstChangeJobAfter.projectToken !== writeFirstChangeToken,
    );

    const writeFirstWorkJob = await createJob(businessA.id, `wf-aw-${suffix}`);
    const writeFirstWorkToken = writeFirstWorkJob.projectToken;
    const [writtenWork, rotatedAfterWork] = await holdThenRace({
      label: "write-first additional-work",
      installHold: (barrier) => {
        additionalWorkRequestTestHooks.afterJobLock = async () => {
          await barrier();
        };
      },
      startHeld: () =>
        createCustomerAdditionalWorkRequest(writeClient, {
          token: writeFirstWorkToken,
          notes: "Current-token additional work before rotate.",
        }),
      startContender: () =>
        rotateJobProjectLink(rotateClient, ownerA, { jobId: writeFirstWorkJob.id }),
    });
    const writeFirstWorkRow =
      writtenWork.status === "fulfilled" && writtenWork.value.ok
        ? await prisma.additionalWorkRequest.findFirst({
            where: { id: writtenWork.value.requestId, jobId: writeFirstWorkJob.id },
          })
        : null;
    check(
      "Write-first additional-work: current token stores one request, then rotate replaces the token",
      writtenWork.status === "fulfilled" &&
        writtenWork.value.ok === true &&
        writeFirstWorkRow?.jobId === writeFirstWorkJob.id &&
        rotatedAfterWork.status === "fulfilled" &&
        rotatedAfterWork.value.previousToken === writeFirstWorkToken,
    );

    const writeFirstDocJob = await createJob(businessA.id, `wf-doc-${suffix}`);
    const writeFirstDocToken = writeFirstDocJob.projectToken;
    const writeFirstPending = await authorizePendingDocument(
      prisma,
      writeFirstDocToken,
      "write-first.pdf",
    );
    const [writtenDoc, rotatedAfterDoc] = await holdThenRace({
      label: "write-first finalize",
      installHold: (barrier) => {
        projectDocumentTestHooks.afterJobLock = async (input) => {
          if (input?.phase === "finalize") await barrier();
        };
      },
      startHeld: () =>
        finalizeProjectTokenDocument(
          storageDeps(writeClient),
          writeFirstDocToken,
          writeFirstPending.id,
        ),
      startContender: () =>
        rotateJobProjectLink(rotateClient, ownerA, { jobId: writeFirstDocJob.id }),
    });
    const writeFirstAsset = await prisma.storedAsset.findUnique({
      where: { id: writeFirstPending.id },
      select: { status: true, jobId: true },
    });
    check(
      "Write-first finalize: current token marks READY, then rotate replaces the token",
      writtenDoc.status === "fulfilled" &&
        writtenDoc.value.status === "READY" &&
        writeFirstAsset?.status === "READY" &&
        writeFirstAsset.jobId === writeFirstDocJob.id &&
        rotatedAfterDoc.status === "fulfilled" &&
        rotatedAfterDoc.value.previousToken === writeFirstDocToken,
    );
  } finally {
    clearWriteHooks();
  }

  await Promise.all([rotateClient.$disconnect(), writeClient.$disconnect()]);
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  jobProjectLinkTestHooks.afterJobLock = undefined;
  publicChangeOrderTestHooks.afterJobLock = undefined;
  additionalWorkRequestTestHooks.afterJobLock = undefined;
  projectDocumentTestHooks.afterJobLock = undefined;
  if (session) await session.cleanup();
}

if (failed > 0) {
  console.error(`\n${failed} project-token write-boundary check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${passed} project-token write-boundary checks passed.`);
