/**
 * Bounded customer-to-OWNER project conversation for an active
 * Handyman job.
 *
 * Dedicated database: tbbt_project_conversation_test
 *
 * Reuses Communications and the live project-token authorization path.
 * Distinct from the completed-job callback request. OWNER replies use
 * composeCustomerCommunication with fake providers. Opening a page
 * never sends. Proves token isolation, HTML escaping, replay, ordering,
 * and concurrent replies.
 *
 * Run with:
 *   npm run test:project-conversation
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for project-conversation checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import(
  "@/lib/authorization"
);
const {
  composeIdempotencyKey,
  loadCustomerCommunicationHistory,
  resetCommunicationEmailSender,
  setCommunicationEmailSender,
} = await import("@/lib/communications");
const {
  createFakeCustomerMessagingProvider,
  setCustomerMessagingProvider,
} = await import("@/lib/customer-messaging");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");
const {
  JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE,
} = await import("@/lib/job-callback");
const { loadPortalJobCallbackView } = await import("@/lib/portal-job-callback-data");
const { submitPortalJobCallback } = await import("@/lib/portal-job-callback-ops");
const {
  MAX_PROJECT_CONVERSATION_BODY_LENGTH,
  MAX_PROJECT_CONVERSATION_MESSAGES,
  MAX_PORTAL_PROJECT_TOKEN_LENGTH,
  PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE,
  PROJECT_CONVERSATION_ATTEMPT_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_BODY_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_BOUND_MESSAGE,
  PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE,
  PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE,
  PROJECT_CONVERSATION_PURPOSE,
  PROJECT_CONVERSATION_RELATED_TYPE,
  escapeProjectConversationHtml,
  parseProjectConversationBody,
  parseProjectConversationToken,
  portalProjectConversationIdempotencyKey,
  projectConversationHandymanEligible,
} = await import("@/lib/project-conversation");
const {
  loadOwnerProjectConversationReview,
  loadPortalProjectConversationView,
} = await import("@/lib/project-conversation-data");
const {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  portalProjectConversationTestHooks,
  sendProjectConversationOwnerReply,
  submitPortalProjectConversation,
} = await import("@/lib/project-conversation-ops");
const {
  jobProjectLinkTestHooks,
  rotateJobProjectLink,
  revokeJobProjectLink,
} = await import("@/lib/project-link-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the project-conversation check.");
  process.exit(1);
}

const sourceUrl = new URL(baseUrl);
const databaseHost = sourceUrl.hostname.toLowerCase();
if (databaseHost !== "localhost" && databaseHost !== "127.0.0.1" && databaseHost !== "::1") {
  console.error(
    "Project-conversation checks refuse a remote DATABASE_URL. Host must be localhost, 127.0.0.1, or ::1.",
  );
  process.exit(1);
}

const testDbName = "tbbt_project_conversation_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://project-conversation.test";
process.env.RESEND_API_KEY = "re_test_project_conversation";
process.env.EMAIL_FROM = "TBBT <comms@example.com>";
process.env.TBBT_EMAIL_ADAPTER = "fake";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const clients = [];

function trackClient(client) {
  clients.push(client);
  return client;
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

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Conversation Co" },
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

const featureFiles = [
  "src/lib/project-conversation.ts",
  "src/lib/project-conversation-data.ts",
  "src/lib/project-conversation-ops.ts",
  "src/app/actions/portal-project-conversation.ts",
  "src/app/actions/project-conversation.ts",
  "src/components/portal/project-conversation-card.tsx",
  "src/components/jobs/project-conversation-panel.tsx",
];
const opsSrc = read("src/lib/project-conversation-ops.ts");
const dataSrc = read("src/lib/project-conversation-data.ts");
const contractSrc = read("src/lib/project-conversation.ts");
const portalActionSrc = read("src/app/actions/portal-project-conversation.ts");
const ownerActionSrc = read("src/app/actions/project-conversation.ts");
const portalFormSrc = read("src/components/portal/project-conversation-card.tsx");
const ownerPanelSrc = read("src/components/jobs/project-conversation-panel.tsx");
const portalPageSrc = read("src/app/p/[token]/page.tsx");
const jobPageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const packageSrc = read("package.json");
const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe/;

console.log("\nSTATIC — token-only conversation, Communications reply, no page-load send");
const portalSubmitSrc = opsSrc.slice(
  opsSrc.indexOf("export async function submitPortalProjectConversation"),
  opsSrc.indexOf("export async function sendProjectConversationOwnerReply"),
);
check(
  "Token-only customer write; browser businessId/customerId/jobId are never authorization",
  dataSrc.includes("findLiveJobByProjectToken") &&
    portalSubmitSrc.includes("findLiveJobByProjectToken") &&
    portalSubmitSrc.includes("assertLiveLockedProjectToken") &&
    portalActionSrc.includes('readString(formData, "projectToken")') &&
    !portalActionSrc.includes('readString(formData, "businessId")') &&
    !portalActionSrc.includes('readString(formData, "customerId")') &&
    !portalActionSrc.includes('readString(formData, "jobId")') &&
    !portalSubmitSrc.includes("input.businessId") &&
    !portalSubmitSrc.includes("input.customerId") &&
    !portalSubmitSrc.includes("input.jobId") &&
    !portalFormSrc.includes('name="businessId"') &&
    !portalFormSrc.includes('name="jobId"') &&
    !portalFormSrc.includes('name="customerId"'),
);
check(
  "OWNER reply reuses composeCustomerCommunication and an explicit Send",
  opsSrc.includes("composeCustomerCommunication") &&
    ownerActionSrc.includes("composeIdempotencyKey") &&
    ownerActionSrc.includes("resolveComposeSendIntent") &&
    ownerActionSrc.includes('template: "job_update"') &&
    ownerPanelSrc.includes('{pending ? "Sending…" : "Send"}') &&
    ownerPanelSrc.includes("sendProjectConversationReplyAction") &&
    !dataSrc.includes("composeCustomerCommunication") &&
    !dataSrc.includes("submitPortalProjectConversation") &&
    !portalPageSrc.includes("composeCustomerCommunication") &&
    !jobPageSrc.includes("composeCustomerCommunication") &&
    !jobPageSrc.includes("sendProjectConversationOwnerReply(") &&
    !portalPageSrc.includes("submitPortalProjectConversation("),
);
check(
  "OWNER reply serializes the bound check under the job lock",
  (() => {
    const ownerReplySrc = opsSrc.slice(
      opsSrc.indexOf("export async function sendProjectConversationOwnerReply"),
    );
    const lockIdx = ownerReplySrc.indexOf("lockTenantOwnedJob");
    const countIdx = ownerReplySrc.indexOf("countProjectConversationMessages");
    const composeIdx = ownerReplySrc.indexOf("composeCustomerCommunication");
    return lockIdx >= 0 && countIdx > lockIdx && composeIdx > countIdx;
  })(),
);
check(
  "Conversation is distinct from the callback request and stays job-scoped",
  portalPageSrc.includes("ProjectConversationCard") &&
    portalPageSrc.includes("callback-request") &&
    jobPageSrc.includes("ProjectConversationPanel") &&
    jobPageSrc.includes("JobCallbackPanel") &&
    !opsSrc.includes("jobCallback.create") &&
    !opsSrc.includes("submitPortalJobCallback") &&
    contractSrc.includes('relatedType: PROJECT_CONVERSATION_RELATED_TYPE') === false &&
    contractSrc.includes('PROJECT_CONVERSATION_RELATED_TYPE = "JOB"') &&
    PROJECT_CONVERSATION_RELATED_TYPE === "JOB" &&
    PROJECT_CONVERSATION_PURPOSE === "JOB_UPDATE" &&
    PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE.includes("not a callback request") &&
    !PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE.includes(JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE) &&
    JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE.includes("after this job is complete"),
);
check(
  "Page load and read model never send",
  !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc) &&
    dataSrc.includes("Mutation-free") &&
    portalPageSrc.includes("loadPortalProjectConversationView") &&
    jobPageSrc.includes("loadOwnerProjectConversationReview") &&
    PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE.includes("opening this page does not send") &&
    ownerPanelSrc.includes("Opening this page does not send"),
);
check(
  "Conversation reads keep SYSTEM/MANUAL/PHONE job updates out of both views",
  dataSrc.includes("PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS") &&
    dataSrc.includes("channel: { in: [...PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS] }"),
);
check(
  "Inputs are bounded and HTML is escaped at the HTML boundary",
  parseProjectConversationToken("a".repeat(MAX_PORTAL_PROJECT_TOKEN_LENGTH + 1)) === null &&
    parseProjectConversationBody("x".repeat(600))?.length ===
      MAX_PROJECT_CONVERSATION_BODY_LENGTH &&
    MAX_PROJECT_CONVERSATION_MESSAGES === 20 &&
    escapeProjectConversationHtml("<script>alert(1)</script>") ===
      "&lt;script&gt;alert(1)&lt;/script&gt;" &&
    !portalFormSrc.includes("dangerouslySetInnerHTML") &&
    !ownerPanelSrc.includes("dangerouslySetInnerHTML") &&
    portalFormSrc.includes("{message.body}") &&
    ownerPanelSrc.includes("{message.body}"),
);
check(
  "Write order is live-token lookup, lock, post-lock re-check, then record",
  (() => {
    const submitSrc = opsSrc.slice(opsSrc.indexOf("export async function submitPortalProjectConversation"));
    const liveIdx = submitSrc.indexOf("findLiveJobByProjectToken");
    const lockIdx = submitSrc.indexOf("lockTenantOwnedJob");
    const recheckIdx = submitSrc.indexOf("assertLiveLockedProjectToken");
    const createIdx = submitSrc.indexOf("tx.customerCommunication.create");
    return (
      liveIdx >= 0 &&
      lockIdx > liveIdx &&
      recheckIdx > lockIdx &&
      createIdx > recheckIdx &&
      opsSrc.includes("portalProjectConversationTestHooks.afterJobLock")
    );
  })(),
);
check(
  "Dedicated npm script exists and request paths do no DDL",
  packageSrc.includes("test:project-conversation") &&
    packageSrc.includes("check-project-conversation.mjs") &&
    !opsSrc.includes("CREATE TABLE") &&
    !dataSrc.includes("ALTER TABLE") &&
    !portalActionSrc.includes("prisma migrate") &&
    featureFiles.every((file) => !DANGEROUS.test(read(file))),
);
check(
  "MEMBER does not receive MANAGE_COMMUNICATIONS",
  roleHasCapability("OWNER", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
    roleHasCapability("ADMIN", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_COMMUNICATIONS),
);
check(
  "A job without an estimate is Handyman-eligible while active",
  projectConversationHandymanEligible({ status: "IN_PROGRESS" }) === true &&
    projectConversationHandymanEligible({ status: "COMPLETED" }) === false &&
    projectConversationHandymanEligible({
      status: "IN_PROGRESS",
      estimate: { serviceRequest: { tradeCode: "CLEANING" } },
    }) === false,
);

try {
  const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
    encoding: "utf8",
  });
  if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
    throw new Error(createDb.stderr || createDb.stdout || "Failed to create project-conversation test database.");
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    throw new Error("Failed to push schema for project-conversation test database.");
  }

  const prisma = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const fakeEmails = [];
  setCommunicationEmailSender(async (input) => {
    fakeEmails.push(input);
    return { id: `fake-email:${input.idempotencyKey}` };
  });
  const fakeSms = createFakeCustomerMessagingProvider();
  setCustomerMessagingProvider(fakeSms);

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-convo-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-convo-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-convo-${suffix}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Conversation",
      slug: `alpha-convo-${suffix}`,
      tradeCode: "HANDYMAN",
      operationalSmsNumber: "5551002000",
    },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Conversation", slug: `beta-convo-${suffix}`, tradeCode: "CLEANING" },
  });
  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memMemberA.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", memOwnerB.id, ownerBUser.id);

  await prisma.businessProductGrant.create({
    data: {
      businessId: businessA.id,
      grantType: "CAPABILITY",
      code: PRODUCT_CAPABILITIES.SMS_MESSAGING,
      status: "ACTIVE",
      source: "MANUAL",
      sourceRef: `sms-${suffix}`,
    },
  });

  async function createHandyJob(businessId, options = {}) {
    const { status = "IN_PROGRESS", tradeCode = "HANDYMAN" } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: options.name ?? "Conversation Customer",
        email: options.email ?? `convo-${randomUUID().slice(0, 6)}@example.com`,
        phone: options.phone ?? "5551112222",
        smsConsentStatus: options.smsConsentStatus ?? "GRANTED",
      },
    });
    let estimateId = null;
    if (tradeCode !== "HANDYMAN" || options.withEstimate) {
      const request = await prisma.serviceRequest.create({
        data: {
          businessId,
          customerId: customer.id,
          description: `${tradeCode} request`,
          tradeCode,
        },
      });
      const estimate = await prisma.estimate.create({
        data: {
          businessId,
          customerId: customer.id,
          serviceRequestId: request.id,
          status: "APPROVED",
          publicToken: randomUUID(),
        },
      });
      estimateId = estimate.id;
    }
    const job = await prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        status,
        projectToken: randomUUID(),
        ...(estimateId ? { estimateId } : {}),
      },
    });
    return { customer, job };
  }

  const activeA = await createHandyJob(businessA.id, { name: "Ava" });
  const siblingA = await createHandyJob(businessA.id, { name: "Sib" });
  const completedA = await createHandyJob(businessA.id, { status: "COMPLETED", name: "Done" });
  const cleaningA = await createHandyJob(businessA.id, {
    tradeCode: "CLEANING",
    name: "Clean",
  });
  const foreignB = await createHandyJob(businessB.id, { name: "Bea" });

  const invoicesBeforeWrite = await countBusinessInvoices(prisma, businessA.id);
  const jobsBeforeWrite = await countBusinessJobs(prisma, businessA.id);
  const paymentsBeforeWrite = await countBusinessPayments(prisma, businessA.id);
  const commsBeforeWrite = await countBusinessCommunications(prisma, businessA.id);

  console.log("\nINVALID TOKEN — empty, unknown, and oversized tokens fail closed");
  const empty = await submitPortalProjectConversation(prisma, {
    token: "   ",
    body: "Hello",
    attemptId: randomUUID(),
  });
  const unknown = await submitPortalProjectConversation(prisma, {
    token: randomUUID(),
    body: "Hello",
    attemptId: randomUUID(),
  });
  const oversized = await submitPortalProjectConversation(prisma, {
    token: "a".repeat(MAX_PORTAL_PROJECT_TOKEN_LENGTH + 1),
    body: "Hello",
    attemptId: randomUUID(),
  });
  check(
    "Empty, unknown, and oversized tokens are unavailable",
    empty.error === PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE &&
      unknown.error === PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE &&
      oversized.error === PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE,
  );
  const missingBody = await submitPortalProjectConversation(prisma, {
    token: activeA.job.projectToken,
    body: "   ",
    attemptId: randomUUID(),
  });
  const missingAttempt = await submitPortalProjectConversation(prisma, {
    token: activeA.job.projectToken,
    body: "Hello",
    attemptId: "retry",
  });
  check(
    "Body and attempt id are required",
    missingBody.error === PROJECT_CONVERSATION_BODY_REQUIRED_MESSAGE &&
      missingAttempt.error === PROJECT_CONVERSATION_ATTEMPT_REQUIRED_MESSAGE,
  );

  console.log("\nELIGIBILITY — active Handyman only; callback stays on completed jobs");
  const completedPost = await submitPortalProjectConversation(prisma, {
    token: completedA.job.projectToken,
    body: "After completion",
    attemptId: randomUUID(),
  });
  const cleaningPost = await submitPortalProjectConversation(prisma, {
    token: cleaningA.job.projectToken,
    body: "Cleaning chat",
    attemptId: randomUUID(),
  });
  const completedView = await loadPortalProjectConversationView(
    prisma,
    completedA.job.projectToken,
  );
  const cleaningView = await loadPortalProjectConversationView(
    prisma,
    cleaningA.job.projectToken,
  );
  const callbackOnActive = await loadPortalJobCallbackView(
    prisma,
    activeA.job.projectToken,
  );
  const callbackOnCompleted = await loadPortalJobCallbackView(
    prisma,
    completedA.job.projectToken,
  );
  check(
    "Completed and Cleaning jobs refuse conversation writes",
    completedPost.error === PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE &&
      cleaningPost.error === PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE &&
      completedView.status === "hidden" &&
      cleaningView.status === "hidden",
  );
  check(
    "Callback stays hidden on an active job and ready on a completed job",
    callbackOnActive.status === "hidden" && callbackOnCompleted.status === "ready",
  );

  console.log("\nCUSTOMER WRITE — inbound PORTAL row on this job");
  const firstAttempt = randomUUID();
  const first = await submitPortalProjectConversation(prisma, {
    token: activeA.job.projectToken,
    body: "Can you confirm the start window?",
    attemptId: firstAttempt,
  });
  const firstRow = first.ok
    ? await prisma.customerCommunication.findFirst({ where: { id: first.communicationId } })
    : null;
  const invoicesAfterFirst = await countBusinessInvoices(prisma, businessA.id);
  const jobsAfterFirst = await countBusinessJobs(prisma, businessA.id);
  const paymentsAfterFirst = await countBusinessPayments(prisma, businessA.id);
  const commsAfterFirst = await countBusinessCommunications(prisma, businessA.id);
  check(
    "Customer post records one inbound PORTAL job message",
    first.ok === true &&
      first.reused === false &&
      first.jobId === activeA.job.id &&
      firstRow?.direction === "INBOUND" &&
      firstRow?.channel === "PORTAL" &&
      firstRow?.purpose === "JOB_UPDATE" &&
      firstRow?.relatedType === "JOB" &&
      firstRow?.relatedId === activeA.job.id &&
      firstRow?.customerId === activeA.customer.id &&
      firstRow?.businessId === businessA.id &&
      firstRow?.provider === "portal" &&
      firstRow?.bodySnapshot === "Can you confirm the start window?",
  );
  check(
    "The first conversation write does not create an invoice, job, or payment",
    invoicesAfterFirst === invoicesBeforeWrite &&
      jobsAfterFirst === jobsBeforeWrite &&
      paymentsAfterFirst === paymentsBeforeWrite &&
      commsAfterFirst === commsBeforeWrite + 1,
  );

  console.log("\nREPLAY — same attempt reuses the row");
  const replay = await submitPortalProjectConversation(prisma, {
    token: activeA.job.projectToken,
    body: "Changed text should not write a second row.",
    attemptId: firstAttempt,
  });
  const replayCount = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "JOB",
      relatedId: activeA.job.id,
    },
  });
  check(
    "Replay of the same attempt is reused and does not duplicate",
    replay.ok === true &&
      replay.reused === true &&
      replay.communicationId === first.communicationId &&
      replayCount === 1,
  );

  console.log("\nTOKEN ISOLATION — sibling, foreign, rotate, and revoke");
  const siblingPost = await submitPortalProjectConversation(prisma, {
    token: siblingA.job.projectToken,
    body: "Sibling job question",
    attemptId: randomUUID(),
  });
  const foreignPost = await submitPortalProjectConversation(prisma, {
    token: foreignB.job.projectToken,
    body: "Foreign tenant",
    attemptId: randomUUID(),
  });
  const activeView = await loadPortalProjectConversationView(
    prisma,
    activeA.job.projectToken,
  );
  const siblingView = await loadPortalProjectConversationView(
    prisma,
    siblingA.job.projectToken,
  );
  const foreignView = await loadPortalProjectConversationView(
    prisma,
    foreignB.job.projectToken,
  );
  check(
    "Sibling and foreign tokens cannot read or write another job's conversation",
    siblingPost.ok === true &&
      siblingPost.jobId === siblingA.job.id &&
      foreignPost.ok === true &&
      foreignPost.jobId === foreignB.job.id &&
      activeView.status === "ready" &&
      activeView.messages.length === 1 &&
      activeView.messages[0].id === first.communicationId &&
      siblingView.messages.every((row) => row.id !== first.communicationId) &&
      foreignView.messages.every((row) => row.id !== first.communicationId),
  );

  const rotateTarget = await createHandyJob(businessA.id, { name: "Rotate" });
  const oldToken = rotateTarget.job.projectToken;
  const rotated = await rotateJobProjectLink(prisma, ownerA, { jobId: rotateTarget.job.id });
  const staleRotate = await submitPortalProjectConversation(prisma, {
    token: oldToken,
    body: "Old token after rotate",
    attemptId: randomUUID(),
  });
  const liveRotate = await submitPortalProjectConversation(prisma, {
    token: rotated.projectToken,
    body: "New token after rotate",
    attemptId: randomUUID(),
  });
  check(
    "Rotated tokens refuse the old URL and accept the live token",
    staleRotate.error === PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE &&
      liveRotate.ok === true &&
      liveRotate.jobId === rotateTarget.job.id,
  );

  const revokeTarget = await createHandyJob(businessA.id, { name: "Revoke" });
  const revokedToken = revokeTarget.job.projectToken;
  await revokeJobProjectLink(prisma, ownerA, { jobId: revokeTarget.job.id });
  const staleRevoke = await submitPortalProjectConversation(prisma, {
    token: revokedToken,
    body: "Revoked token",
    attemptId: randomUUID(),
  });
  const revokeView = await loadPortalProjectConversationView(prisma, revokedToken);
  check(
    "Revoked tokens cannot read or write the conversation",
    staleRevoke.error === PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE &&
      revokeView.status === "hidden",
  );

  const raceRotate = await createHandyJob(businessA.id, { name: "RaceRotate" });
  const raceOldToken = raceRotate.job.projectToken;
  const rotateClient = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const convoClient = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  jobProjectLinkTestHooks.afterJobLock = async ({ kind }) => {
    if (kind === "rotate") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  const rotatePromise = rotateJobProjectLink(rotateClient, ownerA, {
    jobId: raceRotate.job.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const staleInFlight = submitPortalProjectConversation(convoClient, {
    token: raceOldToken,
    body: "In-flight old token",
    attemptId: randomUUID(),
  });
  const [racedRotate, staleInFlightResult] = await Promise.all([
    rotatePromise,
    staleInFlight,
  ]);
  jobProjectLinkTestHooks.afterJobLock = undefined;
  check(
    "Post-lock re-check refuses an in-flight old token after rotate",
    racedRotate.projectToken !== raceOldToken &&
      staleInFlightResult.error === PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE,
  );

  console.log("\nHTML ESCAPING — stored raw, escaped for HTML delivery");
  const xssAttempt = randomUUID();
  const xssBody = '<script>alert("xss")</script>';
  const xss = await submitPortalProjectConversation(prisma, {
    token: activeA.job.projectToken,
    body: xssBody,
    attemptId: xssAttempt,
  });
  const xssRow = xss.ok
    ? await prisma.customerCommunication.findFirst({ where: { id: xss.communicationId } })
    : null;
  const escaped = escapeProjectConversationHtml(xssBody);
  check(
    "Customer HTML is stored as text and escaped for HTML",
    xss.ok === true &&
      xssRow?.bodySnapshot === xssBody &&
      escaped.includes("&lt;script&gt;") &&
      !escaped.includes("<script>") &&
      (await loadPortalProjectConversationView(prisma, activeA.job.projectToken)).messages.some(
        (row) => row.body === xssBody,
      ),
  );

  console.log("\nOWNER REPLY — explicit Send through consent and delivery");
  const ownerAttempt = randomUUID();
  const ownerKey = composeIdempotencyKey({
    channel: "EMAIL",
    purpose: "JOB_UPDATE",
    customerId: activeA.customer.id,
    attemptId: ownerAttempt,
  });
  const ownerReply = await sendProjectConversationOwnerReply(prisma, ownerA, {
    jobId: activeA.job.id,
    channel: "EMAIL",
    body: `We will arrive after 9. ${xssBody}`,
    subject: "Project conversation",
    idempotencyKey: ownerKey,
  });
  const ownerEmail = fakeEmails.find((row) => row.idempotencyKey === ownerKey);
  check(
    "OWNER email reply sends once through the fake provider with escaped HTML",
    ownerReply.ok === true &&
      ownerReply.reused === false &&
      ownerReply.status === "SENT" &&
      ownerEmail?.to === activeA.customer.email &&
      ownerEmail?.text.includes("We will arrive after 9.") &&
      ownerEmail?.html.includes(escaped) &&
      !ownerEmail?.html.includes("<script>"),
  );

  const ownerReplay = await sendProjectConversationOwnerReply(prisma, ownerA, {
    jobId: activeA.job.id,
    channel: "EMAIL",
    body: "Retry should reuse.",
    subject: "Project conversation",
    idempotencyKey: ownerKey,
  });
  const ownerEmailCount = fakeEmails.filter((row) => row.idempotencyKey === ownerKey).length;
  check(
    "OWNER reply replay reuses the same communication and does not resend",
    ownerReplay.ok === true &&
      ownerReplay.reused === true &&
      ownerReplay.communicationId === ownerReply.communicationId &&
      ownerEmailCount === 1,
  );

  const smsAttempt = randomUUID();
  const smsKey = composeIdempotencyKey({
    channel: "SMS",
    purpose: "JOB_UPDATE",
    customerId: activeA.customer.id,
    attemptId: smsAttempt,
  });
  const smsReply = await sendProjectConversationOwnerReply(prisma, ownerA, {
    jobId: activeA.job.id,
    channel: "SMS",
    body: "Running a little late.",
    idempotencyKey: smsKey,
  });
  check(
    "OWNER SMS reply uses the fake messaging provider and stays on this job",
    smsReply.ok === true &&
      ["ACCEPTED", "SENT", "QUEUED"].includes(smsReply.status) &&
      fakeSms.sent.some((row) => row.body === "Running a little late."),
  );

  const browserForged = await sendProjectConversationOwnerReply(prisma, ownerA, {
    jobId: activeA.job.id,
    channel: "EMAIL",
    body: "Forged business id",
    idempotencyKey: `comm:EMAIL:JOB_UPDATE:${activeA.customer.id}:${randomUUID()}`,
    browserBusinessId: businessB.id,
  });
  check(
    "Browser businessId never authorizes an OWNER reply",
    browserForged.ok === false &&
      /businessId never authorizes/i.test(browserForged.failureReason ?? ""),
  );

  await expectThrow(
    "MEMBER cannot send an OWNER reply",
    () =>
      sendProjectConversationOwnerReply(prisma, memberA, {
        jobId: activeA.job.id,
        channel: "EMAIL",
        body: "Member should not send",
        idempotencyKey: `comm:EMAIL:JOB_UPDATE:${activeA.customer.id}:${randomUUID()}`,
      }),
    (error) => error instanceof ForbiddenError,
  );

  const foreignReply = await sendProjectConversationOwnerReply(prisma, ownerB, {
    jobId: activeA.job.id,
    channel: "EMAIL",
    body: "Wrong tenant",
    idempotencyKey: `comm:EMAIL:JOB_UPDATE:${activeA.customer.id}:${randomUUID()}`,
  });
  check(
    "Foreign OWNER cannot reply on another business job",
    foreignReply.ok === false &&
      /could not be found/i.test(foreignReply.failureReason ?? ""),
  );

  const completedReply = await sendProjectConversationOwnerReply(prisma, ownerA, {
    jobId: completedA.job.id,
    channel: "EMAIL",
    body: "Completed job reply",
    idempotencyKey: `comm:EMAIL:JOB_UPDATE:${completedA.customer.id}:${randomUUID()}`,
  });
  check(
    "OWNER cannot reply on a completed job",
    completedReply.ok === false &&
      completedReply.failureReason === PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE,
  );

  console.log("\nORDERING — conversation is chronological; timeline still newest-first");
  const thirdAttempt = randomUUID();
  const third = await submitPortalProjectConversation(prisma, {
    token: activeA.job.projectToken,
    body: "Third customer note",
    attemptId: thirdAttempt,
  });
  const ownerReview = await loadOwnerProjectConversationReview(
    prisma,
    ownerA,
    activeA.job.id,
  );
  const portalThread = await loadPortalProjectConversationView(
    prisma,
    activeA.job.projectToken,
  );
  const timeline = await loadCustomerCommunicationHistory(prisma, ownerA, {
    customerId: activeA.customer.id,
  });
  const conversationIds = ownerReview?.messages.map((row) => row.id) ?? [];
  const portalIds = portalThread.messages.map((row) => row.id);
  check(
    "Conversation messages stay on this job in chronological order",
    ownerReview?.jobId === activeA.job.id &&
      conversationIds[0] === first.communicationId &&
      conversationIds.includes(xss.communicationId) &&
      conversationIds.includes(ownerReply.communicationId) &&
      conversationIds.at(-1) === third.communicationId &&
      portalIds[0] === first.communicationId &&
      portalIds.at(-1) === third.communicationId &&
      portalThread.messages.every((row) => row.body !== undefined),
  );
  check(
    "Existing customer communication timeline includes the job conversation",
    timeline.items.some((row) => row.id === first.communicationId && row.direction === "INBOUND") &&
      timeline.items.some((row) => row.id === ownerReply.communicationId && row.relatedId === activeA.job.id) &&
      timeline.items.some((row) => row.id === third.communicationId) &&
      timeline.items[0].id === third.communicationId,
  );

  console.log("\nINTERNAL CHANNELS — SYSTEM/MANUAL/PHONE JOB_UPDATE stay hidden");
  const hiddenBodies = {
    SYSTEM: "SYSTEM job update must stay hidden",
    MANUAL: "MANUAL job update must stay hidden",
    PHONE: "PHONE job update must stay hidden",
  };
  for (const [channel, body] of Object.entries(hiddenBodies)) {
    await prisma.customerCommunication.create({
      data: {
        businessId: businessA.id,
        customerId: activeA.customer.id,
        direction: "OUTBOUND",
        channel,
        purpose: "JOB_UPDATE",
        relatedType: "JOB",
        relatedId: activeA.job.id,
        idempotencyKey: `hidden:${channel}:${randomUUID()}`,
        bodySnapshot: body,
        status: "SENT",
        provider: "test",
      },
    });
  }
  const portalAfterHidden = await loadPortalProjectConversationView(
    prisma,
    activeA.job.projectToken,
  );
  const ownerAfterHidden = await loadOwnerProjectConversationReview(
    prisma,
    ownerA,
    activeA.job.id,
  );
  const hiddenBodyList = Object.values(hiddenBodies);
  check(
    "SYSTEM, MANUAL, and PHONE JOB_UPDATE rows stay hidden from portal and OWNER review",
    hiddenBodyList.every(
      (body) =>
        !portalAfterHidden.messages.some((row) => row.body === body) &&
        !(ownerAfterHidden?.messages.some((row) => row.body === body) ?? false),
    ) &&
      portalAfterHidden.messages.some((row) => row.id === first.communicationId) &&
      ownerAfterHidden?.messages.some((row) => row.id === first.communicationId) === true,
  );

  console.log("\nCONCURRENT REPLIES — same key sends once; different keys stay ordered");
  const raceAttempt = randomUUID();
  const raceKey = composeIdempotencyKey({
    channel: "EMAIL",
    purpose: "JOB_UPDATE",
    customerId: activeA.customer.id,
    attemptId: raceAttempt,
  });
  const raceInput = {
    jobId: activeA.job.id,
    channel: "EMAIL",
    body: "Concurrent same-key reply",
    subject: "Project conversation",
    idempotencyKey: raceKey,
  };
  const [raceLeft, raceRight] = await Promise.all([
    sendProjectConversationOwnerReply(prisma, ownerA, raceInput),
    sendProjectConversationOwnerReply(prisma, ownerA, raceInput),
  ]);
  const raceRows = await prisma.customerCommunication.findMany({
    where: { businessId: businessA.id, idempotencyKey: raceKey },
  });
  const raceSends = fakeEmails.filter((row) => row.idempotencyKey === raceKey);
  check("Concurrent same-key OWNER replies call the fake provider once", raceSends.length === 1);
  check("Concurrent same-key OWNER replies write one communication row", raceRows.length === 1);
  check(
    "Concurrent same-key OWNER replies share one accepted send",
    raceLeft.communicationId === raceRight.communicationId &&
      raceLeft.communicationId === raceRows[0].id &&
      [raceLeft, raceRight].some((row) => row.ok && row.status === "SENT"),
  );

  const customerRaceAttempt = randomUUID();
  const [custLeft, custRight] = await Promise.all([
    submitPortalProjectConversation(prisma, {
      token: activeA.job.projectToken,
      body: "Concurrent customer same attempt",
      attemptId: customerRaceAttempt,
    }),
    submitPortalProjectConversation(prisma, {
      token: activeA.job.projectToken,
      body: "Concurrent customer same attempt",
      attemptId: customerRaceAttempt,
    }),
  ]);
  const customerRaceRows = await prisma.customerCommunication.findMany({
    where: {
      businessId: businessA.id,
      idempotencyKey: portalProjectConversationIdempotencyKey(
        activeA.job.id,
        customerRaceAttempt,
      ),
    },
  });
  check(
    "Concurrent customer posts with the same attempt write one inbound row",
    custLeft.ok &&
      custRight.ok &&
      custLeft.communicationId === custRight.communicationId &&
      customerRaceRows.length === 1,
  );

  const orderJob = await createHandyJob(businessA.id, { name: "Order" });
  const firstDistinct = randomUUID();
  const secondDistinct = randomUUID();
  const [firstDistinctReply, secondDistinctReply] = await Promise.all([
    sendProjectConversationOwnerReply(prisma, ownerA, {
      jobId: orderJob.job.id,
      channel: "EMAIL",
      body: "First distinct reply",
      idempotencyKey: composeIdempotencyKey({
        channel: "EMAIL",
        purpose: "JOB_UPDATE",
        customerId: orderJob.customer.id,
        attemptId: firstDistinct,
      }),
    }),
    sendProjectConversationOwnerReply(prisma, ownerA, {
      jobId: orderJob.job.id,
      channel: "EMAIL",
      body: "Second distinct reply",
      idempotencyKey: composeIdempotencyKey({
        channel: "EMAIL",
        purpose: "JOB_UPDATE",
        customerId: orderJob.customer.id,
        attemptId: secondDistinct,
      }),
    }),
  ]);
  const ordered = await loadOwnerProjectConversationReview(prisma, ownerA, orderJob.job.id);
  const orderedIds = ordered?.messages.map((row) => row.id) ?? [];
  const expectedOrder = [firstDistinctReply, secondDistinctReply]
    .filter((row) => row.ok && row.communicationId)
    .map((row) => row.communicationId)
    .sort((left, right) => {
      const leftRow = ordered?.messages.find((row) => row.id === left);
      const rightRow = ordered?.messages.find((row) => row.id === right);
      if (!leftRow || !rightRow) return 0;
      const byTime = leftRow.occurredAt.getTime() - rightRow.occurredAt.getTime();
      return byTime !== 0 ? byTime : left.localeCompare(right);
    });
  check(
    "Concurrent distinct OWNER replies both persist in stable order",
    firstDistinctReply.ok &&
      secondDistinctReply.ok &&
      firstDistinctReply.communicationId !== secondDistinctReply.communicationId &&
      orderedIds.length === 2 &&
      orderedIds[0] === expectedOrder[0] &&
      orderedIds[1] === expectedOrder[1],
  );

  console.log("\nBOUND — conversation refuses a 21st message");
  const boundJob = await createHandyJob(businessA.id, { name: "Bound" });
  for (let index = 0; index < MAX_PROJECT_CONVERSATION_MESSAGES; index += 1) {
    const posted = await submitPortalProjectConversation(prisma, {
      token: boundJob.job.projectToken,
      body: `Bound message ${index + 1}`,
      attemptId: randomUUID(),
    });
    if (!posted.ok) {
      throw new Error(posted.error);
    }
  }
  const overflow = await submitPortalProjectConversation(prisma, {
    token: boundJob.job.projectToken,
    body: "One too many",
    attemptId: randomUUID(),
  });
  const overflowReply = await sendProjectConversationOwnerReply(prisma, ownerA, {
    jobId: boundJob.job.id,
    channel: "EMAIL",
    body: "Overflow reply",
    idempotencyKey: composeIdempotencyKey({
      channel: "EMAIL",
      purpose: "JOB_UPDATE",
      customerId: boundJob.customer.id,
      attemptId: randomUUID(),
    }),
  });
  const boundView = await loadPortalProjectConversationView(
    prisma,
    boundJob.job.projectToken,
  );
  check(
    "The conversation bound refuses further customer and OWNER writes",
    overflow.error === PROJECT_CONVERSATION_BOUND_MESSAGE &&
      overflowReply.ok === false &&
      overflowReply.failureReason === PROJECT_CONVERSATION_BOUND_MESSAGE &&
      boundView.status === "full" &&
      boundView.canWrite === false &&
      boundView.messages.length === MAX_PROJECT_CONVERSATION_MESSAGES,
  );

  const invoicesAfter = await countBusinessInvoices(prisma, businessA.id);
  const paymentsAfter = await countBusinessPayments(prisma, businessA.id);
  check(
    "Conversation writes still have not created invoices or payments",
    invoicesAfter === invoicesBeforeWrite && paymentsAfter === paymentsBeforeWrite,
  );

  const callbackStillHidden = await loadPortalJobCallbackView(
    prisma,
    activeA.job.projectToken,
  );
  const callbackSubmitOnActive = await submitPortalJobCallback(prisma, {
    token: activeA.job.projectToken,
    description: "Should stay a completed-job path",
    preferredContact: "PHONE",
  });
  check(
    "Active-job conversation does not open the callback request path",
    callbackStillHidden.status === "hidden" &&
      callbackSubmitOnActive.ok === false &&
      callbackSubmitOnActive.error === JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  );

  console.log("\nPAGE OPEN — loaders do not increment provider sends");
  const emailsBeforeLoad = fakeEmails.length;
  const smsBeforeLoad = fakeSms.sent.length;
  await loadPortalProjectConversationView(prisma, activeA.job.projectToken);
  await loadOwnerProjectConversationReview(prisma, ownerA, activeA.job.id);
  await loadCustomerCommunicationHistory(prisma, ownerA, {
    customerId: activeA.customer.id,
  });
  check(
    "Opening conversation views sends nothing",
    fakeEmails.length === emailsBeforeLoad && fakeSms.sent.length === smsBeforeLoad,
  );
} catch (error) {
  failed += 1;
  console.error(error);
} finally {
  resetCommunicationEmailSender();
  portalProjectConversationTestHooks.afterJobLock = undefined;
  for (const client of clients) {
    await client.$disconnect().catch(() => {});
  }
  const drop = spawnSync("psql", [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`], {
    encoding: "utf8",
  });
  if (drop.status !== 0) {
    console.error(drop.stderr || drop.stdout || "Failed to drop project-conversation test database.");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
