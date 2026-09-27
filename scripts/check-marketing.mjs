/**
 * Marketing Studio domain + isolation verification.
 *
 * Imports the REAL production helpers from src/lib/marketing.ts,
 * src/lib/marketing-ops.ts, and src/lib/marketing-data.ts.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-marketing.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  CHANNELS_DISCONNECTED_MESSAGE,
  PERFORMANCE_UNAVAILABLE_MESSAGE,
  LEAD_SOURCE_UNTRACKED_MESSAGE,
  CALENDAR_INTERNAL_MESSAGE,
  buildMarketingReviewPacket,
  canDownloadMarketingReviewPacket,
  canExportCreatorPackage,
  canSelectPhotoForMarketing,
  CREATOR_PACKAGE_LIMITS_MESSAGE,
  FLOW_VEO_DISCONNECTED_MESSAGE,
  INVALID_STORYBOARD_MESSAGE,
  jobMarketingReadiness,
  marketingAiAssistAvailable,
  marketingReviewPacketDraftLabel,
  marketingReviewPacketFilename,
  marketingReviewPacketTextLabel,
  nextContentStatus,
  nextReviewPacketDownload,
  OWNER_REVIEW_PACKET_MESSAGE,
  OWNER_STUDIO_APPROVAL_MESSAGE,
  PAID_ADS_DISCONNECTED_MESSAGE,
  parseMarketingArea,
  parseRequiredStoryboard,
  parseShotList,
  parseStoryboard,
  PHOTO_PERMISSION_REVOKED_MESSAGE,
  REVIEW_PACKET_APPROVED_TEXT_LABEL,
  REVIEW_PACKET_DRAFT_PACKAGE_LABEL,
  REVIEW_PACKET_DRAFT_TEXT_LABEL,
  REVIEW_PACKET_LIMITS_MESSAGE,
} = await import("@/lib/marketing");
const { draftMarketingContent, draftMarketingStudioPackage } = await import("@/lib/marketing-draft");
const {
  createMarketingContent,
  createMarketingStudioPackage,
  downloadMarketingReviewPacket,
  exportMarketingCreatorPackage,
  grantJobPhotoMarketingPermission,
  MarketingError,
  revokeJobPhotoMarketingPermission,
  setMarketingContentPlannedFor,
  advanceMarketingContentStatus,
  updateMarketingStudioPackage,
} = await import("@/lib/marketing-ops");
const { loadMarketingSource } = await import("@/lib/marketing-data");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_studio_test";
const parsed = new URL(baseUrl);
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
  console.error("Failed to push schema for marketing test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  console.log("\nSTATIC — Marketing domain helpers");
  check("Invalid area falls back to overview", parseMarketingArea("reviews") === "overview");
  check("Private photo cannot be selected", !canSelectPhotoForMarketing({ marketingPermissionStatus: "PRIVATE" }));
  check("Approved photo can be selected", canSelectPhotoForMarketing({ marketingPermissionStatus: "APPROVED" }));
  check("Job with private-only photos needs permission", jobMarketingReadiness({ photoCount: 2, approvedPhotoCount: 0 }) === "needs_permission");
  check("Job with an approved photo is ready", jobMarketingReadiness({ photoCount: 2, approvedPhotoCount: 1 }) === "ready");
  check("DRAFT advances to READY_FOR_REVIEW", nextContentStatus("DRAFT") === "READY_FOR_REVIEW");
  check("READY_FOR_REVIEW advances to APPROVED", nextContentStatus("READY_FOR_REVIEW") === "APPROVED");
  check("APPROVED has no next publish state", nextContentStatus("APPROVED") === null);
  check("AI assist is not enabled in this step", marketingAiAssistAvailable() === false);
  const marketingDataSrc = readFileSync(new URL("../src/lib/marketing-data.ts", import.meta.url), "utf8");
  const generatePanelSrc = readFileSync(new URL("../src/components/marketing/generate-ai-panel.tsx", import.meta.url), "utf8");
  check(
    "Ordinary Marketing page load does not invoke AI tasks",
    !marketingDataSrc.includes("WithAi") && !marketingDataSrc.includes("runAiTask"),
  );
  check(
    "Marketing Generate AI actions exist and stay DRAFT",
    generatePanelSrc.includes("Generate AI variations") &&
      generatePanelSrc.includes("Generated copy remains DRAFT"),
  );
  const previousAiEnv = process.env.TBBT_MARKETING_AI_PROVIDER;
  process.env.TBBT_MARKETING_AI_PROVIDER = "openai";
  check(
    "Env string does not claim a connected provider",
    marketingAiAssistAvailable() === false &&
      draftMarketingContent({ contentType: "GENERAL_POST", businessName: "CollPro" }).mode === "TEMPLATE",
  );
  if (previousAiEnv == null) delete process.env.TBBT_MARKETING_AI_PROVIDER;
  else process.env.TBBT_MARKETING_AI_PROVIDER = previousAiEnv;
  check("FOUNDER_PAGE_KEYS includes marketing", FOUNDER_PAGE_KEYS.includes("marketing"));
  check("Marketing has 4 KPI cards", KPI_CARD_COUNTS.marketing === 4);
  check(
    "Marketing founder regions match the implemented boxes",
    FOUNDER_REGIONS.marketing.map((region) => region.id).join(",") ===
      "summary,nav,opportunities,content,calendar,rail,page",
  );
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Marketing nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/marketing"));
  check("Marketing nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/marketing"));
  check("Marketing nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/marketing"));
  check("MEMBER does not have MANAGE_MARKETING", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MARKETING));
  const studioDraft = draftMarketingStudioPackage(
    {
      contentType: "COMPLETED_JOB",
      businessName: "CollPro",
      workPerformed: "faucet repair",
      city: "Reno",
      photoStage: "AFTER",
      photoCount: 1,
    },
    ["photo-1"],
  );
  check("Studio draft has three storyboard beats", studioDraft.storyboard.length === 3);
  check("Studio draft has a shot list", studioDraft.shotList.length === 3 && studioDraft.shotList[0].photoId === "photo-1");
  check("Studio draft hashtags come from recorded city and work", studioDraft.hashtags.includes("#Reno") && studioDraft.hashtags.includes("#faucetrepair"));
  check("Studio draft does not claim Flow/Veo", studioDraft.flowVeoConnected === false);
  check("Studio draft does not claim paid ads", studioDraft.paidAdsConnected === false);
  check("Studio draft does not claim social publishing", studioDraft.socialPublishingConnected === false && studioDraft.publishable === false);
  check("Creator package limits mention no posting", CREATOR_PACKAGE_LIMITS_MESSAGE.includes("will not post"));
  check("Flow/Veo disclaimer is exact", FLOW_VEO_DISCONNECTED_MESSAGE.includes("not connected"));
  check("Paid ads disclaimer is exact", PAID_ADS_DISCONNECTED_MESSAGE.includes("not connected"));
  const studioFormSrc = readFileSync(new URL("../src/components/marketing/create-content-form.tsx", import.meta.url), "utf8");
  const studioOpsSrc = readFileSync(new URL("../src/lib/marketing-ops.ts", import.meta.url), "utf8");
  check(
    "Studio form stays a handoff and does not claim Flow/Veo or posting",
    studioFormSrc.includes("CREATOR_PACKAGE_LIMITS_MESSAGE") &&
      !studioFormSrc.includes("Veo") &&
      !studioFormSrc.includes("publish to"),
  );
  check(
    "Revoke is allowed while a photo is attached",
    !studioOpsSrc.includes("Remove this photo from marketing content before revoking permission."),
  );
  check("Owner approval message is exact", OWNER_STUDIO_APPROVAL_MESSAGE.includes("OWNER role"));
  check("Storyboard parser keeps headings", parseStoryboard('[{"heading":"Hook","visual":"Photo","narration":"Fact"}]')[0].heading === "Hook");
  check("Shot list parser keeps order", parseShotList('[{"order":2,"shot":"Hero","purpose":"Proof"}]')[0].order === 2);
  check("Write-path storyboard rejects invalid JSON", parseRequiredStoryboard("{not-json") === null);
  check("Write-path storyboard rejects a non-array", parseRequiredStoryboard("{}") === null);
  check("Unapproved package cannot export", canExportCreatorPackage({ status: "DRAFT", photos: [{ approved: true }] }) === false);
  check("OWNER can download a review packet", canDownloadMarketingReviewPacket({ role: "OWNER" }) === true);
  check("ADMIN cannot download a review packet", canDownloadMarketingReviewPacket({ role: "ADMIN" }) === false);
  check("MEMBER cannot download a review packet", canDownloadMarketingReviewPacket({ role: "MEMBER" }) === false);
  check("Draft package label is explicit", marketingReviewPacketDraftLabel("DRAFT") === REVIEW_PACKET_DRAFT_PACKAGE_LABEL);
  check("Ready-for-review package is still labeled not approved", marketingReviewPacketDraftLabel("READY_FOR_REVIEW").includes("not approved"));
  check("Approved package label is Approved", marketingReviewPacketDraftLabel("APPROVED") === "Approved");
  check("Draft text is labeled not approved", marketingReviewPacketTextLabel("DRAFT") === REVIEW_PACKET_DRAFT_TEXT_LABEL);
  check("Approved text label is exact", marketingReviewPacketTextLabel("APPROVED") === REVIEW_PACKET_APPROVED_TEXT_LABEL);
  const reviewPacketPreview = buildMarketingReviewPacket({
    title: "Reno faucet review",
    status: "DRAFT",
    caption: "Recorded faucet repair only.",
    hashtags: "Reno faucetrepair",
    storyboardJson: JSON.stringify([{ heading: "Hook", visual: "After still", narration: "Fact" }]),
    shotListJson: JSON.stringify([
      { order: 1, shot: "Hero", purpose: "Proof", photoId: "approved-1" },
      { order: 2, shot: "Private still", purpose: "Must drop", photoId: "private-1" },
    ]),
    photos: [
      {
        id: "approved-1",
        url: "https://example.test/approved.jpg",
        stage: "AFTER",
        marketingPermissionStatus: "APPROVED",
      },
      {
        id: "private-1",
        url: "https://example.test/private.jpg",
        stage: "BEFORE",
        marketingPermissionStatus: "PRIVATE",
      },
    ],
  });
  check("Review packet kind is TBBT_MARKETING_REVIEW_PACKET", reviewPacketPreview.kind === "TBBT_MARKETING_REVIEW_PACKET");
  check("Draft review packet is marked draft", reviewPacketPreview.draft === true && reviewPacketPreview.draftLabel === REVIEW_PACKET_DRAFT_PACKAGE_LABEL);
  check("Draft review packet labels the text as not approved", reviewPacketPreview.approvedText.draft === true && reviewPacketPreview.approvedText.label === REVIEW_PACKET_DRAFT_TEXT_LABEL);
  check("Review packet keeps approved text", reviewPacketPreview.approvedText.caption.includes("faucet repair"));
  check("Review packet keeps the storyboard", reviewPacketPreview.storyboard[0]?.heading === "Hook");
  check("Review packet keeps the shot list", reviewPacketPreview.shotList.length === 2);
  check("Review packet keeps only the permitted photo", reviewPacketPreview.photoReferences.length === 1 && reviewPacketPreview.photoReferences[0].id === "approved-1");
  check("Review packet photo references omit captions", reviewPacketPreview.photoReferences.every((photo) => !("caption" in photo)));
  check("Review packet has no recordedFacts or estimate text", !("recordedFacts" in reviewPacketPreview) && !JSON.stringify(reviewPacketPreview).includes("workPerformed"));
  check("Review packet drops unapproved shot-list photo ids", reviewPacketPreview.shotList[1].photoId === undefined);
  check("Review packet keeps permitted shot-list photo ids", reviewPacketPreview.shotList[0].photoId === "approved-1");
  check(
    "Review packet omitted claim is limited to records the builder actually excludes",
    reviewPacketPreview.omitted.estimateLineItems === true &&
      reviewPacketPreview.omitted.customerRecords === true &&
      reviewPacketPreview.omitted.unapprovedMedia === true &&
      reviewPacketPreview.omitted.photoCaptions === true &&
      !("privateCustomerData" in reviewPacketPreview.omitted),
  );
  check(
    "Review packet does not publish or post",
    reviewPacketPreview.limits.published === false &&
      reviewPacketPreview.limits.posted === false &&
      reviewPacketPreview.limits.socialPublishingConnected === false &&
      reviewPacketPreview.limits.includesEstimateLineItems === false &&
      reviewPacketPreview.limits.includesCustomerRecords === false &&
      reviewPacketPreview.limits.includesUnapprovedMedia === false &&
      reviewPacketPreview.limits.includesPhotoCaptions === false &&
      !("includesPrivateCustomerData" in reviewPacketPreview.limits),
  );
  check("Review packet limits mention omitted records without scanning package text", REVIEW_PACKET_LIMITS_MESSAGE.includes("are not scanned for private details") && REVIEW_PACKET_LIMITS_MESSAGE.includes("will not publish or post"));
  check("Draft review packet filename is labeled draft", marketingReviewPacketFilename("Reno faucet review", "DRAFT") === "reno-faucet-review-review-packet-draft.json");
  check("Approved review packet filename is not labeled draft", marketingReviewPacketFilename("Reno faucet review", "APPROVED") === "reno-faucet-review-review-packet.json");
  const firstDownload = nextReviewPacketDownload(null, {
    packetJson: JSON.stringify(reviewPacketPreview),
    filename: "reno-faucet-review-review-packet-draft.json",
    downloadNonce: "download-1",
  });
  const secondDownload = nextReviewPacketDownload(firstDownload.shouldDownload ? firstDownload.nonce : null, {
    packetJson: JSON.stringify(reviewPacketPreview),
    filename: "reno-faucet-review-review-packet-draft.json",
    downloadNonce: "download-2",
  });
  const repeatSameNonce = nextReviewPacketDownload(secondDownload.shouldDownload ? secondDownload.nonce : null, {
    packetJson: JSON.stringify(reviewPacketPreview),
    filename: "reno-faucet-review-review-packet-draft.json",
    downloadNonce: "download-2",
  });
  check(
    "Two Download clicks with the same packet JSON start two downloads",
    firstDownload.shouldDownload === true &&
      secondDownload.shouldDownload === true &&
      firstDownload.nonce !== secondDownload.nonce,
  );
  check("A repeated nonce does not start a third download", repeatSameNonce.shouldDownload === false);
  const reviewButtonSrc = readFileSync(new URL("../src/components/marketing/review-packet-button.tsx", import.meta.url), "utf8");
  const workspaceSrc = readFileSync(new URL("../src/components/marketing/marketing-workspace.tsx", import.meta.url), "utf8");
  const reviewActionSrc = readFileSync(new URL("../src/app/actions/marketing.ts", import.meta.url), "utf8");
  check(
    "OWNER review packet button is gated on the workspace",
    workspaceSrc.includes("ReviewPacketButton") &&
      workspaceSrc.includes("canDownloadMarketingReviewPacket({ role: viewerRole })"),
  );
  check(
    "Review packet download stays a handoff and does not post",
    reviewButtonSrc.includes("Download draft review packet") &&
      reviewButtonSrc.includes("nextReviewPacketDownload") &&
      reviewActionSrc.includes("downloadNonce") &&
      reviewActionSrc.includes("Nothing was posted.") &&
      !reviewActionSrc.includes("publish to") &&
      !reviewButtonSrc.includes("publish"),
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Marketing", slug: `alpha-mkt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Marketing", slug: `beta-mkt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_MARKETING);
    check("MEMBER MANAGE_MARKETING is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_MARKETING is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.MANAGE_MARKETING);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_MARKETING);
  check("OWNER and ADMIN pass MANAGE_MARKETING", true);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const SENSITIVE_ESTIMATE_TEXT = "GATE-CODE-9981 hide-a-key under the gnome";
  const SENSITIVE_PHOTO_CAPTION = "Ada Homeowner cell 555-0100 at 14 Secret Court";
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      description: SENSITIVE_ESTIMATE_TEXT,
      quantity: 1,
      unitPrice: 80,
      total: 80,
      type: "LABOR",
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: estimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const openJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  const privatePhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "BEFORE",
      url: "https://example.test/private.jpg",
      caption: "Private before",
    },
  });
  const otherPhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "AFTER",
      url: "https://example.test/after.jpg",
      caption: SENSITIVE_PHOTO_CAPTION,
    },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: businessB.id,
      jobId: betaJob.id,
      stage: "AFTER",
      url: "https://example.test/beta.jpg",
    },
  });

  console.log("\nTEST — Completed job opportunity and photo permission");
  const beforeGrant = await loadMarketingSource(prisma, businessA.id);
  check("Completed job appears as a marketing opportunity", beforeGrant.opportunities.some((row) => row.jobId === job.id));
  check("In-progress job is not a marketing opportunity", !beforeGrant.opportunities.some((row) => row.jobId === openJob.id));
  check("New photos default to PRIVATE", privatePhoto.marketingPermissionStatus === "PRIVATE");
  check("Opportunity reports photos need permission", beforeGrant.opportunities.find((row) => row.jobId === job.id)?.readiness === "needs_permission");

  await expectError(
    "Private photo cannot be attached to content",
    () =>
      createMarketingContent(prisma, ownerA, {
        contentType: "COMPLETED_JOB",
        title: "Should fail",
        jobId: job.id,
        photoIds: [privatePhoto.id],
      }),
    (error) => error instanceof MarketingError && /Private/.test(error.message),
  );

  await expectError(
    "MEMBER cannot grant marketing permission",
    () => grantJobPhotoMarketingPermission(prisma, memberA, { photoId: otherPhoto.id }),
    (error) => error instanceof ForbiddenError,
  );

  const approved = await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: otherPhoto.id });
  check("Grant records APPROVED status", approved.marketingPermissionStatus === "APPROVED");
  check("Grant records who approved", approved.marketingPermissionGrantedByMembershipId === ownerMem.id);
  check("Grant records a timestamp", approved.marketingPermissionGrantedAt instanceof Date);

  const afterGrant = await loadMarketingSource(prisma, businessA.id);
  const opportunity = afterGrant.opportunities.find((row) => row.jobId === job.id);
  check("Approved photo can be selected", opportunity?.photos.some((photo) => photo.id === otherPhoto.id && photo.marketingPermissionStatus === "APPROVED"));
  check("Private photo remains unselectable", opportunity?.photos.some((photo) => photo.id === privatePhoto.id && photo.marketingPermissionStatus === "PRIVATE"));
  check("Job is marketing-ready after one approved photo", opportunity?.readiness === "ready");

  console.log("\nTEST — Content draft lifecycle and internal calendar");
  const draft = await createMarketingContent(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Faucet before and after",
    body: "Work completed. No customer contact details.",
    channelIntent: "INSTAGRAM",
    jobId: job.id,
    photoIds: [otherPhoto.id],
    plannedFor: "2026-09-15",
  });
  check("Draft is created as DRAFT", draft.status === "DRAFT");
  check("Draft stores the approved photo only", draft.photos.length === 1 && draft.photos[0].jobPhotoId === otherPhoto.id);
  check(
    "Internal planning date persists on create",
    draft.plannedFor?.getFullYear() === 2026 &&
      draft.plannedFor?.getMonth() === 8 &&
      draft.plannedFor?.getDate() === 15,
  );

  const ready = await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  check("DRAFT → READY_FOR_REVIEW", ready.status === "READY_FOR_REVIEW");
  const approvedContent = await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  check("READY_FOR_REVIEW → APPROVED", approvedContent.status === "APPROVED");
  check("Approval records reviewer", approvedContent.reviewedByMembershipId === ownerMem.id);

  await expectError(
    "APPROVED has no fake PUBLISHED next step",
    () => advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id }),
    (error) => error instanceof MarketingError && /not available/.test(error.message),
  );

  const replanned = await setMarketingContentPlannedFor(prisma, ownerA, {
    contentId: draft.id,
    plannedFor: "2026-09-22",
  });
  check(
    "Internal calendar date can be updated",
    replanned.plannedFor?.getFullYear() === 2026 &&
      replanned.plannedFor?.getMonth() === 8 &&
      replanned.plannedFor?.getDate() === 22,
  );

  const sourceA = await loadMarketingSource(prisma, businessA.id);
  check("Overview counts 1 approved content", sourceA.counts.approved === 1);
  check("No social channel is fabricated", sourceA.channels.connected === false && sourceA.channels.message === CHANNELS_DISCONNECTED_MESSAGE);
  check("No performance is fabricated", sourceA.performance.available === false && sourceA.performance.message === PERFORMANCE_UNAVAILABLE_MESSAGE);
  check("Lead source is not invented", sourceA.leadSources.tracked === false && sourceA.leadSources.message === LEAD_SOURCE_UNTRACKED_MESSAGE);
  check("Calendar disclaimer is exact", CALENDAR_INTERNAL_MESSAGE.includes("will not publish"));
  check("Business A does not see Beta's completed job", sourceA.opportunities.every((row) => row.jobId !== betaJob.id));

  const sourceB = await loadMarketingSource(prisma, businessB.id);
  check("Business B does not see Ada or A's content", sourceB.contents.length === 0 && sourceB.opportunities.every((row) => row.jobId !== job.id));
  check("Business B completed job is only its own", sourceB.opportunities.some((row) => row.jobId === betaJob.id));

  await expectError(
    "Business B cannot grant permission on A's photo",
    () => grantJobPhotoMarketingPermission(prisma, ownerB, { photoId: otherPhoto.id }),
    (error) => error instanceof Error,
  );

  console.log("\nTEST — Creator package workflow, OWNER approval, revoke, export");
  await expectError(
    "Studio package requires an approved photo",
    () =>
      createMarketingStudioPackage(prisma, ownerA, {
        contentType: "COMPLETED_JOB",
        title: "Missing photo",
        jobId: job.id,
      }),
    (error) => error instanceof MarketingError && /photo/.test(error.message),
  );

  const studio = await createMarketingStudioPackage(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Reno faucet story",
    body: "CollPro completed faucet repair in Reno.",
    jobId: job.id,
    photoIds: [otherPhoto.id],
    hashtags: "LocalHandyman Reno",
    storyboardJson: JSON.stringify(studioDraft.storyboard),
    shotListJson: JSON.stringify(studioDraft.shotList),
  });
  check("Studio package starts as DRAFT", studio.status === "DRAFT");
  check("Studio package stores storyboard beats", parseStoryboard(studio.storyboardJson).length === 3);
  check("Studio package stores shot list", parseShotList(studio.shotListJson).length === 3);
  check("Studio package stores hashtags", studio.hashtags.includes("#LocalHandyman") && studio.hashtags.includes("#Reno"));

  await expectError(
    "ADMIN cannot download a review packet",
    () => downloadMarketingReviewPacket(prisma, adminA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === OWNER_REVIEW_PACKET_MESSAGE,
  );
  await expectError(
    "MEMBER cannot download a review packet",
    () => downloadMarketingReviewPacket(prisma, memberA, { contentId: studio.id }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Business B cannot download A's review packet",
    () => downloadMarketingReviewPacket(prisma, ownerB, { contentId: studio.id }),
    (error) => error instanceof Error,
  );

  const draftPacket = await downloadMarketingReviewPacket(prisma, ownerA, { contentId: studio.id });
  check("Draft review packet filename is labeled draft", draftPacket.filename.endsWith("-review-packet-draft.json"));
  check("Draft review packet kind is TBBT_MARKETING_REVIEW_PACKET", draftPacket.packet.kind === "TBBT_MARKETING_REVIEW_PACKET");
  check("Draft review packet is labeled draft", draftPacket.packet.draft === true && draftPacket.packet.draftLabel === REVIEW_PACKET_DRAFT_PACKAGE_LABEL);
  check("Draft review packet labels text as not approved", draftPacket.packet.approvedText.label === REVIEW_PACKET_DRAFT_TEXT_LABEL);
  check("Draft review packet includes the drafted caption", draftPacket.packet.approvedText.caption.includes("faucet repair"));
  check("Draft review packet includes the storyboard", draftPacket.packet.storyboard.length === 3);
  check("Draft review packet includes the shot list", draftPacket.packet.shotList.length === 3);
  check("Draft review packet includes only the permitted photo", draftPacket.packet.photoReferences.length === 1 && draftPacket.packet.photoReferences[0].id === otherPhoto.id);
  const draftPacketJson = JSON.stringify(draftPacket.packet);
  check("Draft review packet excludes the private photo URL", !draftPacketJson.includes("private.jpg"));
  check("Draft review packet excludes customer names", !draftPacketJson.includes("Ada Homeowner") && !draftPacketJson.includes("Beta Secret"));
  check("Draft review packet excludes sensitive estimate line-item text", !draftPacketJson.includes(SENSITIVE_ESTIMATE_TEXT));
  check("Draft review packet excludes job-photo captions", !draftPacketJson.includes(SENSITIVE_PHOTO_CAPTION) && !draftPacketJson.includes("14 Secret Court"));
  check("Draft review packet photo references have no caption field", draftPacket.packet.photoReferences.every((photo) => !("caption" in photo)));
  check("Draft review packet has no recordedFacts", !("recordedFacts" in draftPacket.packet));
  check(
    "Draft review packet does not publish or post",
    draftPacket.packet.limits.published === false &&
      draftPacket.packet.limits.posted === false &&
      draftPacket.packet.limits.message.includes("will not publish or post"),
  );
  const draftAfterDownload = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  check("Review packet download does not mark the package exported", draftAfterDownload?.exportedAt === null);
  check("Review packet download leaves the package as DRAFT", draftAfterDownload?.status === "DRAFT");

  const edited = await updateMarketingStudioPackage(prisma, adminA, {
    contentId: studio.id,
    title: "Reno faucet story edited",
    body: "Edited caption from recorded faucet repair.",
    hashtags: "#LocalHandyman #RenoNV",
    storyboardJson: JSON.stringify([
      { heading: "Hook", visual: "Approved after photo", narration: "Recorded faucet repair only." },
      { heading: "Proof", visual: "Hold the approved still", narration: "No invented results." },
    ]),
    shotListJson: JSON.stringify([
      { order: 1, shot: "Hero still", purpose: "Approved after photo", photoId: otherPhoto.id },
    ]),
    photoIds: [otherPhoto.id],
  });
  check("ADMIN can edit a draft storyboard", edited.title === "Reno faucet story edited");
  check("Edited storyboard persists", parseStoryboard(edited.storyboardJson)[0].heading === "Hook");

  const linksBeforeFailure = await prisma.marketingContentPhoto.findMany({
    where: { contentId: studio.id, businessId: businessA.id },
    orderBy: { id: "asc" },
  });
  check("Edited package still has the approved photo link", linksBeforeFailure.length === 1 && linksBeforeFailure[0].jobPhotoId === otherPhoto.id);

  await expectError(
    "Invalid storyboard is rejected before any write",
    () =>
      updateMarketingStudioPackage(prisma, adminA, {
        contentId: studio.id,
        title: "Should not persist",
        storyboardJson: "{not-valid-json",
        photoIds: [otherPhoto.id],
      }),
    (error) => error instanceof MarketingError && error.message === INVALID_STORYBOARD_MESSAGE,
  );
  const afterInvalidStoryboard = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  const linksAfterInvalidStoryboard = await prisma.marketingContentPhoto.findMany({
    where: { contentId: studio.id, businessId: businessA.id },
    orderBy: { id: "asc" },
  });
  check(
    "Invalid storyboard leaves the original package intact",
    afterInvalidStoryboard?.title === "Reno faucet story edited" &&
      afterInvalidStoryboard?.storyboardJson === edited.storyboardJson &&
      afterInvalidStoryboard?.body === edited.body,
  );
  check(
    "Invalid storyboard leaves photo links intact",
    linksAfterInvalidStoryboard.length === linksBeforeFailure.length &&
      linksAfterInvalidStoryboard[0]?.id === linksBeforeFailure[0]?.id &&
      linksAfterInvalidStoryboard[0]?.jobPhotoId === otherPhoto.id,
  );

  const failingPhotoDb = {
    marketingContent: prisma.marketingContent,
    jobPhoto: prisma.jobPhoto,
    $transaction: (fn) =>
      prisma.$transaction(async (tx) =>
        fn({
          marketingContentPhoto: {
            deleteMany: (args) => tx.marketingContentPhoto.deleteMany(args),
            createMany: async () => {
              throw new Error("photo write failed");
            },
          },
          marketingContent: tx.marketingContent,
        }),
      ),
  };
  await expectError(
    "Failed photo write aborts the package update",
    () =>
      updateMarketingStudioPackage(failingPhotoDb, adminA, {
        contentId: studio.id,
        title: "Should not persist after photo failure",
        storyboardJson: JSON.stringify([
          { heading: "Changed", visual: "Should roll back", narration: "Should roll back" },
        ]),
        photoIds: [otherPhoto.id],
      }),
    (error) => error instanceof Error && /photo write failed/.test(error.message),
  );
  const afterFailedPhotoWrite = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  const linksAfterFailedPhotoWrite = await prisma.marketingContentPhoto.findMany({
    where: { contentId: studio.id, businessId: businessA.id },
    orderBy: { id: "asc" },
  });
  check(
    "Failed photo write leaves the original package intact",
    afterFailedPhotoWrite?.title === "Reno faucet story edited" &&
      afterFailedPhotoWrite?.storyboardJson === edited.storyboardJson,
  );
  check(
    "Failed photo write leaves photo links intact",
    linksAfterFailedPhotoWrite.length === linksBeforeFailure.length &&
      linksAfterFailedPhotoWrite[0]?.id === linksBeforeFailure[0]?.id &&
      linksAfterFailedPhotoWrite[0]?.jobPhotoId === otherPhoto.id,
  );

  const updateFnSrc = studioOpsSrc.slice(
    studioOpsSrc.indexOf("export async function updateMarketingStudioPackage"),
    studioOpsSrc.indexOf("export async function advanceMarketingContentStatus"),
  );
  check(
    "Studio update validates the storyboard before opening a write transaction",
    updateFnSrc.includes("parseRequiredStoryboard") &&
      updateFnSrc.indexOf("parseRequiredStoryboard") < updateFnSrc.indexOf("runInTransaction"),
  );
  check(
    "Studio update replaces photos and content in one transaction",
    updateFnSrc.includes("runInTransaction") &&
      updateFnSrc.indexOf("deleteMany") > updateFnSrc.indexOf("runInTransaction") &&
      updateFnSrc.indexOf("createMany") > updateFnSrc.indexOf("deleteMany") &&
      updateFnSrc.indexOf("marketingContent.update") > updateFnSrc.indexOf("createMany"),
  );
  const reviewFnSrc = studioOpsSrc.slice(
    studioOpsSrc.indexOf("const REVIEW_PACKET_CONTENT_SELECT"),
    studioOpsSrc.indexOf("export async function setMarketingContentPlannedFor"),
  );
  check(
    "Review packet download is OWNER-gated after the marketing capability check",
    reviewFnSrc.includes("requireBusinessCapability") &&
      reviewFnSrc.includes('requireBusinessRole(access, "OWNER")') &&
      reviewFnSrc.includes("OWNER_REVIEW_PACKET_MESSAGE"),
  );
  check(
    "Review packet query stays tenant-scoped and never loads a customer, estimate, or photo caption",
    reviewFnSrc.includes("...access.scope") &&
      reviewFnSrc.includes("access.assertOwned") &&
      !reviewFnSrc.includes("customer") &&
      !reviewFnSrc.includes("jobCustomerName") &&
      !reviewFnSrc.includes("estimate") &&
      !reviewFnSrc.includes("lineItems") &&
      !reviewFnSrc.includes("recordedFacts") &&
      !reviewFnSrc.includes("caption: true") &&
      !reviewFnSrc.includes("business.findFirst"),
  );
  check(
    "Review packet download does not write export or publish fields",
    !reviewFnSrc.includes("exportedAt") &&
      !reviewFnSrc.includes("PUBLISHED") &&
      !reviewFnSrc.includes("marketingContent.update"),
  );

  const studioReady = await advanceMarketingContentStatus(prisma, adminA, { contentId: studio.id });
  check("ADMIN can send a package for OWNER review", studioReady.status === "READY_FOR_REVIEW");
  await expectError(
    "ADMIN cannot give OWNER approval",
    () => advanceMarketingContentStatus(prisma, adminA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === OWNER_STUDIO_APPROVAL_MESSAGE,
  );

  await revokeJobPhotoMarketingPermission(prisma, ownerA, { photoId: otherPhoto.id });
  await expectError(
    "Revoked photo blocks OWNER approval",
    () => advanceMarketingContentStatus(prisma, ownerA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === PHOTO_PERMISSION_REVOKED_MESSAGE,
  );
  await expectError(
    "Revoked photo blocks export",
    () => exportMarketingCreatorPackage(prisma, ownerA, { contentId: studio.id }),
    (error) => error instanceof MarketingError,
  );

  const revokedPacket = await downloadMarketingReviewPacket(prisma, ownerA, { contentId: studio.id });
  check("Revoked photo still allows an OWNER review packet", revokedPacket.packet.kind === "TBBT_MARKETING_REVIEW_PACKET");
  check("Revoked photo is excluded from the review packet", revokedPacket.packet.photoReferences.length === 0);
  check("Revoked photo id is stripped from the review shot list", revokedPacket.packet.shotList.every((shot) => !shot.photoId));
  check("Unapproved media stay omitted after revoke", revokedPacket.packet.omitted.unapprovedMedia === true);
  check("Ready-for-review packet is still labeled not approved", revokedPacket.packet.draft === true && revokedPacket.packet.draftLabel.includes("not approved"));
  check("Review packet keeps approved-text, storyboard, and shot list after revoke", revokedPacket.packet.approvedText.caption.includes("faucet repair") && revokedPacket.packet.storyboard.length === 2 && revokedPacket.packet.shotList.length === 1);

  await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: otherPhoto.id });
  const studioApproved = await advanceMarketingContentStatus(prisma, ownerA, { contentId: studio.id });
  check("OWNER can approve after permission is restored", studioApproved.status === "APPROVED");
  check("OWNER approval records the owner reviewer", studioApproved.reviewedByMembershipId === ownerMem.id);

  await expectError(
    "Business B cannot export A's creator package",
    () => exportMarketingCreatorPackage(prisma, ownerB, { contentId: studio.id }),
    (error) => error instanceof Error,
  );

  const approvedPacket = await downloadMarketingReviewPacket(prisma, ownerA, { contentId: studio.id });
  check("Approved review packet filename is not labeled draft", approvedPacket.filename.endsWith("-review-packet.json") && !approvedPacket.filename.includes("-draft"));
  check("Approved review packet is not a draft", approvedPacket.packet.draft === false && approvedPacket.packet.draftLabel === "Approved");
  check("Approved review packet labels the text as approved", approvedPacket.packet.approvedText.label === REVIEW_PACKET_APPROVED_TEXT_LABEL && approvedPacket.packet.approvedText.draft === false);
  check("Approved review packet includes permitted photo references", approvedPacket.packet.photoReferences.length === 1 && approvedPacket.packet.photoReferences[0].id === otherPhoto.id);
  check("Approved review packet includes storyboard and shot list", approvedPacket.packet.storyboard[0]?.heading === "Hook" && approvedPacket.packet.shotList[0]?.shot === "Hero still");
  check("Approved review packet still does not publish", approvedPacket.packet.limits.published === false && approvedPacket.packet.limits.posted === false);
  check(
    "Approved review packet still excludes estimate text and photo captions",
    !JSON.stringify(approvedPacket.packet).includes(SENSITIVE_ESTIMATE_TEXT) &&
      !JSON.stringify(approvedPacket.packet).includes(SENSITIVE_PHOTO_CAPTION),
  );

  const exported = await exportMarketingCreatorPackage(prisma, ownerA, { contentId: studio.id });
  check("Export filename is a handoff JSON file", exported.filename.endsWith("-handoff.json"));
  check("Exported package kind is TBBT_CREATOR_PACKAGE", exported.package.kind === "TBBT_CREATOR_PACKAGE");
  check("Exported package is not published", exported.package.limits.published === false && exported.package.limits.posted === false);
  check("Exported package does not claim Flow/Veo", exported.package.limits.flowVeoConnected === false);
  check("Exported package does not claim paid ads", exported.package.limits.paidAdsConnected === false);
  check("Exported package does not claim social publishing", exported.package.limits.socialPublishingConnected === false);
  check("Exported package keeps the approved photo only", exported.package.photos.length === 1 && exported.package.photos[0].id === otherPhoto.id);
  check("Exported package caption is the edited recorded-facts draft", exported.package.caption.includes("faucet repair"));

  await revokeJobPhotoMarketingPermission(prisma, ownerA, { photoId: otherPhoto.id });
  await expectError(
    "Later revocation blocks another export",
    () => exportMarketingCreatorPackage(prisma, ownerA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === PHOTO_PERMISSION_REVOKED_MESSAGE,
  );

  const laterRevokedPacket = await downloadMarketingReviewPacket(prisma, ownerA, { contentId: studio.id });
  check("Later revocation still allows a review packet", laterRevokedPacket.packet.photoReferences.length === 0);
  check("Later revocation does not leak the private photo URL", !JSON.stringify(laterRevokedPacket.packet).includes(otherPhoto.url));

  const afterRevoke = await loadMarketingSource(prisma, businessA.id);
  const studioRow = afterRevoke.contents.find((row) => row.id === studio.id);
  check("Loader marks the revoked photo as not approved", studioRow?.photos.every((photo) => photo.approved === false) === true);
  check("Business B still cannot see A's studio package", (await loadMarketingSource(prisma, businessB.id)).contents.every((row) => row.id !== studio.id));

  console.log(
    failures === 0 ? "\nAll marketing checks passed." : `\n${failures} marketing check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
