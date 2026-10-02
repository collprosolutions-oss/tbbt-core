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
  BusinessProtectionError,
} = await import("@/lib/business-protection-ops");

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
check("Live adapter uses official send and files paths", dropboxSrc.includes(DROPBOX_SIGN_API_ORIGIN) && dropboxSrc.includes(DROPBOX_SIGN_SEND_PATH) && dropboxSrc.includes("/v3/signature_request/files"));
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

  const sent = await sendAgreementForEsign(prisma, ownerA, {
    agreementId: failure.id,
    signerName: "Pat Counterparty",
    signerEmail: "pat@example.com",
    sendAttemptKey: randomUUID(),
  });
  check("OWNER Send locks the exact version", sent.version.representationStatus === "SENT" && Boolean(sent.version.lockedAt));
  check("OWNER Send records PROVIDER_READY without completing", sent.agreement.lifecycleStatus === "SENT" && sent.agreement.signingMode === "PROVIDER_READY" && !sent.agreement.signedVersionId);
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
    contentSha256: forged.contentSha256,
    storage,
  });
  check("Forged webhook is rejected", forgedResult.reason === "invalid_signature" && forgedResult.status === 400 && forgedResult.applied === false);
  const afterForged = await prisma.businessAgreement.findUniqueOrThrow({ where: { id: failure.id } });
  check("Forged webhook does not complete the agreement", afterForged.lifecycleStatus === "DRAFT" && !afterForged.signedVersionId);

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
    contentSha256: tenantSwap.contentSha256,
    storage,
  });
  check(
    "Cross-tenant webhook metadata is refused",
    tenantResult.applied === false &&
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
    contentSha256: stolen.contentSha256,
    storage,
  });
  check(
    "Webhook cannot bind another tenant's request onto this agreement",
    stolenResult.applied === false &&
      (stolenResult.reason === "tenant_mismatch" || stolenResult.reason === "request_mismatch" || stolenResult.reason === "invalid_payload"),
  );

  const good = fake.buildSignedWebhookPayload({ requestId: sent.requestId });
  const applied = await dispatchEsignWebhook(prisma, {
    rawJson: good.rawJson,
    contentSha256: good.contentSha256,
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
  check("Fake signed PDF still contains the sent version id", signedPdf.includes(sent.version.id) && signedPdf.includes(lockedText));

  const replay = await dispatchEsignWebhook(prisma, {
    rawJson: good.rawJson,
    contentSha256: good.contentSha256,
    storage,
  });
  check("Replay webhook is idempotent", replay.reason === "already_applied" && replay.status === 200 && replay.applied === false);
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
      contentSha256: concurrentPayload.contentSha256,
      storage,
    }),
    dispatchEsignWebhook(prisma, {
      rawJson: concurrentPayload.rawJson,
      contentSha256: concurrentPayload.contentSha256,
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
      contentSha256: racePayload.contentSha256,
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

  await expectError("Foreign owner cannot send this tenant's agreement", () => {
    return sendAgreementForEsign(prisma, ownerB, {
      agreementId: failure.id,
      signerName: "Stolen",
      signerEmail: "stolen@example.com",
      sendAttemptKey: randomUUID(),
    });
  }, (error) => error instanceof Error);

  check("No real Dropbox Sign request id was created", ![sent.requestId, concurrentSend.requestId, otherSend.requestId].some((id) => !String(id).startsWith("fake_sr_")));
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
