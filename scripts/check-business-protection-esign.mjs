/**
 * Connected e-sign adapter proofs. Uses the fake adapter only.
 * Never sends a real Dropbox Sign signature request.
 *
 *   node --experimental-strip-types scripts/check-business-protection-esign.mjs
 */
if (process.env.VERCEL_ENV === "production") {
  delete process.env.VERCEL_ENV;
}
process.env.TBBT_ESIGN_ADAPTER = "fake";
process.env.TBBT_ESIGN_WEBHOOK_SECRET = "tbbt-esign-test-secret";

import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { PROVIDER_SIGNED_DOCUMENT_NOTE, UPLOADED_SIGNED_DOCUMENT_NOTE } =
  await import("@/lib/business-protection");
const {
  ESIGN_CANCEL_STUCK_SEND_WARNING,
  ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE,
  ESIGN_STALE_SEND_MINUTES,
  ESIGN_STALE_SEND_NOT_READY_MESSAGE,
  ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE,
  EsignBoundaryError,
  normalizeCompletionMode,
  resolveEsignProviderStatus,
} = await import("@/lib/business-protection-esign");
const { dropboxSignEventHash } = await import("@/lib/esign/hmac");
const { getFakeEsignWebhookKey } = await import("@/lib/esign/config");
const { resetEsignProviderCache, getFakeEsignProvider } = await import("@/lib/esign/provider");
const { dispatchEsignWebhook, ESIGN_WEBHOOK_HELLO } = await import("@/lib/esign/dispatch");
const { ESIGN_WEBHOOK_PATH, isEsignWebhookPath } = await import("@/lib/esign/webhook-path");
const { DROPBOX_SIGN_API_ORIGIN, DROPBOX_SIGN_SEND_PATH } = await import("@/lib/esign/dropbox-sign");
const { FAKE_ESIGN_DOWNLOADABLE_EVENT, FAKE_ESIGN_SIGNED_EVENT } = await import("@/lib/esign/fake");
const { esignPdfLooksValid } = await import("@/lib/esign/signed-pdf");
const { MemoryStorageProvider } = await import("@/lib/business-storage/memory-provider");
const { ensureBusinessStorageAccount } = await import("@/lib/business-storage/service");
const {
  completeAgreementExternally,
  createAgreement,
  generateAgreementDraft,
  markAgreementOwnerReviewed,
  acknowledgeAgreementLegalReview,
  markAgreementReady,
  markAgreementSent,
  saveAgreementAnswers,
  saveAgreementDraftContent,
  sendAgreementForEsign,
  cancelStuckEsignSend,
  BusinessProtectionError,
} = await import("@/lib/business-protection-ops");
const { isFakeEsignAdapterEnabled } = await import("@/lib/esign/config");

resetEsignProviderCache();

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_protection_esign_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business-protection-esign test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, extras = {}) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId, userId: extras.userId ?? "user-x" },
      user: { id: extras.userId ?? "user-x" },
      business: { id: businessId, name: extras.businessName ?? "Biz" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

async function readyNda(db, access, title) {
  const agreement = await createAgreement(db, access, { agreementType: "NDA", title });
  await saveAgreementAnswers(db, access, {
    agreementId: agreement.id,
    answers: {
      counterparty: "Pat Counterparty",
      purpose: "Share a price list",
      confidential: "Vendor pricing",
    },
  });
  await generateAgreementDraft(db, access, {
    agreementId: agreement.id,
    businessName: access.workspace.business.name,
  });
  await markAgreementOwnerReviewed(db, access, { agreementId: agreement.id });
  await markAgreementReady(db, access, { agreementId: agreement.id });
  return db.businessAgreement.findUniqueOrThrow({
    where: { id: agreement.id },
    include: { versions: { orderBy: { versionNumber: "asc" } } },
  });
}

console.log("\nSTATIC — official Dropbox Sign docs, proxy, no live send in proofs");
const hmacSrc = readRepo("src/lib/esign/hmac.ts");
const dropboxSrc = readRepo("src/lib/esign/dropbox-sign.ts");
const fakeSrc = readRepo("src/lib/esign/fake.ts");
const routeSrc = readRepo("src/app/api/esign/webhook/route.ts");
const proxySrc = readRepo("src/proxy.ts");
const opsSrc = readRepo("src/lib/business-protection-ops.ts");
const workspaceSrc = readRepo("src/components/business-protection/workspace.tsx");
check("Official event_hash is HMAC-SHA256(api_key, event_time + event_type)", hmacSrc.includes('createHmac("sha256", apiKey)') && hmacSrc.includes("eventTime}${eventType}"));
check(
  "Content-Sha256 is not verified (event_hash is the documented verifier)",
  !hmacSrc.includes("dropboxSignContentSha256") &&
    !hmacSrc.includes('digest("base64")') &&
    !fakeSrc.includes("dropboxSignContentSha256") &&
    !dropboxSrc.includes("verifyDropboxSignContentSha256") &&
    hmacSrc.includes("event_hash is the documented verifier"),
);
check("Live adapter renders a valid PDF, not a %PDF-1.4 text stub", dropboxSrc.includes("renderEsignAgreementPdf") && !dropboxSrc.includes('"%PDF-1.4"'));
check("Live adapter uses official send and files paths", dropboxSrc.includes(DROPBOX_SIGN_API_ORIGIN) && dropboxSrc.includes(DROPBOX_SIGN_SEND_PATH) && dropboxSrc.includes("/v3/signature_request/files"));
const sendFn = opsSrc.slice(
  opsSrc.indexOf("export async function sendAgreementForEsign"),
  opsSrc.indexOf("export async function completeAgreementFromEsignWebhook"),
);
check(
  "OWNER Send claims SENDING before createSignatureRequest",
  sendFn.includes('signingMode: ESIGN_SENDING_MODE') &&
    sendFn.indexOf("ESIGN_SENDING_MODE") < sendFn.indexOf("createSignatureRequest") &&
    sendFn.includes("releaseClaim"),
);
check(
  "Webhook completion requires the stored signature_request_id",
  opsSrc.includes("boundEsignRequestId") &&
    opsSrc.includes("esignSignatureRequestId") &&
    opsSrc.includes("was not sent through the connected e-sign adapter for this request"),
);
check(
  "Authenticated terminal webhook outcomes return Hello API Event Received",
  readRepo("src/lib/esign/dispatch.ts").includes('return authenticated("already_complete")') &&
    readRepo("src/lib/esign/dispatch.ts").includes('return authenticated("request_mismatch")') &&
    readRepo("src/lib/esign/dispatch.ts").includes("status: 200, hello: true"),
);
check(
  "Retriable download failures return 503 so Dropbox retries",
  readRepo("src/lib/esign/dispatch.ts").includes('return retriable("document_not_ready")') &&
    readRepo("src/lib/esign/dispatch.ts").includes('return retriable("provider_download_failed")') &&
    readRepo("src/lib/esign/dispatch.ts").includes("status: 503, hello: false"),
);
check(
  "OWNER Send releases a claim only on a definite 4xx rejection",
  sendFn.includes("isDefiniteEsignProviderRejection") &&
    sendFn.includes("ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE") &&
    !/catch \(error\) \{\s*await releaseClaim\(\);/.test(sendFn),
);
check("OWNER can cancel a stale SENDING claim", opsSrc.includes("cancelStuckEsignSend") && workspaceSrc.includes("Cancel stuck e-sign send"));
const createdAudit = opsSrc.slice(
  opsSrc.indexOf('action: "esign_request_created"'),
  opsSrc.indexOf('action: "esign_request_created"') + 500,
);
check("esign_request_created audit omits signerEmail", createdAudit.includes("esign_request_created") && !createdAudit.includes("signerEmail"));
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
resetEsignProviderCache();
check("Fake adapter is blocked when NODE_ENV=production", isFakeEsignAdapterEnabled() === false);
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
resetEsignProviderCache();
check("Fake adapter returns after NODE_ENV restore", isFakeEsignAdapterEnabled() === true && getFakeEsignProvider()?.id === "fake");
check("Webhook route returns the official Hello API Event Received body", routeSrc.includes(ESIGN_WEBHOOK_HELLO));
check("Webhook path is exact", isEsignWebhookPath("/api/esign/webhook") && ESIGN_WEBHOOK_PATH === "/api/esign/webhook" && !isEsignWebhookPath("/api/esign/webhook/extra"));
check("Auth proxy allows the e-sign webhook without a session", proxySrc.includes("isEsignWebhookPath") && proxySrc.includes("api/esign/webhook"));
check("Fake adapter never fetches api.hellosign.com", !fakeSrc.includes("api.hellosign.com"));
check("OWNER Send exists and stays owner-gated", opsSrc.includes("sendAgreementForEsign") && opsSrc.includes("requireOwnerForCompletion"));
check("Webhook completion binds the exact version id", opsSrc.includes("completeAgreementFromEsignWebhook") && opsSrc.includes("not bound to this exact business, agreement, and version"));
check("Legal-review warning and manual upload stay in the workspace", workspaceSrc.includes("Acknowledge attorney-review recommendation") && workspaceSrc.includes("Upload signed PDF"));
check("OWNER Send control is in the workspace", workspaceSrc.includes("Send locked version for e-sign"));
check("This process uses the fake adapter", resolveEsignProviderStatus() === "PROVIDER_READY" && getFakeEsignProvider()?.id === "fake");
check(
  "Form PROVIDER_READY stays webhook-only even when connected",
  (() => {
    try {
      normalizeCompletionMode("PROVIDER_READY", "PROVIDER_READY");
      return false;
    } catch (error) {
      return error instanceof EsignBoundaryError && error.message === ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE;
    }
  })(),
);

const officialHash = dropboxSignEventHash(getFakeEsignWebhookKey(), "1348177752", "signature_request_sent");
check("Official sample event_time+event_type hashes to 64 hex chars", /^[0-9a-f]{64}$/.test(officialHash));

try {
  console.log("\nDB — OWNER Send, webhook bind, forged/replay/tenant/concurrent/failure");
  const fake = getFakeEsignProvider();
  if (!fake) throw new Error("Fake e-sign adapter is required for these proofs.");
  fake.reset();

  const ownerUser = await prisma.user.create({
    data: { name: "Pat Owner", email: `owner-esign-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-esign-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const otherUser = await prisma.user.create({
    data: { name: "Oli Other", email: `other-esign-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Esign", slug: `alpha-esign-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Esign", slug: `beta-esign-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, {
    userId: ownerUser.id,
    businessName: businessA.name,
  });
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, {
    userId: adminUser.id,
    businessName: businessA.name,
  });
  const ownerB = makeAccess(businessB.id, "OWNER", otherMem.id, {
    userId: otherUser.id,
    businessName: businessB.name,
  });

  const provider = new MemoryStorageProvider();
  const storage = { db: prisma, provider, bucketName: "tbbt-esign-test", defaultLimitBytes: 5_000_000 };
  await ensureBusinessStorageAccount(prisma, businessA.id, {
    bucketName: "tbbt-esign-test",
    defaultLimitBytes: 5_000_000,
  });
  await ensureBusinessStorageAccount(prisma, businessB.id, {
    bucketName: "tbbt-esign-test",
    defaultLimitBytes: 5_000_000,
  });

  const highRisk = await createAgreement(prisma, adminA, {
    agreementType: "CUSTOMER_AGREEMENT",
    title: "High-risk legal warning",
  });
  await saveAgreementAnswers(prisma, adminA, {
    agreementId: highRisk.id,
    answers: {
      counterparty: "Jordan Client",
      purpose: "Remodel",
      scope: "Vanity",
      payment: "Fixed",
    },
  });
  await generateAgreementDraft(prisma, adminA, {
    agreementId: highRisk.id,
    businessName: businessA.name,
  });
  await markAgreementOwnerReviewed(prisma, ownerA, { agreementId: highRisk.id });
  await expectError("High-risk OWNER Send still requires legal-review acknowledgment", () => {
    return sendAgreementForEsign(prisma, ownerA, {
      agreementId: highRisk.id,
      signerName: "Jordan Client",
      signerEmail: "jordan@example.com",
      sendAttemptKey: randomUUID(),
    });
  }, (error) => error instanceof BusinessProtectionError);
  await acknowledgeAgreementLegalReview(prisma, ownerA, {
    agreementId: highRisk.id,
    acknowledged: true,
  });
  const warned = await prisma.businessAgreement.findUniqueOrThrow({ where: { id: highRisk.id } });
  check("Legal-review acknowledgment still moves high-risk to READY", warned.lifecycleStatus === "READY");

  const failure = await readyNda(prisma, ownerA, "Provider failure NDA");
  fake.failNextSignatureRequest();
  const beforeFail = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: failure.id },
    include: { versions: true },
  });
  await expectError("Provider failure refuses OWNER Send", () => {
    return sendAgreementForEsign(prisma, ownerA, {
      agreementId: failure.id,
      signerName: "Pat Counterparty",
      signerEmail: "pat@example.com",
      sendAttemptKey: randomUUID(),
    });
  }, (error) => error instanceof BusinessProtectionError);
  const afterFail = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: failure.id },
    include: { versions: true },
  });
  check(
    "Provider failure leaves the version unlocked and READY",
    afterFail.lifecycleStatus === "READY" &&
      afterFail.signingMode === "NOT_CONNECTED" &&
      afterFail.versions.every((row) => row.representationStatus === "DRAFT" && !row.lockedAt) &&
      beforeFail.versions[0].draftContent === afterFail.versions[0].draftContent,
  );

  await expectError("ADMIN cannot OWNER-Send for e-sign", () => {
    return sendAgreementForEsign(prisma, adminA, {
      agreementId: failure.id,
      signerName: "Pat Counterparty",
      signerEmail: "pat@example.com",
      sendAttemptKey: randomUUID(),
    });
  }, (error) => error instanceof ForbiddenError);

  const timeoutNda = await readyNda(prisma, ownerA, "Create-then-timeout NDA");
  const timeoutKey = randomUUID();
  const createsBeforeTimeout = fake.createdRequestCount();
  fake.createThenThrow();
  await expectError("Create-then-timeout keeps the SENDING claim", () => {
    return sendAgreementForEsign(prisma, ownerA, {
      agreementId: timeoutNda.id,
      signerName: "Pat Counterparty",
      signerEmail: "pat@example.com",
      sendAttemptKey: timeoutKey,
    });
  }, (error) => error instanceof BusinessProtectionError && error.message === ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE);
  const afterTimeout = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: timeoutNda.id },
  });
  const timeoutRequestId = fake.lastCreatedRequestId();
  check(
    "Ambiguous create leaves SENT/SENDING with no stored request id",
    afterTimeout.lifecycleStatus === "SENT" &&
      afterTimeout.signingMode === "SENDING" &&
      !afterTimeout.esignSignatureRequestId &&
      Boolean(afterTimeout.esignSendingClaimedAt) &&
      fake.createdRequestCount() === createsBeforeTimeout + 1,
  );
  await expectError("Same-key retry after unknown create does not send again", () => {
    return sendAgreementForEsign(prisma, ownerA, {
      agreementId: timeoutNda.id,
      signerName: "Pat Counterparty",
      signerEmail: "pat@example.com",
      sendAttemptKey: timeoutKey,
    });
  }, (error) => error instanceof BusinessProtectionError && error.message === ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE);
  check(
    "Create-then-throw retry does not create a second provider request",
    fake.createdRequestCount() === createsBeforeTimeout + 1,
  );
  await expectError("Fresh SENDING claim cannot be canceled yet", () => {
    return cancelStuckEsignSend(prisma, ownerA, { agreementId: timeoutNda.id });
  }, (error) => error instanceof BusinessProtectionError && error.message === ESIGN_STALE_SEND_NOT_READY_MESSAGE);
  await prisma.businessAgreement.update({
    where: { id: timeoutNda.id },
    data: { esignSendingClaimedAt: new Date(Date.now() - (ESIGN_STALE_SEND_MINUTES + 1) * 60_000) },
  });
  const cancelled = await cancelStuckEsignSend(prisma, ownerA, { agreementId: timeoutNda.id });
  check(
    "OWNER cancel clears a stale SENDING claim",
    cancelled.agreement.signingMode === "NOT_CONNECTED" &&
      !cancelled.agreement.completionAttemptKey &&
      !cancelled.agreement.esignSendingClaimedAt,
  );
  const cancelAudit = await prisma.businessProtectionAuditLog.findFirst({
    where: { agreementId: timeoutNda.id, action: "esign_send_claim_cancelled" },
    orderBy: { changedAt: "desc" },
  });
  check(
    "Stuck-send cancel is audited with the Dropbox Sign warning",
    Boolean(cancelAudit?.newValue) && String(cancelAudit.newValue).includes(ESIGN_CANCEL_STUCK_SEND_WARNING),
  );

  const bindNda = await readyNda(prisma, ownerA, "Webhook binds stuck SENDING");
  const bindKey = randomUUID();
  fake.createThenThrow();
  await expectError("Stuck bind send stays unknown", () => {
    return sendAgreementForEsign(prisma, ownerA, {
      agreementId: bindNda.id,
      signerName: "Pat Counterparty",
      signerEmail: "pat@example.com",
      sendAttemptKey: bindKey,
    });
  }, (error) => error instanceof BusinessProtectionError && error.message === ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE);
  const bindRequestId = fake.lastCreatedRequestId();
  const bindPayload = fake.buildSignedWebhookPayload({
    requestId: bindRequestId,
    metadata: {
      businessId: businessA.id,
      agreementId: bindNda.id,
      versionId: (await prisma.businessAgreementVersion.findFirstOrThrow({
        where: { agreementId: bindNda.id, representationStatus: "SENT" },
      })).id,
      attemptKey: bindKey,
      actorMembershipId: ownerMem.id,
    },
  });
  const bindResult = await dispatchEsignWebhook(prisma, { rawJson: bindPayload.rawJson, storage });
  const bound = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: bindNda.id },
    include: { versions: true },
  });
  check(
    "Authenticated webhook binds request id onto a matching SENDING claim",
    bindResult.applied === true &&
      bindResult.status === 200 &&
      bound.signingMode === "PROVIDER_READY" &&
      bound.esignSignatureRequestId === bindRequestId &&
      bound.signedVersionId &&
      bound.versions.some((row) => row.esignSignatureRequestId === bindRequestId),
  );

  const sent = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: failure.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  check("OWNER Send locks the exact version", sent.version.representationStatus === "SENT" && Boolean(sent.version.lockedAt));
  check("OWNER Send records PROVIDER_READY without completing", sent.agreement.lifecycleStatus === "SENT" && sent.agreement.signingMode === "PROVIDER_READY" && !sent.agreement.signedVersionId);
  const persistedSend = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: failure.id },
    include: { versions: true },
  });
  const persistedVersion = persistedSend.versions.find((row) => row.id === sent.version.id);
  check(
    "OWNER Send persists signature_request_id on the business, agreement, and version",
    Boolean(sent.requestId) &&
      persistedSend.esignSignatureRequestId === sent.requestId &&
      persistedVersion?.esignSignatureRequestId === sent.requestId,
  );
  const lockedText = sent.version.draftContent;

  await saveAgreementDraftContent(prisma, ownerA, {
    agreementId: failure.id,
    draftContent: `${lockedText}\n\nLater edit must not rewrite the sent copy.`,
  });
  const afterEdit = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: failure.id },
    include: { versions: { orderBy: { versionNumber: "asc" } } },
  });
  const sentCopy = afterEdit.versions.find((row) => row.id === sent.version.id);
  const laterDraft = afterEdit.versions.find((row) => row.id === afterEdit.currentDraftVersionId);
  check("Later edit opens a replacement draft", laterDraft?.id !== sent.version.id && laterDraft?.representationStatus === "DRAFT");
  check("Locked sent version text is unchanged after the later edit", sentCopy?.draftContent === lockedText);

  const forged = fake.buildSignedWebhookPayload({ requestId: sent.requestId, forged: true });
  const forgedResult = await dispatchEsignWebhook(prisma, {
    rawJson: forged.rawJson,
    storage,
  });
  check("Forged webhook is rejected", forgedResult.reason === "invalid_signature" && forgedResult.status === 400 && forgedResult.applied === false && forgedResult.hello === false);
  const afterForged = await prisma.businessAgreement.findUniqueOrThrow({ where: { id: failure.id } });
  check(
    "Forged webhook does not complete the agreement",
    !afterForged.signedVersionId &&
      afterForged.lifecycleStatus !== "COMPLETE" &&
      afterForged.lifecycleStatus !== "EXTERNAL_COMPLETE",
  );

  const tenantSwap = fake.buildSignedWebhookPayload({
    requestId: sent.requestId,
    metadata: {
      businessId: businessB.id,
      agreementId: failure.id,
      versionId: sent.version.id,
      attemptKey: sent.agreement.completionAttemptKey ?? "",
      actorMembershipId: ownerMem.id,
    },
  });
  const tenantResult = await dispatchEsignWebhook(prisma, {
    rawJson: tenantSwap.rawJson,
    storage,
  });
  check(
    "Cross-tenant webhook metadata is refused with 200 Hello",
    tenantResult.applied === false &&
      tenantResult.status === 200 &&
      tenantResult.hello === true &&
      (tenantResult.reason === "tenant_mismatch" || tenantResult.reason === "invalid_payload"),
  );

  const otherReady = await readyNda(prisma, ownerB, "Beta NDA");
  const otherSend = await sendAgreementForEsign(prisma, ownerB, {
    agreementId: otherReady.id,
    signerName: "Beta Signer",
    signerEmail: "beta@example.com",
    sendAttemptKey: randomUUID(),
  });
  const stolen = fake.buildSignedWebhookPayload({
    requestId: otherSend.requestId,
    metadata: {
      businessId: businessA.id,
      agreementId: failure.id,
      versionId: sent.version.id,
      attemptKey: sent.agreement.completionAttemptKey ?? "",
      actorMembershipId: ownerMem.id,
    },
  });
  const stolenResult = await dispatchEsignWebhook(prisma, {
    rawJson: stolen.rawJson,
    storage,
  });
  const afterStolen = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: failure.id },
  });
  check(
    "Swap of tenant B request id onto tenant A metadata is refused under one valid event_hash",
    stolenResult.applied === false &&
      stolenResult.reason === "request_mismatch" &&
      stolenResult.status === 200 &&
      stolenResult.hello === true,
  );
  check(
    "Swapped request id does not complete agreement A",
    !afterStolen.signedVersionId &&
      afterStolen.lifecycleStatus !== "COMPLETE" &&
      afterStolen.lifecycleStatus !== "EXTERNAL_COMPLETE" &&
      afterStolen.esignSignatureRequestId === sent.requestId,
  );

  const good = fake.buildSignedWebhookPayload({ requestId: sent.requestId });
  const applied = await dispatchEsignWebhook(prisma, {
    rawJson: good.rawJson,
    storage,
  });
  check("Verified webhook completes the sent version", applied.applied === true && applied.hello === true && applied.status === 200);
  const completed = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: failure.id },
    include: { versions: true, vaultRecord: true },
  });
  const signed = completed.versions.find((row) => row.id === completed.signedVersionId);
  check("Signed version is the exact sent version", completed.signedVersionId === sent.version.id && signed?.representationStatus === "SIGNED_FINAL");
  check("Signed version text was not rewritten by the later draft", signed?.draftContent === lockedText);
  check("Provider signed PDF is stored on the vault record", Boolean(completed.vaultRecord?.storedAssetId) && completed.vaultRecord.notes.includes(PROVIDER_SIGNED_DOCUMENT_NOTE));
  const signedPdf = fake.getRequest(sent.requestId)?.signedPdf ?? Buffer.from("");
  const stored = completed.vaultRecord?.storedAssetId
    ? await prisma.storedAsset.findUniqueOrThrow({ where: { id: completed.vaultRecord.storedAssetId } })
    : null;
  check("Stored asset stays private to this business", stored?.businessId === businessA.id && stored?.visibility === "PRIVATE");
  check(
    "Fake signed PDF still contains the sent version id",
    signedPdf.includes(sent.version.id) &&
      lockedText.split("\n").every((line) => !line || signedPdf.includes(line)),
  );
  check("Provider signed PDF is a valid PDF with xref and trailer", esignPdfLooksValid(signedPdf));

  const replay = await dispatchEsignWebhook(prisma, {
    rawJson: good.rawJson,
    storage,
  });
  check("Replay webhook is idempotent", replay.reason === "already_applied" && replay.status === 200 && replay.applied === false && replay.hello === true);
  const afterReplay = await prisma.businessAgreementCompletionClaim.findMany({
    where: { agreementId: failure.id },
  });
  const signedFinals = await prisma.businessAgreementVersion.findMany({
    where: { agreementId: failure.id, representationStatus: "SIGNED_FINAL" },
  });
  check("Replay does not create a second claim or signed version", afterReplay.length === 1 && signedFinals.length === 1);

  await expectError("Later edits after provider completion cannot rewrite the signed copy", () => {
    return saveAgreementDraftContent(prisma, ownerA, {
      agreementId: failure.id,
      draftContent: "Rewrite the provider-signed deal",
    });
  }, (error) => error instanceof BusinessProtectionError);

  await expectError("Form still cannot invent a provider signature", () => {
    return completeAgreementExternally(prisma, ownerA, {
      agreementId: failure.id,
      mode: "PROVIDER_READY",
      completionAttemptKey: randomUUID(),
    });
  }, (error) => error instanceof EsignBoundaryError || error instanceof BusinessProtectionError);

  const manual = await readyNda(prisma, ownerA, "Manual upload still works");
  const signedAuth = await (await import("@/lib/business-protection-ops")).authorizeVaultDocumentUpload(storage, ownerA, {
    originalFilename: "manual-signed.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 32,
  });
  await provider.putObject({
    bucket: signedAuth.account.bucketName,
    key: signedAuth.asset.storageKey,
    body: Buffer.from("%PDF-1.4 manual-signed"),
    contentType: "application/pdf",
  });
  const signedFile = await (await import("@/lib/business-protection-ops")).finalizeVaultDocumentUpload(storage, ownerA, signedAuth.asset.id);
  const uploaded = await completeAgreementExternally(prisma, ownerA, {
    agreementId: manual.id,
    mode: "MANUAL_UPLOAD",
    storedAssetId: signedFile.id,
    completionAttemptKey: randomUUID(),
  });
  check(
    "Manual upload remains available while the adapter is connected",
    uploaded.agreement.lifecycleStatus === "COMPLETE" &&
      uploaded.vault.notes.includes(UPLOADED_SIGNED_DOCUMENT_NOTE),
  );

  const concurrent = await readyNda(prisma, ownerA, "Concurrent webhook NDA");
  const concurrentSend = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: concurrent.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  const concurrentPayload = fake.buildSignedWebhookPayload({ requestId: concurrentSend.requestId });
  const [first, second] = await Promise.all([
    dispatchEsignWebhook(prisma, {
      rawJson: concurrentPayload.rawJson,
      storage,
    }),
    dispatchEsignWebhook(prisma, {
      rawJson: concurrentPayload.rawJson,
      storage,
    }),
  ]);
  const concurrentClaims = await prisma.businessAgreementCompletionClaim.findMany({
    where: { agreementId: concurrent.id },
  });
  const concurrentSigned = await prisma.businessAgreementVersion.findMany({
    where: { agreementId: concurrent.id, representationStatus: "SIGNED_FINAL" },
  });
  check(
    "Concurrent webhooks apply once",
    concurrentClaims.length === 1 &&
      concurrentSigned.length === 1 &&
      [first.reason, second.reason].includes("applied") &&
      [first.reason, second.reason].some((reason) => reason === "already_applied" || reason === "applied"),
  );

  const raceManual = await readyNda(prisma, ownerA, "Webhook vs manual");
  const raceSend = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: raceManual.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  const racePayload = fake.buildSignedWebhookPayload({ requestId: raceSend.requestId });
  const [webhookWin, manualWin] = await Promise.allSettled([
    dispatchEsignWebhook(prisma, {
      rawJson: racePayload.rawJson,
      storage,
    }),
    completeAgreementExternally(prisma, ownerA, {
      agreementId: raceManual.id,
      mode: "EXTERNAL_SIGNATURE",
      completionAttemptKey: randomUUID(),
    }),
  ]);
  const raceClaims = await prisma.businessAgreementCompletionClaim.findMany({
    where: { agreementId: raceManual.id },
  });
  const raceSigned = await prisma.businessAgreementVersion.findMany({
    where: { agreementId: raceManual.id, representationStatus: "SIGNED_FINAL" },
  });
  check("Webhook vs manual completion still produces one claim", raceClaims.length === 1);
  check("Webhook vs manual completion still produces one signed version", raceSigned.length === 1);
  check(
    "One of the concurrent completion paths finishes",
    webhookWin.status === "fulfilled" || manualWin.status === "fulfilled",
  );

  const quota = await readyNda(prisma, ownerA, "Quota replay NDA");
  const quotaSend = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: quota.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  const quotaPdf = fake.getRequest(quotaSend.requestId)?.signedPdf ?? Buffer.from("");
  const readyBefore = await prisma.storedAsset.count({
    where: { businessId: businessA.id, status: "READY", purpose: "BUSINESS_VAULT" },
  });
  const accountBefore = await prisma.businessStorageAccount.findFirstOrThrow({
    where: { businessId: businessA.id },
  });
  const allSigned = fake.buildSignedWebhookPayload({
    requestId: quotaSend.requestId,
    eventType: FAKE_ESIGN_SIGNED_EVENT,
    eventId: `quota-all-signed-${quotaSend.requestId}`,
  });
  const downloadable = fake.buildSignedWebhookPayload({
    requestId: quotaSend.requestId,
    eventType: FAKE_ESIGN_DOWNLOADABLE_EVENT,
    eventId: `quota-downloadable-${quotaSend.requestId}`,
  });
  const quotaFirst = await dispatchEsignWebhook(prisma, { rawJson: allSigned.rawJson, storage });
  const quotaSecond = await dispatchEsignWebhook(prisma, { rawJson: downloadable.rawJson, storage });
  const quotaReplay = await dispatchEsignWebhook(prisma, { rawJson: downloadable.rawJson, storage });
  const readyAfter = await prisma.storedAsset.count({
    where: { businessId: businessA.id, status: "READY", purpose: "BUSINESS_VAULT" },
  });
  const accountAfter = await prisma.businessStorageAccount.findFirstOrThrow({
    where: { businessId: businessA.id },
  });
  check(
    "all_signed + downloadable + replay apply once",
    quotaFirst.applied === true &&
      quotaSecond.reason === "already_applied" &&
      quotaReplay.reason === "already_applied" &&
      quotaSecond.status === 200 &&
      quotaReplay.hello === true,
  );
  check("Replay and event pair do not create extra READY assets", readyAfter === readyBefore + 1);
  check(
    "storageUsedBytes grows by exactly one signed PDF",
    Number(accountAfter.storageUsedBytes) ===
      Number(accountBefore.storageUsedBytes) + quotaPdf.byteLength,
  );

  const raceSendReady = await readyNda(prisma, ownerA, "Concurrent OWNER Send NDA");
  const sharedSendKey = randomUUID();
  const createsBefore = fake.createdRequestCount();
  const leftClient = new PrismaClient({ datasourceUrl: testUrl });
  const rightClient = new PrismaClient({ datasourceUrl: testUrl });
  try {
    const [leftSend, rightSend] = await Promise.allSettled([
      sendAgreementForEsign(leftClient, ownerA, {
        agreementId: raceSendReady.id,
        signerName: "Pat Counterparty",
        signerEmail: "pat@example.com",
        sendAttemptKey: sharedSendKey,
      }),
      sendAgreementForEsign(rightClient, ownerA, {
        agreementId: raceSendReady.id,
        signerName: "Pat Counterparty",
        signerEmail: "pat@example.com",
        sendAttemptKey: sharedSendKey,
      }),
    ]);
    const afterConcurrentSend = await prisma.businessAgreement.findUniqueOrThrow({
      where: { id: raceSendReady.id },
      include: { versions: true },
    });
    const fulfilled = [leftSend, rightSend].filter((row) => row.status === "fulfilled");
    const unknown = [leftSend, rightSend].filter(
      (row) =>
        row.status === "rejected" &&
        row.reason instanceof BusinessProtectionError &&
        row.reason.message === ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE,
    );
    check(
      "Two concurrent OWNER Sends create exactly one provider request",
      fake.createdRequestCount() === createsBefore + 1 &&
        Boolean(afterConcurrentSend.esignSignatureRequestId) &&
        afterConcurrentSend.versions.filter((row) => row.esignSignatureRequestId).length === 1 &&
        fulfilled.length + unknown.length === 2,
    );
    const returnedIds = fulfilled
      .map((row) => row.value.requestId)
      .filter(Boolean);
    check(
      "Concurrent sends share at most the one stored request id",
      returnedIds.every((id) => id === afterConcurrentSend.esignSignatureRequestId),
    );
  } finally {
    await leftClient.$disconnect();
    await rightClient.$disconnect();
  }

  const readyVaultAssets = await prisma.storedAsset.findMany({
    where: { businessId: businessA.id, status: "READY", purpose: "BUSINESS_VAULT" },
  });
  const vaultRows = await prisma.businessVaultRecord.findMany({
    where: { businessId: businessA.id },
    select: { storedAssetId: true },
  });
  const referenced = new Set(vaultRows.map((row) => row.storedAssetId).filter(Boolean));
  check(
    "No orphan READY vault assets remain after replay or lost races",
    readyVaultAssets.every((row) => referenced.has(row.id)),
  );

  const downloadRetry = await readyNda(prisma, ownerA, "Download retry NDA");
  const downloadSend = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: downloadRetry.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  fake.failNextSignedDownload();
  const notReadyPayload = fake.buildSignedWebhookPayload({ requestId: downloadSend.requestId });
  const notReadyResult = await dispatchEsignWebhook(prisma, {
    rawJson: notReadyPayload.rawJson,
    storage,
  });
  const stillSent = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: downloadRetry.id },
  });
  check(
    "Provider download failure returns 503 so Dropbox retries",
    notReadyResult.status === 503 &&
      notReadyResult.hello === false &&
      notReadyResult.reason === "provider_download_failed" &&
      stillSent.lifecycleStatus === "SENT" &&
      !stillSent.signedVersionId,
  );
  const retryDownload = await dispatchEsignWebhook(prisma, {
    rawJson: notReadyPayload.rawJson,
    storage,
  });
  check(
    "Later download retry completes the agreement",
    retryDownload.applied === true && retryDownload.status === 200 && retryDownload.hello === true,
  );

  const demoteNda = await readyNda(prisma, ownerA, "Demoted actor NDA");
  const demoteSend = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: demoteNda.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  const extraOwnerUser = await prisma.user.create({
    data: { name: "Second Owner", email: `owner2-esign-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const extraOwnerMem = await prisma.membership.create({
    data: { userId: extraOwnerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const extraOwnerAccess = makeAccess(businessA.id, "OWNER", extraOwnerMem.id, {
    userId: extraOwnerUser.id,
    businessName: businessA.name,
  });
  await prisma.membership.update({ where: { id: ownerMem.id }, data: { role: "ADMIN" } });
  const demotePayload = fake.buildSignedWebhookPayload({ requestId: demoteSend.requestId });
  const demoteResult = await dispatchEsignWebhook(prisma, { rawJson: demotePayload.rawJson, storage });
  const demotedComplete = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: demoteNda.id },
  });
  check(
    "Demoted OWNER actor still completes a genuine webhook",
    demoteResult.applied === true &&
      demoteResult.status === 200 &&
      demotedComplete.signedVersionId === demoteSend.version.id &&
      demotedComplete.completedByMembershipId === ownerMem.id,
  );

  await prisma.membership.update({ where: { id: ownerMem.id }, data: { role: "OWNER" } });
  const removedNda = await readyNda(prisma, extraOwnerAccess, "Removed actor NDA");
  const removedSend = await sendAgreementForEsign(prisma, extraOwnerAccess, {
    agreementId: removedNda.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  await prisma.membership.update({ where: { id: extraOwnerMem.id }, data: { role: "MEMBER" } });
  const removedPayload = fake.buildSignedWebhookPayload({
    requestId: removedSend.requestId,
    metadata: {
      businessId: businessA.id,
      agreementId: removedNda.id,
      versionId: removedSend.version.id,
      attemptKey: removedSend.agreement.completionAttemptKey ?? "",
      actorMembershipId: `removed-owner-${randomUUID()}`,
    },
  });
  const removedResult = await dispatchEsignWebhook(prisma, { rawJson: removedPayload.rawJson, storage });
  const removedComplete = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: removedNda.id },
  });
  check(
    "Removed OWNER actor falls back to a current OWNER instead of dropping the webhook",
    removedResult.applied === true &&
      removedResult.status === 200 &&
      removedComplete.signedVersionId === removedSend.version.id &&
      removedComplete.completedByMembershipId === ownerMem.id,
  );

  const neverOwner = await readyNda(prisma, ownerA, "Never-owner actor NDA");
  const neverSend = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: neverOwner.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  const foreignActorPayload = fake.buildSignedWebhookPayload({
    requestId: neverSend.requestId,
    metadata: {
      businessId: businessA.id,
      agreementId: neverOwner.id,
      versionId: neverSend.version.id,
      attemptKey: neverSend.agreement.completionAttemptKey ?? "",
      actorMembershipId: otherMem.id,
    },
  });
  const foreignActorResult = await dispatchEsignWebhook(prisma, {
    rawJson: foreignActorPayload.rawJson,
    storage,
  });
  const neverComplete = await prisma.businessAgreement.findUniqueOrThrow({
    where: { id: neverOwner.id },
  });
  check(
    "Webhook actor OWNER check falls back only within the bound business",
    foreignActorResult.applied === true &&
      neverComplete.completedByMembershipId === ownerMem.id &&
      neverComplete.signedVersionId === neverSend.version.id,
  );

  await expectError("Foreign owner cannot send this tenant's agreement", () => {
    return sendAgreementForEsign(prisma, ownerB, {
      agreementId: failure.id,
      signerName: "Stolen",
      signerEmail: "stolen@example.com",
      sendAttemptKey: randomUUID(),
    });
  }, (error) => error instanceof Error);

  check("No real Dropbox Sign request id was created", ![sent.requestId, concurrentSend.requestId, otherSend.requestId, quotaSend.requestId].some((id) => !String(id).startsWith("fake_sr_")));
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nAll business-protection-esign checks passed."
    : `\n${failures} business-protection-esign check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
