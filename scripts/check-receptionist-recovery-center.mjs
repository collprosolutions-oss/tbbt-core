/**
 * Receptionist & missed-call recovery center proofs.
 *
 * Recorded PhoneInteraction / ReceptionistEvent workspace, plus an
 * authorized manual disposition that uses canonical CLOSED + a
 * ReceptionistEvent audit row. No schema, no carrier, no auto follow-up,
 * and no invented successful contact.
 *
 * Run with:
 *   npm run test:receptionist-recovery-center
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const mutationKind = process.env.RECEPTIONIST_RECOVERY_MUTATION ?? "";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_receptionist_recovery_center_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

if (!mutationKind) {
  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    console.error("Failed to push schema for receptionist recovery test database.");
    process.exit(push.status ?? 1);
  }
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } =
  await import("@/lib/authorization");
const {
  OWNER_LOG_LEAD_HREF,
  RECEPTIONIST_RECOVERY_FACT_KEYS,
  RECEPTIONIST_RECOVERY_QUEUE_LIMIT,
  RECEPTIONIST_RECOVERY_SCAN_LIMIT,
  appendReceptionistRecoveryFacts,
  loadReceptionistRecoveryCenter,
  PHONE_INTERACTION_CLOSED_STATUS,
  RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON,
  RECEPTIONIST_DISPOSITION_NOT_CALLBACK_REASON,
  RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON,
  RECEPTIONIST_MANUAL_DISPOSITION_KIND,
  RECEPTIONIST_MANUAL_DISPOSITION_STATUS,
  COMMUNICATIONS_PERMISSION_ERROR,
  COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR,
  communicationsActionError,
  executeReceptionistDispositionAction,
  recordMissedOrManualCall,
  recordInboundCallEvent,
  recordReceptionistCallbackDisposition,
  receptionistDispositionIdempotencyKey,
  VOICE_NOT_CONNECTED_REASON,
} = await import("@/lib/communications");
const { planSpecialists } = await import("@/lib/chief-of-staff");

let failures = 0;
let passes = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
    passes += 1;
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId },
      business: { id: businessId, name: "Recovery Co" },
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

async function seedBusiness(name) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: `${name} Member`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: `${name} Admin`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
  });
  return {
    business,
    membership,
    memberMembership,
    adminMembership,
    access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id),
    memberAccess: makeAccess(business.id, "MEMBER", memberMembership.id, memberUser.id),
    adminAccess: makeAccess(business.id, "ADMIN", adminMembership.id, adminUser.id),
  };
}

async function proveClosedLogReplay() {
  console.log("\nDB — CLOSED stays CLOSED on an idempotent missed-call replay");
  const tenant = await seedBusiness("Closed Replay");
  const key = `closed-replay-${randomUUID()}`;
  const logged = await recordMissedOrManualCall(prisma, tenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5551212000",
    summary: "Callback needed, then handled, then a stale form retries.",
    callbackNeeded: true,
    idempotencyKey: key,
  });
  check("Replay seed logged a callback-needed phone", logged.ok && Boolean(logged.phoneInteractionId));
  await recordReceptionistCallbackDisposition(prisma, tenant.access, {
    phoneInteractionId: logged.phoneInteractionId,
  });
  const beforeReplay = await loadReceptionistRecoveryCenter(prisma, tenant.access);
  const replay = await recordMissedOrManualCall(prisma, tenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5551212000",
    summary: "Callback needed, then handled, then a stale form retries.",
    callbackNeeded: true,
    idempotencyKey: key,
  });
  const after = await prisma.phoneInteraction.findFirst({
    where: { id: logged.phoneInteractionId, businessId: tenant.business.id },
  });
  const afterCenter = await loadReceptionistRecoveryCenter(prisma, tenant.access);
  const action = after?.followUpActionItemId
    ? await prisma.businessActionItem.findFirst({
        where: { id: after.followUpActionItemId, businessId: tenant.business.id },
      })
    : null;
  check(
    "Replayed missed-call log keeps a CLOSED row closed",
    replay.ok &&
      replay.reused === true &&
      after?.status === "CLOSED" &&
      after.callbackNeeded === false &&
      afterCenter.recordedCallbackNeededCount === beforeReplay.recordedCallbackNeededCount &&
      !afterCenter.queue.some((row) => row.id === logged.phoneInteractionId) &&
      action?.status === "DONE",
  );
}

async function proveEventIdempotencyLookup() {
  console.log("\nDB — Disposition event replay uses the pre-insert lookup");
  const tenant = await seedBusiness("Disposition Lookup");
  const logged = await recordMissedOrManualCall(prisma, tenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5551313000",
    summary: "Lookup replay for the disposition event.",
    callbackNeeded: true,
    idempotencyKey: `disp-lookup-${randomUUID()}`,
  });
  const first = await recordReceptionistCallbackDisposition(prisma, tenant.access, {
    phoneInteractionId: logged.phoneInteractionId,
  });
  let replayedViaLookup = false;
  let replayErrorCode = null;
  try {
    const second = await recordReceptionistCallbackDisposition(prisma, tenant.access, {
      phoneInteractionId: logged.phoneInteractionId,
    });
    replayedViaLookup = second.ok && second.replayedViaLookup === true;
  } catch (error) {
    replayErrorCode = error?.code ?? error?.meta?.code ?? String(error?.message ?? error);
    replayedViaLookup = false;
  }
  check("First disposition wrote the audit event", first.ok && first.replayedViaLookup === false);
  check(
    "Idempotent disposition replay uses the pre-insert lookup",
    replayedViaLookup === true && replayErrorCode !== "25P02" && replayErrorCode !== "P2002",
  );
}

async function proveDispositionActionRoleCheck() {
  console.log("\nDB — Server action role check is distinct from unexpected errors");
  const tenant = await seedBusiness("Disposition Action");
  const logged = await recordMissedOrManualCall(prisma, tenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5551414000",
    summary: "Action-layer role check.",
    callbackNeeded: true,
    idempotencyKey: `disp-action-${randomUUID()}`,
  });
  const memberAction = await executeReceptionistDispositionAction(prisma, tenant.memberAccess, {
    phoneInteractionId: logged.phoneInteractionId,
    browserBusinessId: tenant.business.id,
  });
  const missing = await executeReceptionistDispositionAction(prisma, tenant.access, {
    phoneInteractionId: "",
    browserBusinessId: tenant.business.id,
  });
  const exploded = await executeReceptionistDispositionAction(
    {
      phoneInteraction: {
        findFirst: async () => {
          throw new Error("injected writer failure");
        },
      },
    },
    tenant.access,
    { phoneInteractionId: logged.phoneInteractionId, browserBusinessId: tenant.business.id },
  );
  const mapped = communicationsActionError(new Error("injected disposition failure"));
  const stillOpen = await prisma.phoneInteraction.findFirst({
    where: { id: logged.phoneInteractionId, businessId: tenant.business.id },
  });
  check(
    "Server action role check denies MEMBER with the permission error",
    memberAction.error === COMMUNICATIONS_PERMISSION_ERROR,
  );
  check(
    "Unexpected action errors are distinguishable from permission denials",
    exploded.error === COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR &&
      mapped.error === COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR &&
      exploded.error !== COMMUNICATIONS_PERMISSION_ERROR,
  );
  check(
    "Server action returns the writer failure, not a permission error, for a missing item",
    missing.error === RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON &&
      missing.error !== COMMUNICATIONS_PERMISSION_ERROR,
  );
  check(
    "Denied or failed action writes do not close the callback-needed row",
    stillOpen?.status === "CALLBACK_NEEDED" && stillOpen.callbackNeeded === true,
  );
}

try {
  if (mutationKind === "closed-preserve") {
    await proveClosedLogReplay();
  } else if (mutationKind === "event-idempotency-lookup") {
    await proveEventIdempotencyLookup();
  } else if (mutationKind) {
    check(`unknown mutation ${mutationKind}`, false);
  } else {
  const recoverySrc = readRepo("src/lib/communications/receptionist-recovery.ts");
  const missedCallSrc = readRepo("src/lib/communications/missed-call.ts");
  const dispositionSrc = readRepo("src/lib/communications/receptionist-disposition.ts");
  const actionSrc = readRepo("src/app/actions/communications.ts");
  const formSrc = readRepo("src/components/communications/receptionist-disposition-form.tsx");
  const pageSrc = readRepo("src/app/(app)/communications/receptionist/page.tsx");
  const uiSrc = readRepo("src/components/communications/receptionist-recovery-center.tsx");
  const workspaceSrc = readRepo("src/components/communications/communications-workspace.tsx");
  const logLeadPageSrc = readRepo("src/app/(app)/requests/log-lead/page.tsx");
  const logLeadFormSrc = readRepo("src/components/requests/log-lead-form.tsx");
  const navSrc = readRepo("src/lib/nav.ts");
  const schemaSrc = readRepo("prisma/schema.prisma");
  const timelineSrc = readRepo("src/lib/communications/timeline.ts");
  const timelineUiSrc = readRepo("src/components/communications/customer-communication-timeline.tsx");
  const specialistSrc = readRepo("src/lib/chief-of-staff/communications-specialist.ts");
  const plannerSrc = readRepo("src/lib/chief-of-staff/planner.ts");
  const coachSrc = readRepo("src/lib/ai/coach.ts");

  console.log("\nSTATIC — Recovery center stays recorded-truth and receptionist-scoped");
  check(
    "Dedicated office route exists at /communications/receptionist",
    pageSrc.includes("loadReceptionistRecoveryCenter") &&
      pageSrc.includes("MANAGE_COMMUNICATIONS") &&
      pageSrc.includes("requireManagementPageAccess") &&
      pageSrc.includes("requireBusinessCapability"),
  );
  check(
    "Global nav is unchanged",
    navSrc.includes('{ href: "/communications", label: "Communications"') &&
      !navSrc.includes("/communications/receptionist"),
  );
  check(
    "Log Lead remains the canonical capture path and still has no prefill architecture",
    (pageSrc.includes("/requests/log-lead") || uiSrc.includes("source.logLeadHref")) &&
      uiSrc.includes("source.logLeadHref") &&
      recoverySrc.includes('logLeadPrefillSupported: false') &&
      !logLeadPageSrc.includes("searchParams") &&
      !logLeadFormSrc.includes("defaultPhone") &&
      !recoverySrc.includes("createOwnerLoggedLead") &&
      !pageSrc.includes("createOwnerLoggedLead") &&
      !uiSrc.includes("createOwnerLoggedLead"),
  );
  check(
    "Recovery loader does not send SMS, email, or place calls",
    !recoverySrc.includes("composeCustomerCommunication") &&
      !recoverySrc.includes("attemptCustomerSms") &&
      !recoverySrc.includes("sendTransactionalEmail") &&
      !recoverySrc.includes("recordMissedOrManualCall") &&
      !pageSrc.includes("composeCustomerCommunication") &&
      !pageSrc.includes("attemptCustomerSms"),
  );
  check(
    "Manual disposition reuses canonical CLOSED and ReceptionistEvent audit rows",
    dispositionSrc.includes('status: PHONE_INTERACTION_CLOSED_STATUS') &&
      dispositionSrc.includes('kind: RECEPTIONIST_MANUAL_DISPOSITION_KIND') &&
      dispositionSrc.includes('status: RECEPTIONIST_MANUAL_DISPOSITION_STATUS') &&
      dispositionSrc.includes("initiatedByMembershipId") &&
      dispositionSrc.includes("pg_advisory_xact_lock") &&
      dispositionSrc.includes("phoneInteraction.updateMany") &&
      dispositionSrc.includes("businessId: access.businessId") &&
      !dispositionSrc.includes("phoneInteraction.update(") &&
      !dispositionSrc.includes("phoneInteraction.delete") &&
      !uiSrc.includes("Mark resolved") &&
      !pageSrc.includes("Mark resolved") &&
      !formSrc.includes("Mark resolved"),
  );
  check(
    "Disposition writer does not send SMS, email, place a call, or invent a successful contact",
    !dispositionSrc.includes("composeCustomerCommunication") &&
      !dispositionSrc.includes("attemptCustomerSms") &&
      !dispositionSrc.includes("sendTransactionalEmail") &&
      !dispositionSrc.includes("recordMissedOrManualCall") &&
      !dispositionSrc.includes("customerCommunication.create") &&
      dispositionSrc.includes("contactClaimed: false") &&
      formSrc.includes("Record handled") &&
      formSrc.includes("disabled={pending}") &&
      actionSrc.includes("executeReceptionistDispositionAction") &&
      actionSrc.includes("communicationsActionError") &&
      actionSrc.includes('revalidatePath("/communications/receptionist")'),
  );
  check(
    "Idempotent phone-log replay preserves CLOSED and the disposition event lookup is marked",
    missedCallSrc.includes("PHONE_LOG_PRESERVE_CLOSED") &&
      missedCallSrc.includes('const alreadyClosed = claimed.status === "CLOSED"') &&
      missedCallSrc.includes("callbackNeeded && !alreadyClosed") &&
      dispositionSrc.includes("RECEPTIONIST_DISPOSITION_IDEMPOTENCY_LOOKUP") &&
      dispositionSrc.includes("replayedViaLookup: true"),
  );
  check(
    "Disposition server action distinguishes ForbiddenError from unexpected errors",
    actionSrc.includes("communicationsActionError(error)") &&
      actionSrc.includes("executeReceptionistDispositionAction") &&
      dispositionSrc.includes("roleHasCapability(access.workspace.role, CAPABILITIES.MANAGE_COMMUNICATIONS)") &&
      dispositionSrc.includes("throw new ForbiddenError()") &&
      /export async function recordReceptionistDispositionAction\([\s\S]*?catch \(error\) \{\s*return communicationsActionError\(error\);\s*\}/.test(
        actionSrc,
      ),
  );
  check(
    "Voice remains disconnected and no Twilio voice/number provisioning is added",
    recoverySrc.includes("voiceConnected: false") &&
      recoverySrc.includes("getReceptionistReadiness") &&
      !recoverySrc.includes("twilio") &&
      !pageSrc.includes("twilio") &&
      !uiSrc.includes("provision"),
  );
  check(
    "Unknown caller copy stays Unknown and never guesses identity",
    uiSrc.includes("Unknown caller") &&
      uiSrc.includes("Caller identity is unknown") &&
      recoverySrc.includes("resolveCustomer") &&
      !recoverySrc.includes("decideCustomerMatch"),
  );
  check(
    "Queue is bounded",
    recoverySrc.includes("RECEPTIONIST_RECOVERY_QUEUE_LIMIT = 40") &&
      RECEPTIONIST_RECOVERY_QUEUE_LIMIT === 40,
  );
  check(
    "Communications specialist can cite bounded missed-call sample facts without writing",
    specialistSrc.includes("appendReceptionistRecoveryFacts") &&
      plannerSrc.includes("missed calls?") &&
      !specialistSrc.includes("composeCustomerCommunication") &&
      !recoverySrc.includes("communications-recorded-caller-without-later-communication-count") &&
      !coachSrc.includes("communications-recorded-caller-without-later-communication-count") &&
      coachSrc.includes("Missed calls in bounded Communications sample"),
  );
  check(
    "Request/job links require a proven same-business customer",
    recoverySrc.includes("if (!requestId || !resolvedCustomerId) return null") &&
      recoverySrc.includes("if (!jobId || !resolvedCustomerId) return null") &&
      recoverySrc.includes("owned.customerId !== resolvedCustomerId"),
  );
  check(
    "Linked receptionist attention events attach only to scanned same-business phones",
    recoverySrc.includes("scannedPhoneById.get(event.phoneInteractionId)") &&
      recoverySrc.includes("attentionPhoneIds.add(scanned.id)") &&
      recoverySrc.includes("standaloneEvents.push(event)"),
  );
  check(
    "Communication history is bounded per final-queue customer and uses canonical timestamps",
    !recoverySrc.includes("customerCommunication.findMany") &&
      !recoverySrc.includes("$queryRawUnsafe") &&
      recoverySrc.includes("customerCommunication.findFirst") &&
      recoverySrc.includes("attemptedAt: { not: null }") &&
      recoverySrc.includes("attemptedAt: null") &&
      recoverySrc.includes("attemptedAt ?? row.createdAt"),
  );
  check(
    "Recorded inbound event count is an exact same-business receptionistEvent.count",
    recoverySrc.includes("db.receptionistEvent.count({") &&
      recoverySrc.includes('where: { businessId, kind: "INBOUND_CALL" }') &&
      !recoverySrc.includes('eventRows.filter((row) => row.kind === "INBOUND_CALL")') &&
      !recoverySrc.includes("recordedInboundEventCount: eventRows.filter"),
  );
  check(
    "Event-row discovery stays a bounded scan and is not used as the inbound total",
    recoverySrc.includes("take: RECEPTIONIST_RECOVERY_SCAN_LIMIT") &&
      recoverySrc.includes("RECEPTIONIST_RECOVERY_SCAN_LIMIT = 80") &&
      RECEPTIONIST_RECOVERY_SCAN_LIMIT === 80,
  );
  check(
    "Empty-state wording is bounded-scan truth, not an exhaustive database claim",
    uiSrc.includes("No attention items were found in the bounded recent recovery scan.") &&
      !uiSrc.includes(
        "No recorded missed calls, callbacks, inbound receptionist events, or escalations need attention.",
      ),
  );
  check(
    "Standalone receptionist direction is INBOUND only for INBOUND_CALL and UNKNOWN otherwise",
    recoverySrc.includes("function standaloneReceptionistDirection") &&
      recoverySrc.includes('if (kind === "INBOUND_CALL") return "INBOUND"') &&
      recoverySrc.includes('return "UNKNOWN"') &&
      recoverySrc.includes("standaloneReceptionistDirection(event.kind)") &&
      !recoverySrc.includes('direction: "INBOUND"'),
  );
  check(
    "UNKNOWN direction is presented as Direction not recorded, not as a provider status",
    uiSrc.includes("function directionLabel") &&
      uiSrc.includes('if (direction === "UNKNOWN") return "Direction not recorded"') &&
      uiSrc.includes("directionLabel(item.direction)") &&
      !uiSrc.includes("{item.direction}"),
  );
  check(
    "Existing receptionist tab can open the recovery route",
    workspaceSrc.includes('href="/communications/receptionist"'),
  );
  check(
    "Prisma schema still contains the existing phone/receptionist models and this check does not add fields",
    schemaSrc.includes("model PhoneInteraction") &&
      schemaSrc.includes("model ReceptionistEvent") &&
      schemaSrc.includes("model CustomerCommunication") &&
      !recoverySrc.includes("prisma.schema") &&
      !pageSrc.includes("prisma.schema"),
  );
  check(
    "Timeline files are not rewritten by this recovery module",
    !recoverySrc.includes("loadCustomerCommunicationHistory") &&
      !recoverySrc.includes("loadCustomerCommunicationTimeline") &&
      !pageSrc.includes("CustomerCommunicationTimeline") &&
      timelineSrc.includes("export async function loadCustomerCommunicationHistory") &&
      timelineUiSrc.includes("export function CustomerCommunicationTimeline"),
  );
  check(
    "MEMBER still does not receive MANAGE_COMMUNICATIONS",
    roleHasCapability("OWNER", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
      roleHasCapability("ADMIN", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
      !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_COMMUNICATIONS),
  );
  check(
    "Queue UI offers authorized disposition only for callback-needed phone items",
    uiSrc.includes("item.canRecordDisposition") &&
      uiSrc.includes("ReceptionistDispositionForm") &&
      recoverySrc.includes("canRecordDisposition: phoneInteractionIsCallbackNeeded(row)") &&
      recoverySrc.includes("canRecordDisposition: false") &&
      pageSrc.includes("businessId={access.businessId}") &&
      formSrc.includes('name="phoneInteractionId"') &&
      formSrc.includes('name="businessId"'),
  );
  check(
    "Closed phones leave attention even when kind is MISSED_CALL or a linked event exists",
    recoverySrc.includes("if (phoneIsClosed(row)) return false") &&
      recoverySrc.includes("if (phoneIsClosed(scanned)) continue"),
  );

  const missedPlan = planSpecialists({
    question: "How many missed calls are recorded?",
    activeRecommendationKeys: [],
  });
  const callerPlan = planSpecialists({
    question: "Which recorded caller has not had a later communication?",
    activeRecommendationKeys: [],
  });
  const lastPlan = planSpecialists({
    question: "What was the last recorded interaction with this customer?",
    activeRecommendationKeys: [],
  });
  check("Planner selects COMMUNICATIONS for missed-call count", missedPlan.selectedIds.includes("COMMUNICATIONS"));
  check(
    "Planner selects COMMUNICATIONS for recorded caller without later communication",
    callerPlan.selectedIds.includes("COMMUNICATIONS"),
  );
  check(
    "Planner selects COMMUNICATIONS for last recorded interaction",
    lastPlan.selectedIds.includes("COMMUNICATIONS"),
  );

  const tenantA = await seedBusiness("Alpha Recovery");
  const tenantB = await seedBusiness("Beta Recovery");
  const sharedPhone = "5551112222";

  const customerA = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Alpha Known Caller",
      phone: sharedPhone,
      email: "alpha-known@example.com",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: tenantB.business.id,
      name: "Beta Same Phone",
      phone: sharedPhone,
      email: "beta-secret@example.com",
      smsConsentStatus: "GRANTED",
    },
  });
  const requestA = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      summary: "Alpha recorded request",
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const sibling = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Alpha Sibling",
      phone: "5557778888",
      email: "alpha-sibling@example.com",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const siblingRequest = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: sibling.id,
      summary: "Sibling request must stay hidden",
    },
  });
  const siblingJob = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: sibling.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const unknownWithLocalLinks = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Unknown caller with local request/job ids.",
      requestId: requestA.id,
      jobId: jobA.id,
      idempotencyKey: `unknown-links-${randomUUID()}`,
    },
  });
  const siblingLinked = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Known caller pointing at sibling request/job.",
      requestId: siblingRequest.id,
      jobId: siblingJob.id,
      idempotencyKey: `sibling-links-${randomUUID()}`,
    },
  });

  console.log("\nDB — Known caller stays tenant-local; unknown stays unknown");
  const knownMissed = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    callerPhone: sharedPhone,
    summary: "Alpha missed the known caller.",
    callbackNeeded: true,
    requestId: requestA.id,
    jobId: jobA.id,
    idempotencyKey: `known-missed-${randomUUID()}`,
  });
  const unknownMissed = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    callerPhone: "5550009999",
    summary: "Unknown inbound missed call.",
    callbackNeeded: false,
    idempotencyKey: `unknown-missed-${randomUUID()}`,
  });
  const manualAnswered = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MANUAL_PHONE",
    customerId: customerA.id,
    callerPhone: sharedPhone,
    summary: "Owner logged a manual answered-style call.",
    callbackNeeded: false,
    idempotencyKey: `manual-${randomUUID()}`,
  });
  const inboundUnknown = await recordInboundCallEvent(prisma, tenantA.access, {
    phone: "5554443333",
    summary: "Inbound event with no live voice.",
    idempotencyKey: `inbound-${randomUUID()}`,
  });
  check("Canonical writers stored the phone and receptionist facts", knownMissed.ok && unknownMissed.ok && manualAnswered.ok && inboundUnknown.ok);

  await prisma.phoneInteraction.update({
    where: { id: knownMissed.phoneInteractionId },
    data: { occurredAt: new Date(Date.now() - 120_000) },
  });

  const laterEmail = await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      purpose: "GENERAL",
      subject: "Later recorded follow-up",
      idempotencyKey: `later-email-${randomUUID()}`,
      bodySnapshot: "Later owner email.",
      status: "SENT",
      provider: "resend",
      createdAt: new Date(Date.now() + 60_000),
    },
  });

  const forgedForeign = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerB.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      callerLast4: "2222",
      summary: "Forged foreign customer id must not leak.",
      requestId: requestA.id,
      jobId: jobA.id,
      idempotencyKey: `forged-${randomUUID()}`,
    },
  });
  const loggedWithEscalation = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      kind: "MANUAL_PHONE",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Ordinary logged phone that should stay visible via escalation.",
      idempotencyKey: `logged-escalation-${randomUUID()}`,
    },
  });
  const linkedEscalation = await prisma.receptionistEvent.create({
    data: {
      businessId: tenantA.business.id,
      phoneInteractionId: loggedWithEscalation.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Linked escalation on a normal logged phone." },
      idempotencyKey: `linked-escalation-${randomUUID()}`,
    },
  });
  const foreignPhoneOnB = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantB.business.id,
      kind: "MANUAL_PHONE",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Beta phone must not leak through an Alpha event.",
      idempotencyKey: `beta-phone-${randomUUID()}`,
    },
  });
  const localEventForeignPhone = await prisma.receptionistEvent.create({
    data: {
      businessId: tenantA.business.id,
      phoneInteractionId: foreignPhoneOnB.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Local escalation pointing at a foreign phone id." },
      idempotencyKey: `local-event-foreign-phone-${randomUUID()}`,
    },
  });
  const canonCustomer = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Alpha Canonical History",
      phone: "5552223333",
      email: "alpha-canon@example.com",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const canonPhone = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      customerId: canonCustomer.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Canonical latest-communication proof call.",
      occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      idempotencyKey: `canon-phone-${randomUUID()}`,
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: canonCustomer.id,
      channel: "SMS",
      direction: "OUTBOUND",
      purpose: "GENERAL",
      subject: "Newer createdAt but older canonical time",
      idempotencyKey: `canon-old-${randomUUID()}`,
      bodySnapshot: "Must not win latest.",
      status: "SENT",
      provider: "manual",
      createdAt: new Date(),
      attemptedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    },
  });
  const canonLatest = await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: canonCustomer.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      purpose: "GENERAL",
      subject: "Older createdAt but later canonical time",
      idempotencyKey: `canon-latest-${randomUUID()}`,
      bodySnapshot: "Must win latest.",
      status: "SENT",
      provider: "resend",
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      attemptedAt: null,
    },
  });
  const noLaterCustomer = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Alpha No Later",
      phone: "5554445555",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const noLaterPhone = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      customerId: noLaterCustomer.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Known caller with no customer communication rows.",
      occurredAt: new Date(),
      idempotencyKey: `no-later-${randomUUID()}`,
    },
  });

  const beforeComms = await prisma.customerCommunication.count({
    where: { businessId: tenantA.business.id },
  });
  const beforePhones = await prisma.phoneInteraction.findMany({
    where: { businessId: tenantA.business.id },
    select: { id: true, status: true, kind: true },
  });

  const centerA = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
  const centerB = await loadReceptionistRecoveryCenter(prisma, tenantB.access);

  const afterComms = await prisma.customerCommunication.count({
    where: { businessId: tenantA.business.id },
  });
  const afterPhones = await prisma.phoneInteraction.findMany({
    where: { businessId: tenantA.business.id },
    select: { id: true, status: true, kind: true },
  });

  const knownItem = centerA.queue.find((row) => row.id === knownMissed.phoneInteractionId);
  const unknownItem = centerA.queue.find((row) => row.id === unknownMissed.phoneInteractionId);
  const manualItem = centerA.queue.find((row) => row.id === manualAnswered.phoneInteractionId);
  const inboundItem = centerA.queue.find((row) => row.id === inboundUnknown.event.id);
  const forgedItem = centerA.queue.find((row) => row.id === forgedForeign.id);
  const unknownLinkedItem = centerA.queue.find((row) => row.id === unknownWithLocalLinks.id);
  const siblingLinkedItem = centerA.queue.find((row) => row.id === siblingLinked.id);
  const loggedEscalationItem = centerA.queue.find((row) => row.id === loggedWithEscalation.id);
  const linkedEscalationStandalone = centerA.queue.filter((row) => row.id === linkedEscalation.id);
  const foreignPhoneEventItem = centerA.queue.find((row) => row.id === localEventForeignPhone.id);
  const canonItem = centerA.queue.find((row) => row.id === canonPhone.id);
  const noLaterItem = centerA.queue.find((row) => row.id === noLaterPhone.id);

  check(
    "Known caller maps only to the same-business customer",
    knownItem?.customerKnown === true &&
      knownItem.customer?.id === customerA.id &&
      knownItem.customer?.name === "Alpha Known Caller" &&
      knownItem.customer?.href === `/customers/${customerA.id}` &&
      !centerA.queue.some((row) => row.customer?.id === customerB.id || row.customer?.name === "Beta Same Phone"),
  );
  check(
    "Unknown caller remains Unknown and offers Log Lead without prefill",
    unknownItem?.customerKnown === false &&
      unknownItem.customer === null &&
      unknownItem.logLeadHref === OWNER_LOG_LEAD_HREF &&
      centerA.logLeadPrefillSupported === false,
  );
  check(
    "Foreign tenant same phone number does not leak into either workspace",
    !centerA.queue.some((row) => (row.customer?.name ?? "").includes("Beta")) &&
      !centerB.queue.some((row) => row.id === knownMissed.phoneInteractionId) &&
      !centerB.queue.some((row) => row.id === unknownMissed.phoneInteractionId) &&
      centerB.recordedMissedCallCount === 0 &&
      !JSON.stringify(centerA).includes("beta-secret@example.com") &&
      !JSON.stringify(centerA).includes("Beta Same Phone"),
  );
  check(
    "Forged foreign customerId on a same-tenant phone row stays unknown",
    forgedItem?.customerKnown === false && forgedItem.customer === null,
  );
  check(
    "Missed vs manual recorded kinds are preserved and manual-without-callback is not invented as missed",
    knownItem?.kind === "MISSED_CALL" &&
      unknownItem?.kind === "MISSED_CALL" &&
      manualAnswered.ok &&
      !manualItem &&
      centerA.queue.every((row) => row.kind !== "ANSWERED"),
  );
  check(
    "Known same-tenant customer + own request/job are exposed",
    knownItem?.request?.id === requestA.id &&
      knownItem.job?.id === jobA.id &&
      knownItem.request?.href === `/requests/${requestA.id}`,
  );
  check(
    "Unknown caller + same-business requestId does not expose the request",
    unknownLinkedItem?.customerKnown === false && unknownLinkedItem.request === null,
  );
  check(
    "Unknown caller + same-business jobId does not expose the job",
    unknownLinkedItem?.job === null,
  );
  check(
    "Foreign/dirty customerId + local request/job does not expose them",
    forgedItem?.customerKnown === false &&
      forgedItem.request === null &&
      forgedItem.job === null,
  );
  check(
    "Known customer + sibling customer's request/job are not exposed",
    siblingLinkedItem?.customerKnown === true &&
      siblingLinkedItem.customer?.id === customerA.id &&
      siblingLinkedItem.request === null &&
      siblingLinkedItem.job === null,
  );
  check(
    "Normal LOGGED phone with a linked ESCALATION event appears once",
    loggedEscalationItem?.source === "PHONE_INTERACTION" &&
      loggedEscalationItem.kind === "MANUAL_PHONE" &&
      loggedEscalationItem.status === "LOGGED" &&
      loggedEscalationItem.receptionistKind === "ESCALATION" &&
      linkedEscalationStandalone.length === 0,
  );
  check(
    "Foreign phoneInteractionId does not leak or drop the local receptionist event",
    foreignPhoneEventItem?.source === "RECEPTIONIST_EVENT" &&
      foreignPhoneEventItem.id === localEventForeignPhone.id &&
      !JSON.stringify(centerA).includes("Beta phone must not leak") &&
      !centerB.queue.some((row) => row.id === localEventForeignPhone.id),
  );
  check(
    "Latest customer communication uses canonical attemptedAt ?? createdAt",
    canonItem?.customerKnown === true &&
      canonItem.lastCustomerCommunication?.channel === "EMAIL" &&
      canonItem.lastCustomerCommunication?.occurredAt === canonLatest.createdAt.toISOString() &&
      canonItem.laterCommunicationRecorded === true,
  );
  check(
    "No later communication is stated only after the bounded per-customer lookup",
    noLaterItem?.customerKnown === true &&
      noLaterItem.lastCustomerCommunication === null &&
      noLaterItem.laterCommunicationRecorded === false &&
      unknownItem?.lastCustomerCommunication === null &&
      unknownItem.laterCommunicationRecorded === null,
  );
  check(
    "Standalone inbound receptionist event stays in the recorded queue as unknown when unmatched",
    inboundItem?.source === "RECEPTIONIST_EVENT" &&
      inboundItem.customerKnown === false &&
      inboundItem.direction === "INBOUND" &&
      inboundItem.status === "SKIPPED_NOT_CONNECTED" &&
      inboundItem.logLeadHref === OWNER_LOG_LEAD_HREF,
  );
  check(
    "Later recorded communication is reported from timestamps, not invented resolution",
    knownItem?.laterCommunicationRecorded === true &&
      knownItem.lastCustomerCommunication?.channel === "EMAIL" &&
      knownItem.lastCustomerCommunication?.isThisCallRecord === false &&
      laterEmail.id &&
      centerA.voiceConnected === false &&
      centerA.voiceReason === VOICE_NOT_CONNECTED_REASON,
  );
  check(
    "Loading the workspace does not send or mutate communications or phone status",
    afterComms === beforeComms &&
      afterPhones.length === beforePhones.length &&
      afterPhones.every((row) => {
        const before = beforePhones.find((item) => item.id === row.id);
        return before && before.status === row.status && before.kind === row.kind;
      }) &&
      afterPhones.every((row) => row.status !== "CLOSED"),
  );

  console.log("\nDB — MEMBER access stays office-narrow");
  let memberDenied = false;
  try {
    await loadReceptionistRecoveryCenter(prisma, tenantA.memberAccess);
  } catch (error) {
    memberDenied = error instanceof ForbiddenError;
  }
  let memberCapabilityDenied = false;
  try {
    requireBusinessCapability(tenantA.memberAccess, CAPABILITIES.MANAGE_COMMUNICATIONS);
  } catch (error) {
    memberCapabilityDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot load the office-wide recovery queue", memberDenied);
  check("MEMBER still lacks MANAGE_COMMUNICATIONS", memberCapabilityDenied);

  console.log("\nDB — Bounded queue and specialist recorded facts");
  const overflowKeys = [];
  for (let i = 0; i < RECEPTIONIST_RECOVERY_QUEUE_LIMIT + 5; i += 1) {
    overflowKeys.push(`overflow-${i}-${randomUUID()}`);
  }
  await prisma.phoneInteraction.createMany({
    data: overflowKeys.map((key, index) => ({
      businessId: tenantA.business.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: `Overflow missed call ${index + 1}`,
      idempotencyKey: key,
    })),
  });
  const overflowCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
  check(
    "Queue stays bounded even when more recorded attention items exist",
    overflowCenter.queue.length === RECEPTIONIST_RECOVERY_QUEUE_LIMIT &&
      overflowCenter.queueLimit === RECEPTIONIST_RECOVERY_QUEUE_LIMIT &&
      overflowCenter.recordedMissedCallCount >= RECEPTIONIST_RECOVERY_QUEUE_LIMIT + 5,
  );

  const facts = {};
  const factKeys = [];
  appendReceptionistRecoveryFacts(facts, factKeys, {
    phoneInteractions: [
      { kind: "MISSED_CALL" },
      { kind: "MISSED_CALL" },
      { kind: "MISSED_CALL" },
      { kind: "MANUAL_PHONE" },
    ],
    factsCap: 24,
  });
  check(
    "Specialist missed-call fact is the bounded sample count only",
    facts[RECEPTIONIST_RECOVERY_FACT_KEYS.missedCallCount] === "3" &&
      factKeys.includes(RECEPTIONIST_RECOVERY_FACT_KEYS.missedCallCount) &&
      !Object.keys(facts).includes("communications-recorded-caller-without-later-communication-count"),
  );

  const scanTenant = await seedBusiness("Scan Retention");
  const oldPhone = await prisma.phoneInteraction.create({
    data: {
      businessId: scanTenant.business.id,
      kind: "MANUAL_PHONE",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Old logged phone outside the bounded scan.",
      occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      idempotencyKey: `old-outside-scan-${randomUUID()}`,
    },
  });
  await prisma.phoneInteraction.createMany({
    data: Array.from({ length: RECEPTIONIST_RECOVERY_SCAN_LIMIT }, (_, index) => ({
      businessId: scanTenant.business.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: `Recent scan filler ${index + 1}`,
      occurredAt: new Date(Date.now() - index * 1000),
      idempotencyKey: `scan-filler-${index}-${randomUUID()}`,
    })),
  });
  const outsideScanEvent = await prisma.receptionistEvent.create({
    data: {
      businessId: scanTenant.business.id,
      phoneInteractionId: oldPhone.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Escalation linked to a phone outside the scan." },
      idempotencyKey: `outside-scan-${randomUUID()}`,
    },
  });
  const scanCenter = await loadReceptionistRecoveryCenter(prisma, scanTenant.access);
  const outsideEventItem = scanCenter.queue.find((row) => row.id === outsideScanEvent.id);
  check(
    "Linked attention event to a phone outside the scan still appears standalone",
    outsideEventItem?.source === "RECEPTIONIST_EVENT" &&
      outsideEventItem.receptionistKind === "ESCALATION" &&
      !scanCenter.queue.some((row) => row.id === oldPhone.id && row.source === "PHONE_INTERACTION") &&
      scanCenter.queue.filter((row) => row.id === outsideScanEvent.id).length === 1,
  );

  const tenantBAfter = await loadReceptionistRecoveryCenter(prisma, tenantB.access);
  check(
    "Overflow writes on tenant A never appear on tenant B",
    tenantBAfter.queue.length === 0 && tenantBAfter.recordedMissedCallCount === 0,
  );

  console.log("\nDB — Exact inbound event count is not the bounded scan length");
  const inboundTenant = await seedBusiness("Inbound Count");
  const inboundForeign = await seedBusiness("Inbound Foreign");
  const inboundOverflow = RECEPTIONIST_RECOVERY_SCAN_LIMIT + 12;
  await prisma.receptionistEvent.createMany({
    data: Array.from({ length: inboundOverflow }, (_, index) => ({
      businessId: inboundTenant.business.id,
      kind: "INBOUND_CALL",
      status: "SKIPPED_NOT_CONNECTED",
      provider: "none",
      providerConnected: false,
      payload: { summary: `Inbound overflow ${index + 1}` },
      idempotencyKey: `inbound-overflow-${index}-${randomUUID()}`,
    })),
  });
  await prisma.receptionistEvent.createMany({
    data: Array.from({ length: 4 }, (_, index) => ({
      businessId: inboundTenant.business.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: `Non-inbound ${index + 1}` },
      idempotencyKey: `non-inbound-${index}-${randomUUID()}`,
    })),
  });
  const foreignInbound = await prisma.receptionistEvent.create({
    data: {
      businessId: inboundForeign.business.id,
      kind: "INBOUND_CALL",
      status: "SKIPPED_NOT_CONNECTED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Foreign inbound must not enter inbound count." },
      idempotencyKey: `foreign-inbound-${randomUUID()}`,
    },
  });
  const inboundCenter = await loadReceptionistRecoveryCenter(prisma, inboundTenant.access);
  const inboundCenterForeign = await loadReceptionistRecoveryCenter(prisma, inboundForeign.access);
  const exactInbound = await prisma.receptionistEvent.count({
    where: { businessId: inboundTenant.business.id, kind: "INBOUND_CALL" },
  });
  const exactForeignInbound = await prisma.receptionistEvent.count({
    where: { businessId: inboundForeign.business.id, kind: "INBOUND_CALL" },
  });
  check(
    "More inbound events than the scan limit exist and recordedInboundEventCount is the exact same-business count",
    inboundOverflow > RECEPTIONIST_RECOVERY_SCAN_LIMIT &&
      exactInbound === inboundOverflow &&
      inboundCenter.recordedInboundEventCount === exactInbound &&
      inboundCenter.recordedInboundEventCount === inboundOverflow,
  );
  check(
    "Foreign-tenant inbound events do not enter recordedInboundEventCount",
    inboundCenter.recordedInboundEventCount === inboundOverflow &&
      exactForeignInbound === 1 &&
      inboundCenterForeign.recordedInboundEventCount === 1 &&
      inboundCenterForeign.queue.some((row) => row.id === foreignInbound.id) &&
      !inboundCenter.queue.some((row) => row.id === foreignInbound.id) &&
      !JSON.stringify(inboundCenter).includes("Foreign inbound must not enter inbound count."),
  );
  check(
    "Queue stays bounded when inbound events exceed the scan limit",
    inboundCenter.queue.length === RECEPTIONIST_RECOVERY_QUEUE_LIMIT &&
      inboundCenter.queueLimit === RECEPTIONIST_RECOVERY_QUEUE_LIMIT &&
      inboundCenter.recordedInboundEventCount > RECEPTIONIST_RECOVERY_SCAN_LIMIT,
  );

  console.log("\nDB — Standalone receptionist direction is recorded, not inferred");
  const directionTenant = await seedBusiness("Direction Truth");
  const standaloneInbound = await prisma.receptionistEvent.create({
    data: {
      businessId: directionTenant.business.id,
      kind: "INBOUND_CALL",
      status: "SKIPPED_NOT_CONNECTED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Standalone inbound call.", direction: "OUTBOUND" },
      idempotencyKey: `dir-inbound-${randomUUID()}`,
    },
  });
  const standaloneEscalation = await prisma.receptionistEvent.create({
    data: {
      businessId: directionTenant.business.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Standalone escalation.", direction: "INBOUND" },
      idempotencyKey: `dir-standalone-esc-${randomUUID()}`,
    },
  });
  const outboundPhone = await prisma.phoneInteraction.create({
    data: {
      businessId: directionTenant.business.id,
      kind: "MANUAL_PHONE",
      status: "LOGGED",
      direction: "OUTBOUND",
      summary: "Recorded outbound phone with linked escalation.",
      idempotencyKey: `dir-outbound-phone-${randomUUID()}`,
    },
  });
  await prisma.receptionistEvent.create({
    data: {
      businessId: directionTenant.business.id,
      phoneInteractionId: outboundPhone.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Linked escalation on outbound phone.", direction: "INBOUND" },
      idempotencyKey: `dir-outbound-esc-${randomUUID()}`,
    },
  });
  const inboundPhone = await prisma.phoneInteraction.create({
    data: {
      businessId: directionTenant.business.id,
      kind: "MANUAL_PHONE",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Recorded inbound phone with linked escalation.",
      idempotencyKey: `dir-inbound-phone-${randomUUID()}`,
    },
  });
  await prisma.receptionistEvent.create({
    data: {
      businessId: directionTenant.business.id,
      phoneInteractionId: inboundPhone.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Linked escalation on inbound phone.", direction: "OUTBOUND" },
      idempotencyKey: `dir-inbound-esc-${randomUUID()}`,
    },
  });
  const directionCenter = await loadReceptionistRecoveryCenter(prisma, directionTenant.access);
  const standaloneInboundItem = directionCenter.queue.find((row) => row.id === standaloneInbound.id);
  const standaloneEscalationItem = directionCenter.queue.find((row) => row.id === standaloneEscalation.id);
  const outboundLinkedItem = directionCenter.queue.find((row) => row.id === outboundPhone.id);
  const inboundLinkedItem = directionCenter.queue.find((row) => row.id === inboundPhone.id);
  check(
    "Standalone INBOUND_CALL renders direction INBOUND",
    standaloneInboundItem?.source === "RECEPTIONIST_EVENT" &&
      standaloneInboundItem.kind === "INBOUND_CALL" &&
      standaloneInboundItem.direction === "INBOUND",
  );
  check(
    "Standalone ESCALATION without a phone does not render INBOUND",
    standaloneEscalationItem?.source === "RECEPTIONIST_EVENT" &&
      standaloneEscalationItem.kind === "ESCALATION" &&
      standaloneEscalationItem.direction !== "INBOUND",
  );
  check(
    "Standalone ESCALATION says direction not recorded / UNKNOWN",
    standaloneEscalationItem?.direction === "UNKNOWN" &&
      uiSrc.includes("Direction not recorded"),
  );
  check(
    "Linked ESCALATION on an OUTBOUND PhoneInteraction preserves OUTBOUND",
    outboundLinkedItem?.source === "PHONE_INTERACTION" &&
      outboundLinkedItem.receptionistKind === "ESCALATION" &&
      outboundLinkedItem.direction === "OUTBOUND",
  );
  check(
    "Linked ESCALATION on an INBOUND PhoneInteraction preserves INBOUND",
    inboundLinkedItem?.source === "PHONE_INTERACTION" &&
      inboundLinkedItem.receptionistKind === "ESCALATION" &&
      inboundLinkedItem.direction === "INBOUND",
  );
  check(
    "Direction is not inferred from receptionist payload",
    standaloneInboundItem?.direction === "INBOUND" &&
      standaloneEscalationItem?.direction === "UNKNOWN" &&
      outboundLinkedItem?.direction === "OUTBOUND" &&
      inboundLinkedItem?.direction === "INBOUND" &&
      !recoverySrc.includes("payload.direction") &&
      !recoverySrc.includes('payload["direction"]'),
  );
  check(
    "Known callback-needed queue item can record disposition; unknown missed without callback cannot",
    knownItem?.canRecordDisposition === true &&
      unknownItem?.canRecordDisposition === false &&
      inboundItem?.canRecordDisposition === false,
  );

  console.log("\nDB — Authorized manual disposition leaves the owner queue");
  const dispositionTenant = await seedBusiness("Disposition Recovery");
  const dispositionForeign = await seedBusiness("Disposition Foreign");
  const dispositionCustomer = await prisma.customer.create({
    data: {
      businessId: dispositionTenant.business.id,
      name: "Disposition Known Caller",
      phone: "5553219876",
      email: "disposition-known@example.com",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const knownCallback = await recordMissedOrManualCall(prisma, dispositionTenant.access, {
    kind: "MISSED_CALL",
    customerId: dispositionCustomer.id,
    callerPhone: "5553219876",
    summary: "Known caller still needs a callback.",
    callbackNeeded: true,
    idempotencyKey: `disp-known-${randomUUID()}`,
  });
  const unknownCallback = await recordMissedOrManualCall(prisma, dispositionTenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5550001111",
    summary: "Unknown caller still needs a callback.",
    callbackNeeded: true,
    idempotencyKey: `disp-unknown-${randomUUID()}`,
  });
  const ordinaryMissed = await recordMissedOrManualCall(prisma, dispositionTenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5550002222",
    summary: "Missed call without callback needed stays in the scan unless disposed.",
    callbackNeeded: false,
    idempotencyKey: `disp-ordinary-${randomUUID()}`,
  });
  const escalatedCallback = await prisma.phoneInteraction.create({
    data: {
      businessId: dispositionTenant.business.id,
      customerId: dispositionCustomer.id,
      kind: "MISSED_CALL",
      status: "CALLBACK_NEEDED",
      direction: "INBOUND",
      callerLast4: "9876",
      summary: "Callback-needed phone with a linked escalation.",
      callbackNeeded: true,
      idempotencyKey: `disp-escalated-${randomUUID()}`,
    },
  });
  await prisma.receptionistEvent.create({
    data: {
      businessId: dispositionTenant.business.id,
      customerId: dispositionCustomer.id,
      phoneInteractionId: escalatedCallback.id,
      kind: "ESCALATION",
      status: "ESCALATED",
      provider: "none",
      providerConnected: false,
      payload: { summary: "Linked escalation must not keep a handled phone in queue." },
      idempotencyKey: `disp-escalated-event-${randomUUID()}`,
    },
  });
  const beforeUnknown = await prisma.phoneInteraction.findFirst({
    where: { id: unknownCallback.phoneInteractionId, businessId: dispositionTenant.business.id },
  });
  const commsBeforeDisposition = await prisma.customerCommunication.count({
    where: { businessId: dispositionTenant.business.id },
  });
  const beforeCenter = await loadReceptionistRecoveryCenter(prisma, dispositionTenant.access);
  const beforeCallbackCount = beforeCenter.recordedCallbackNeededCount;

  let memberDispositionDenied = false;
  try {
    await recordReceptionistCallbackDisposition(prisma, dispositionTenant.memberAccess, {
      phoneInteractionId: knownCallback.phoneInteractionId,
    });
  } catch (error) {
    memberDispositionDenied = error instanceof ForbiddenError;
  }
  const memberCenter = await (async () => {
    try {
      await loadReceptionistRecoveryCenter(prisma, dispositionTenant.memberAccess);
      return "loaded";
    } catch (error) {
      return error instanceof ForbiddenError ? "forbidden" : "other";
    }
  })();
  const foreignDecision = await recordReceptionistCallbackDisposition(prisma, dispositionForeign.access, {
    phoneInteractionId: knownCallback.phoneInteractionId,
  });
  const spoofedBrowser = await recordReceptionistCallbackDisposition(prisma, dispositionTenant.access, {
    phoneInteractionId: knownCallback.phoneInteractionId,
    browserBusinessId: dispositionForeign.business.id,
  });
  const ordinaryDecision = await recordReceptionistCallbackDisposition(prisma, dispositionTenant.access, {
    phoneInteractionId: ordinaryMissed.phoneInteractionId,
  });
  const knownFirst = await recordReceptionistCallbackDisposition(prisma, dispositionTenant.adminAccess, {
    phoneInteractionId: knownCallback.phoneInteractionId,
  });
  const knownSecond = await recordReceptionistCallbackDisposition(prisma, dispositionTenant.adminAccess, {
    phoneInteractionId: knownCallback.phoneInteractionId,
  });
  const unknownDecision = await recordReceptionistCallbackDisposition(prisma, dispositionTenant.access, {
    phoneInteractionId: unknownCallback.phoneInteractionId,
  });
  const escalatedDecision = await recordReceptionistCallbackDisposition(prisma, dispositionTenant.access, {
    phoneInteractionId: escalatedCallback.id,
  });

  const afterUnknown = await prisma.phoneInteraction.findFirst({
    where: { id: unknownCallback.phoneInteractionId, businessId: dispositionTenant.business.id },
  });
  const afterKnown = await prisma.phoneInteraction.findFirst({
    where: { id: knownCallback.phoneInteractionId, businessId: dispositionTenant.business.id },
  });
  const afterEscalated = await prisma.phoneInteraction.findFirst({
    where: { id: escalatedCallback.id, businessId: dispositionTenant.business.id },
  });
  const afterOrdinary = await prisma.phoneInteraction.findFirst({
    where: { id: ordinaryMissed.phoneInteractionId, businessId: dispositionTenant.business.id },
  });
  const afterCenter = await loadReceptionistRecoveryCenter(prisma, dispositionTenant.access);
  const foreignCenter = await loadReceptionistRecoveryCenter(prisma, dispositionForeign.access);
  const commsAfterDisposition = await prisma.customerCommunication.count({
    where: { businessId: dispositionTenant.business.id },
  });
  const dispositionEvents = await prisma.receptionistEvent.findMany({
    where: {
      businessId: dispositionTenant.business.id,
      kind: RECEPTIONIST_MANUAL_DISPOSITION_KIND,
    },
    orderBy: { createdAt: "asc" },
  });
  const knownAction = afterKnown?.followUpActionItemId
    ? await prisma.businessActionItem.findFirst({
        where: { id: afterKnown.followUpActionItemId, businessId: dispositionTenant.business.id },
      })
    : null;

  check("MEMBER cannot record a receptionist disposition", memberDispositionDenied);
  check("MEMBER still cannot load the office recovery queue", memberCenter === "forbidden");
  check(
    "Foreign tenant cannot dispose another tenant's callback-needed item",
    foreignDecision.ok === false &&
      foreignDecision.failureReason === RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON &&
      foreignDecision.phoneInteractionId === null &&
      !JSON.stringify(foreignDecision).includes(dispositionCustomer.name),
  );
  check(
    "Browser businessId never authorizes a receptionist disposition",
    spoofedBrowser.ok === false &&
      spoofedBrowser.failureReason === RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON,
  );
  check(
    "Plain missed calls without callbackNeeded stay recorded attention; this writer does not clear them",
    ordinaryDecision.ok === false &&
      ordinaryDecision.failureReason === RECEPTIONIST_DISPOSITION_NOT_CALLBACK_REASON &&
      afterOrdinary?.status === "LOGGED" &&
      afterOrdinary.callbackNeeded === false,
  );
  check(
    "ADMIN can record the canonical CLOSED disposition",
    knownFirst.ok &&
      knownFirst.reused === false &&
      knownFirst.status === PHONE_INTERACTION_CLOSED_STATUS &&
      knownFirst.callbackNeeded === false &&
      afterKnown?.status === "CLOSED" &&
      afterKnown.callbackNeeded === false &&
      afterKnown.customerId === dispositionCustomer.id &&
      afterKnown.kind === "MISSED_CALL",
  );
  check(
    "Double-click reuses the same ReceptionistEvent and does not reopen or duplicate the write",
    knownSecond.ok &&
      knownSecond.reused === true &&
      knownSecond.replayedViaLookup === true &&
      knownSecond.receptionistEventId === knownFirst.receptionistEventId &&
      knownSecond.status === "CLOSED" &&
      dispositionEvents.filter((row) => row.phoneInteractionId === knownCallback.phoneInteractionId).length ===
        1 &&
      dispositionEvents.find((row) => row.phoneInteractionId === knownCallback.phoneInteractionId)
        ?.idempotencyKey === receptionistDispositionIdempotencyKey(knownCallback.phoneInteractionId),
  );
  check(
    "Unknown-caller record is preserved and stays unknown",
    unknownDecision.ok &&
      afterUnknown?.id === beforeUnknown.id &&
      afterUnknown.customerId === null &&
      afterUnknown.status === "CLOSED" &&
      afterUnknown.callbackNeeded === false &&
      afterUnknown.kind === "MISSED_CALL" &&
      afterUnknown.summary === beforeUnknown.summary &&
      afterUnknown.callerLast4 === beforeUnknown.callerLast4,
  );
  check(
    "Disposition does not invent a successful contact communication",
    commsAfterDisposition === commsBeforeDisposition &&
      dispositionEvents.every((row) => {
        const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
        return (
          row.status === RECEPTIONIST_MANUAL_DISPOSITION_STATUS &&
          payload.contactClaimed === false &&
          payload.channel === null
        );
      }),
  );
  check(
    "Handled callback-needed items leave the owner queue, including phones with a linked escalation",
    !afterCenter.queue.some((row) => row.id === knownCallback.phoneInteractionId) &&
      !afterCenter.queue.some((row) => row.id === unknownCallback.phoneInteractionId) &&
      !afterCenter.queue.some((row) => row.id === escalatedCallback.id) &&
      escalatedDecision.ok &&
      afterEscalated?.status === "CLOSED" &&
      afterCenter.queue.some((row) => row.id === ordinaryMissed.phoneInteractionId) &&
      afterCenter.recordedCallbackNeededCount === beforeCallbackCount - 3 &&
      afterCenter.recordedMissedCallCount === beforeCenter.recordedMissedCallCount,
  );
  check(
    "Linked callback task is marked DONE without claiming a send",
    knownAction?.status === "DONE" &&
      knownFirst.actionItemId === knownAction.id,
  );
  check(
    "Foreign tenant queue and counts stay empty after another tenant's dispositions",
    foreignCenter.queue.length === 0 &&
      foreignCenter.recordedCallbackNeededCount === 0 &&
      foreignCenter.recordedMissedCallCount === 0 &&
      !JSON.stringify(foreignCenter).includes("Disposition Known Caller"),
  );

  console.log("\nDB — Simultaneous authorized decisions settle once");
  const raceTenant = await seedBusiness("Disposition Race");
  const racePhone = await recordMissedOrManualCall(prisma, raceTenant.access, {
    kind: "MISSED_CALL",
    callerPhone: "5558887777",
    summary: "Two owners decide at the same time.",
    callbackNeeded: true,
    idempotencyKey: `disp-race-${randomUUID()}`,
  });
  const raceClientA = new PrismaClient({ datasourceUrl: testUrl });
  const raceClientB = new PrismaClient({ datasourceUrl: testUrl });
  const [raceLeft, raceRight] = await Promise.all([
    recordReceptionistCallbackDisposition(raceClientA, raceTenant.access, {
      phoneInteractionId: racePhone.phoneInteractionId,
    }),
    recordReceptionistCallbackDisposition(raceClientB, raceTenant.adminAccess, {
      phoneInteractionId: racePhone.phoneInteractionId,
    }),
  ]);
  await Promise.all([raceClientA.$disconnect(), raceClientB.$disconnect()]);
  const racedPhone = await prisma.phoneInteraction.findFirst({
    where: { id: racePhone.phoneInteractionId, businessId: raceTenant.business.id },
  });
  const racedEvents = await prisma.receptionistEvent.findMany({
    where: {
      businessId: raceTenant.business.id,
      phoneInteractionId: racePhone.phoneInteractionId,
      kind: RECEPTIONIST_MANUAL_DISPOSITION_KIND,
    },
  });
  const racedCenter = await loadReceptionistRecoveryCenter(prisma, raceTenant.access);
  const racedAction = racedPhone?.followUpActionItemId
    ? await prisma.businessActionItem.findFirst({
        where: { id: racedPhone.followUpActionItemId, businessId: raceTenant.business.id },
      })
    : null;
  check(
    "Simultaneous dispositions both succeed and write CLOSED exactly once",
    raceLeft.ok &&
      raceRight.ok &&
      raceLeft.receptionistEventId === raceRight.receptionistEventId &&
      racedEvents.length === 1 &&
      racedPhone?.status === "CLOSED" &&
      racedPhone.callbackNeeded === false &&
      racedPhone.customerId === null &&
      racedAction?.status === "DONE" &&
      !racedCenter.queue.some((row) => row.id === racePhone.phoneInteractionId) &&
      [raceLeft.reused, raceRight.reused].filter(Boolean).length === 1,
  );

  await proveClosedLogReplay();
  await proveEventIdempotencyLookup();
  await proveDispositionActionRoleCheck();
  }
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (!mutationKind && failures === 0) {
  console.log("\nMUTATION — revert each guard and show the matching test fail cleanly");
  const mutations = [
    {
      kind: "closed-preserve",
      file: "src/lib/communications/missed-call.ts",
      find: "  // PHONE_LOG_PRESERVE_CLOSED\n  const alreadyClosed = claimed.status === \"CLOSED\";",
      replace: "  const alreadyClosed = false;",
    },
    {
      kind: "event-idempotency-lookup",
      file: "src/lib/communications/receptionist-disposition.ts",
      find: "  // RECEPTIONIST_DISPOSITION_IDEMPOTENCY_LOOKUP\n  const existing = await db.receptionistEvent.findFirst({",
      replace: "  const existing = null; await db.receptionistEvent.findFirst({",
    },
  ];
  const scriptPath = fileURLToPath(import.meta.url);
  for (const mutation of mutations) {
    const abs = fileURLToPath(new URL(`../${mutation.file}`, import.meta.url));
    const original = readFileSync(abs, "utf8");
    if (!original.includes(mutation.find)) {
      check(`mutation ${mutation.kind} found its target`, false);
      continue;
    }
    writeFileSync(abs, original.replace(mutation.find, mutation.replace));
    try {
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", scriptPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: testUrl,
            RECEPTIONIST_RECOVERY_MUTATION: mutation.kind,
          },
        },
      );
      const failedCleanly =
        child.status !== 0 &&
        !/PrismaClientKnownRequestError|25P02|Unique constraint/.test(`${child.stdout}\n${child.stderr}`);
      check(`mutation ${mutation.kind} fails cleanly without a Postgres crash`, failedCleanly);
      if (!failedCleanly) {
        console.error(child.stdout.slice(-2500));
        console.error(child.stderr.slice(-1500));
      }
    } finally {
      writeFileSync(abs, original);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} receptionist recovery check(s) failed (${passes} passed).`);
  process.exit(1);
}
console.log(`\nReceptionist recovery center checks passed (${passes} passed).`);
