/**
 * Estimate send-state alignment and public DRAFT denial.
 *
 * Proves list/builder Send UI uses the same draftEstimateSendError()
 * ruleset as sendEstimate(), customer token/print/PDF cannot render DRAFT,
 * SENT/APPROVED public documents still load, approval stays SENT+version
 * bound, and legacy SENT/no-version is remediable only by Return to Draft
 * → Send.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-safety-alignment.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_safety_alignment_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CUSTOM_QUOTE_DRAFT_MARKER,
  STARTING_AT_DRAFT_MARKER,
  draftEstimateSendError,
  draftEstimateSendState,
  isUnpricedCustomQuoteDraftLine,
  isUnpricedDraftLine,
} = await import("@/lib/request-estimate-draft");
const {
  estimateDocumentPlainText,
  isPublicEstimateDocumentVisible,
  loadEstimateDocumentByToken,
  loadEstimateDocumentForBusiness,
} = await import("@/lib/estimate-document");
const {
  LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE,
  createEstimateVersionSnapshot,
  findCurrentEstimateVersion,
} = await import("@/lib/estimate-version");
const { approveEstimate } = await import("@/app/actions/public-estimate");

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-safety alignment test database.");
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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function formData(entries) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

async function tryApprove(entries) {
  try {
    return await approveEstimate({}, formData(entries));
  } catch {
    return {};
  }
}

async function createPricedDraft(businessId, customerId, input = {}) {
  const unitPrice = input.unitPrice ?? 125;
  const description = input.description ?? "Fixed repair";
  const type = input.type ?? "LABOR";
  const status = input.status ?? "DRAFT";
  const estimate = await prisma.estimate.create({
    data: {
      businessId,
      customerId,
      status,
      total: new Prisma.Decimal(unitPrice),
      publicToken: randomUUID(),
    },
  });
  if (input.skipLine) return estimate;
  await prisma.lineItem.create({
    data: {
      businessId,
      estimateId: estimate.id,
      description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(unitPrice),
      total: new Prisma.Decimal(unitPrice),
      type,
    },
  });
  return prisma.estimate.findUniqueOrThrow({
    where: { id: estimate.id },
    include: { lineItems: true },
  });
}

async function simulateSend(estimateId, businessId) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId, businessId },
      include: { lineItems: { select: { description: true, unitPrice: true } } },
    });
    if (!current) return { ok: false, reason: "missing" };
    const blocked = draftEstimateSendError(current);
    if (blocked) return { ok: false, reason: blocked };
    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) return { ok: false, reason: "not_draft" };
    const version = await createEstimateVersionSnapshot(tx, {
      estimateId,
      businessId,
    });
    return { ok: true, version };
  });
}

const INTERNAL_LEAKS = [
  "panelRate",
  "recommendedAmount",
  "calculatorId",
  "TBBT Calculator Snapshot",
  "unitCost",
  "customerUnitPrice",
  "markupPercent",
];

console.log("\nSTATIC — shared send validation and public DRAFT denial");

const requestDraft = readRepo("src/lib/request-estimate-draft.ts");
const sendAction = readRepo("src/app/actions/estimate.ts");
const publicApprove = readRepo("src/app/actions/public-estimate.ts");
const documentLib = readRepo("src/lib/estimate-document.ts");
const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const listPage = readRepo("src/app/(app)/estimates/page.tsx");
const workspace = readRepo("src/components/estimates/estimates-workspace.tsx");
const sendButton = readRepo("src/components/estimates/send-estimate-button.tsx");
const publicPage = readRepo("src/app/e/[token]/page.tsx");
const publicPrint = readRepo("src/app/(invoice-document)/e/[token]/print/page.tsx");
const publicPdf = readRepo("src/app/(invoice-document)/e/[token]/pdf/route.ts");
const ownerPrint = readRepo("src/app/(invoice-document)/estimates/[estimateId]/print/page.tsx");
const ownerPdf = readRepo("src/app/(invoice-document)/estimates/[estimateId]/pdf/route.ts");
const legacyNotice = readRepo("src/components/estimates/legacy-unversioned-sent-notice.tsx");
const versionLib = readRepo("src/lib/estimate-version.ts");

check(
  "draftEstimateSendState is a projection of draftEstimateSendError",
  requestDraft.includes("export function draftEstimateSendState") &&
    requestDraft.includes("const error = draftEstimateSendError(estimate)") &&
    requestDraft.includes("canSend: error === null"),
);
check(
  "sendEstimate still uses draftEstimateSendError and does not weaken it",
  sendAction.includes("const blocked = draftEstimateSendError(estimate)") &&
    sendAction.includes("const currentBlocked = draftEstimateSendError(current)"),
);
check(
  "list page projects Send state from draftEstimateSendState",
  listPage.includes("draftEstimateSendState") &&
    listPage.includes("sendBlockedReason: draftEstimateSendState(") &&
    workspace.includes("blockedReason={estimate.sendBlockedReason}"),
);
check(
  "builder page projects Send state from draftEstimateSendState",
  ownerPage.includes("draftEstimateSendState") &&
    ownerPage.includes("blockedReason={sendState.error}"),
);
check(
  "Send button disables from blockedReason, not a second ruleset",
  sendButton.includes("blockedReason") &&
    sendButton.includes("const disabled = Boolean(blockedReason)") &&
    !sendButton.includes("lineItems.length === 0") &&
    !sendButton.includes("needsCustomQuotePrices"),
);
check(
  "token loader denies DRAFT via isPublicEstimateDocumentVisible",
  documentLib.includes("export function isPublicEstimateDocumentVisible") &&
    documentLib.includes('return status === "SENT" || status === "APPROVED"') &&
    documentLib.includes("!isPublicEstimateDocumentVisible(estimate.status)"),
);
check(
  "public page/print/PDF all load through the token loader",
  publicPage.includes("loadEstimateDocumentByToken") &&
    publicPrint.includes("loadEstimateDocumentByToken") &&
    publicPdf.includes("loadEstimateDocumentByToken") &&
    !publicPage.includes("loadEstimateDocumentForBusiness") &&
    !publicPrint.includes("loadEstimateDocumentForBusiness"),
);
check(
  "owner preview/PDF stay on the authenticated business loader",
  ownerPrint.includes("requireManagementPageAccess") &&
    ownerPrint.includes("loadEstimateDocumentForBusiness") &&
    ownerPdf.includes("requireManagementPageAccess") &&
    ownerPdf.includes("loadEstimateDocumentForBusiness"),
);
check(
  "owner draft does not present a shareable customer token link",
  ownerPage.includes("This draft is not on the customer link") &&
    ownerPage.includes("{isSent || isApproved ?") &&
    ownerPage.includes("CopyEstimateLinkButton"),
);
check(
  "approval still requires SENT, binds current version, and rejects stale",
  publicApprove.includes('if (estimate.status !== "SENT")') &&
    publicApprove.includes("approvedVersionId: currentVersion.id") &&
    publicApprove.includes("submittedVersionId !== currentVersion.id") &&
    publicApprove.includes("if (!currentVersion)"),
);
check(
  "legacy SENT/no-version owner remediation wording exists",
  versionLib.includes("LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE") &&
    legacyNotice.includes("LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE") &&
    ownerPage.includes("LegacyUnversionedSentNotice") &&
    workspace.includes("LegacyUnversionedSentNotice") &&
    LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE.includes("Return it to Draft and Send again"),
);

console.log("\nPURE — send-state matches server blockers");

const emptyDraft = draftEstimateSendState({ status: "DRAFT", lineItems: [] });
check(
  "no-lines state matches server",
  emptyDraft.canSend === false &&
    emptyDraft.error === "Add at least one line item before sending." &&
    emptyDraft.error === draftEstimateSendError({ status: "DRAFT", lineItems: [] }),
);

const customZero = {
  status: "DRAFT",
  lineItems: [
    { description: `Custom work ${CUSTOM_QUOTE_DRAFT_MARKER}`, unitPrice: 0 },
  ],
};
check(
  "custom quote $0 remains blocked",
  isUnpricedCustomQuoteDraftLine(customZero.lineItems[0]) &&
    draftEstimateSendState(customZero).error ===
      "Enter a price for each custom-quote line before sending." &&
    draftEstimateSendState(customZero).error === draftEstimateSendError(customZero),
);

const materialZero = {
  status: "DRAFT",
  lineItems: [{ description: "Plywood sheet", unitPrice: 0 }],
};
check(
  "non-custom required $0 line remains blocked",
  isUnpricedDraftLine(materialZero.lineItems[0]) &&
    !isUnpricedCustomQuoteDraftLine(materialZero.lineItems[0]) &&
    draftEstimateSendState(materialZero).error ===
      "Enter a price for each line before sending.",
);

const formulaZero = {
  status: "DRAFT",
  lineItems: [
    {
      description: "Wall paneling\nTBBT Calculator Snapshot: {\"calculatorId\":\"decorative-wall-paneling\"}",
      unitPrice: 0,
    },
  ],
};
check(
  "formula/calculator $0 line remains blocked by the same helper",
  draftEstimateSendState(formulaZero).canSend === false &&
    draftEstimateSendState(formulaZero).error ===
      draftEstimateSendError(formulaZero),
);

const pricedFixed = {
  status: "DRAFT",
  lineItems: [{ description: "TV mounting", unitPrice: 185 }],
};
const pricedStarting = {
  status: "DRAFT",
  lineItems: [{ description: `Fence repair ${STARTING_AT_DRAFT_MARKER}`, unitPrice: 450 }],
};
check("properly priced fixed estimate can Send", draftEstimateSendState(pricedFixed).canSend);
check(
  "properly priced starting-at estimate can Send",
  draftEstimateSendState(pricedStarting).canSend &&
    draftEstimateSendState(pricedStarting).error === null,
);
check(
  "isPublicEstimateDocumentVisible is SENT/APPROVED only",
  isPublicEstimateDocumentVisible("DRAFT") === false &&
    isPublicEstimateDocumentVisible("SENT") === true &&
    isPublicEstimateDocumentVisible("APPROVED") === true,
);

try {
  const businessA = await prisma.business.create({
    data: { name: "Safety Alpha", slug: `safety-alpha-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Safety Beta", slug: `safety-beta-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Jordan Rivera", email: "jordan@example.com" },
  });

  console.log("\nDB — public token cannot render DRAFT");
  const draft = await createPricedDraft(businessA.id, customerA.id, {
    description: "Draft cabinet repair with panelRate 12",
    unitPrice: 200,
  });
  const draftBefore = await prisma.estimate.findUniqueOrThrow({
    where: { id: draft.id },
    include: { lineItems: true },
  });
  const draftTokenDoc = await loadEstimateDocumentByToken(draft.publicToken, prisma);
  const draftOwnerDoc = await loadEstimateDocumentForBusiness(draft.id, businessA.id, prisma);
  const draftAfter = await prisma.estimate.findUniqueOrThrow({
    where: { id: draft.id },
    include: { lineItems: true },
  });
  check("DRAFT public token cannot render customer estimate", draftTokenDoc === null);
  check(
    "DRAFT print/PDF cannot render customer document because the shared token loader returns null",
    draftTokenDoc === null &&
      publicPrint.includes("if (!document)") &&
      publicPdf.includes('return new NextResponse("Estimate not found."'),
  );
  check("owner-authenticated preview can still load the DRAFT", Boolean(draftOwnerDoc));
  check(
    "opening the public token does not mutate the DRAFT",
    draftAfter.status === draftBefore.status &&
      draftAfter.total.toString() === draftBefore.total.toString() &&
      draftAfter.updatedAt.getTime() === draftBefore.updatedAt.getTime() &&
      draftAfter.lineItems.length === draftBefore.lineItems.length,
  );

  const draftApprove = await tryApprove({ publicToken: draft.publicToken });
  check(
    "approval still requires SENT",
    (draftApprove.error === "This estimate is not ready to approve." ||
      draftApprove.status !== "APPROVED") &&
      (await prisma.estimate.findUniqueOrThrow({ where: { id: draft.id } })).status === "DRAFT",
  );

  console.log("\nDB — SENT/APPROVED public documents still render");
  const sent = await simulateSend(draft.id, businessA.id);
  check("priced draft can send and snapshot Version 1", sent.ok === true && sent.version?.versionNumber === 1);
  const sentDoc = await loadEstimateDocumentByToken(draft.publicToken, prisma);
  check("SENT public estimate renders", sentDoc?.status === "SENT" && sentDoc.totalLabel === "$200.00");
  check("SENT document binds the current EstimateVersion", sentDoc?.currentVersionId === sent.version.id);
  const sentPlain = estimateDocumentPlainText(sentDoc);
  check(
    "no pricing formulas/rates leak publicly",
    INTERNAL_LEAKS.every((leak) => !sentPlain.includes(leak)) && !sentPlain.includes("panelRate"),
  );

  const staleApprove = await tryApprove({
    publicToken: draft.publicToken,
    estimateVersionId: randomUUID(),
  });
  const stillSent = await prisma.estimate.findUniqueOrThrow({ where: { id: draft.id } });
  check(
    "stale version still rejects",
    stillSent.status === "SENT" &&
      stillSent.approvedVersionId == null &&
      (staleApprove.error == null ||
        staleApprove.error ===
          "This estimate was updated since you opened this page. Refresh to see the latest version before approving."),
  );

  const approve = await tryApprove({
    publicToken: draft.publicToken,
    estimateVersionId: sent.version.id,
  });
  const approvedRow = await prisma.estimate.findUniqueOrThrow({
    where: { id: draft.id },
    include: { versions: true },
  });
  check(
    "approval still binds current EstimateVersion",
    approve.status === "APPROVED" || approvedRow.status === "APPROVED",
  );
  check(
    "approvedVersionId is the version the customer approved",
    approvedRow.status === "APPROVED" && approvedRow.approvedVersionId === sent.version.id,
  );
  const approvedDoc = await loadEstimateDocumentByToken(draft.publicToken, prisma);
  check(
    "APPROVED public estimate still renders",
    approvedDoc?.status === "APPROVED" && approvedDoc.currentVersionId === sent.version.id,
  );

  console.log("\nDB — Return to Draft → edit → Send creates a new version");
  const second = await createPricedDraft(businessA.id, customerA.id, {
    description: "Door latch",
    unitPrice: 80,
  });
  const firstSend = await simulateSend(second.id, businessA.id);
  await prisma.estimate.updateMany({
    where: { id: second.id, businessId: businessA.id, status: "SENT" },
    data: { status: "DRAFT" },
  });
  const afterReturnDoc = await loadEstimateDocumentByToken(second.publicToken, prisma);
  check("public token hides the estimate again after Return to Draft", afterReturnDoc === null);
  const line = await prisma.lineItem.findFirstOrThrow({ where: { estimateId: second.id } });
  await prisma.lineItem.update({
    where: { id: line.id },
    data: { unitPrice: new Prisma.Decimal(95), total: new Prisma.Decimal(95) },
  });
  await prisma.estimate.update({
    where: { id: second.id },
    data: { total: new Prisma.Decimal(95) },
  });
  const secondSend = await simulateSend(second.id, businessA.id);
  check(
    "Return to Draft → edit → Send creates a new version",
    secondSend.ok === true &&
      secondSend.version?.versionNumber === 2 &&
      firstSend.version?.versionNumber === 1,
  );
  const v1 = await prisma.estimateVersion.findUniqueOrThrow({
    where: { id: firstSend.version.id },
  });
  check("Version 1 total is unchanged after re-send", v1.total.toString() === "80");

  console.log("\nDB — legacy SENT/no-version is not auto-approved");
  const legacy = await createPricedDraft(businessA.id, customerA.id, {
    description: "Legacy sent job",
    unitPrice: 300,
    status: "SENT",
  });
  const legacyVersion = await findCurrentEstimateVersion(prisma, legacy.id);
  check("legacy SENT fixture has no EstimateVersion", legacyVersion === null);
  const legacyApprove = await approveEstimate(
    {},
    formData({ publicToken: legacy.publicToken }),
  );
  const legacyAfter = await prisma.estimate.findUniqueOrThrow({ where: { id: legacy.id } });
  check(
    "legacy SENT/no-version is not auto-approved",
    legacyApprove.error === "This estimate is not ready to approve." &&
      legacyAfter.status === "SENT" &&
      legacyAfter.approvedVersionId === null,
  );
  const legacyPublic = await loadEstimateDocumentByToken(legacy.publicToken, prisma);
  check(
    "legacy SENT document can still be viewed after it was sent",
    legacyPublic?.status === "SENT",
  );
  await prisma.estimate.updateMany({
    where: { id: legacy.id, status: "SENT" },
    data: { status: "DRAFT" },
  });
  const legacyResend = await simulateSend(legacy.id, businessA.id);
  check(
    "safe owner remediation is Return to Draft then Send (creates Version 1)",
    legacyResend.ok === true && legacyResend.version?.versionNumber === 1,
  );
  const legacyApproveAfter = await approveEstimate(
    {},
    formData({
      publicToken: legacy.publicToken,
      estimateVersionId: legacyResend.version.id,
    }),
  );
  check(
    "after re-send, normal approval works against Version 1",
    legacyApproveAfter.status === "APPROVED",
  );

  console.log("\nDB — tenant isolation unchanged");
  const cross = await loadEstimateDocumentForBusiness(draft.id, businessB.id, prisma);
  check("other tenant cannot load the owner document by id", cross === null);
  const otherDraft = await createPricedDraft(businessB.id, null, {
    description: "Beta secret",
    unitPrice: 50,
  });
  const otherToken = await loadEstimateDocumentByToken(otherDraft.publicToken, prisma);
  check("other tenant DRAFT token also stays hidden", otherToken === null);
  const aByBToken = await loadEstimateDocumentForBusiness(otherDraft.id, businessA.id, prisma);
  check("tenant A cannot load tenant B draft by id", aByBToken === null);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
  spawnSync("npx", ["prisma", "db", "execute", "--stdin", "--url", testUrl], {
    input: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`,
    encoding: "utf8",
  });
}

if (failures > 0) {
  console.error(`\n${failures} estimate-safety alignment check(s) failed.`);
  process.exit(1);
}

console.log("\nAll estimate-safety alignment checks passed.");
