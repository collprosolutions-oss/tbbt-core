/**
 * Deep COMMUNICATIONS specialist. Same specialist identity as the PR1 placeholder.
 *
 * Loads one bounded read-only projection when selected. Does not send
 * email or SMS, create threads, mutate consent, write communication
 * records, or propose owner actions. Does not call other specialists.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  effectiveAppointmentConfirmationStatus,
  hasPendingAppointmentChangeRequest,
  type AppointmentConfirmationStatus,
} from "@/lib/appointment-confirmation";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import {
  recordCommunicationsProjectionLoad,
  recordCommunicationsSpecialistInterpretation,
  shouldInjectCommunicationsLoadFailure,
} from "@/lib/chief-of-staff/communications-snapshot";
import type {
  CosEntityHints,
  SpecialistFinding,
  SpecialistResult,
  SpecialistSkipReason,
} from "@/lib/chief-of-staff/types";
import {
  evaluateComposeChannelEligibility,
  evaluateEmailEligibility,
} from "@/lib/communications/consent";
import { departmentSmsComposeRequiresAddon } from "@/lib/communications/sms-policy";
import {
  EMAIL_NOT_CONFIGURED_REASON,
  SMS_ADDON_NOT_ENTITLED_REASON,
  SMS_NOT_CONFIGURED_REASON,
  VOICE_NOT_CONNECTED_REASON,
} from "@/lib/communications/types";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { resolveStoredSmsConsent } from "@/lib/customer-messaging/consent";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import type { SmsConsentStatus } from "@/lib/customer-messaging/types";
import { isUsableEmail } from "@/lib/mail";
import { getProductCapabilityDefinition } from "@/lib/product-catalog";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog/codes";
import { resolveProductEntitlement } from "@/lib/product-entitlements";
import { isEmailDeliveryConfigured } from "@/lib/settings";

type Db = PrismaClient | Prisma.TransactionClient;

export const COMMUNICATIONS_OWNED_RECOMMENDATION_KEYS = [
  "communications-failed-delivery",
  "communications-sms-consent-revoked",
  "communications-sms-consent-unknown",
  "communications-channel-unavailable",
  "communications-appointment-different-time",
  "communications-pending-delivery",
  "communications-awaiting-appointment",
] as const;

export type CommunicationsOwnedRecommendationKey =
  (typeof COMMUNICATIONS_OWNED_RECOMMENDATION_KEYS)[number];

export const COMMUNICATIONS_CONTEXT_CAPS = {
  customers: 8,
  messages: 12,
  appointments: 8,
  phoneInteractions: 8,
  findings: 16,
  facts: 24,
  entityIds: 4,
  subjectPreview: 80,
} as const;

const PENDING_STATUSES = new Set(["DRAFT", "READY", "QUEUED", "ACCEPTED"]);
const FAILED_STATUSES = new Set(["FAILED"]);
const BLOCKED_STATUSES = new Set(["BLOCKED", "NOT_SENT"]);

const FORBIDDEN_PROJECTION_KEYS = [
  "email",
  "phone",
  "bodySnapshot",
  "messageBody",
  "body",
  "destinationLast4",
  "destinationFingerprint",
  "fingerprint",
  "last4",
  "providerMessageId",
  "providerMetadata",
  "operationalSmsNumber",
  "accountSid",
  "authToken",
  "apiKey",
  "password",
  "secret",
  "token",
  "propertyAccessInstructions",
  "appointmentChangeRequestNote",
  "normalizedPhone",
  "contactEmail",
  "contactPhone",
  "consentToken",
];

export function isCommunicationsOwnedRecommendationKey(key: string): boolean {
  return key.startsWith("communications-");
}

export function communicationsEntitlementLimitation(
  reason: SpecialistSkipReason,
  missing?: readonly string[],
) {
  if (reason === "NOT_AUTHORIZED") {
    return "Communications records were not loaded because this role cannot manage communications. Assigned field work is not whole-customer communication history. Missing Communications data is not treated as empty recorded contact.";
  }
  if (reason === "NOT_ENTITLED") {
    return "Communications records were not loaded because this workspace does not have an active operating subscription. Missing Communications data is not treated as zero messages.";
  }
  if (reason === "PRODUCT_CAPABILITY_MISSING") {
    const names = (missing ?? []).map(
      (code) => getProductCapabilityDefinition(code as ProductCapabilityCode).displayName,
    );
    return `Communications records were not loaded because this workspace does not have ${names.join(" and ")}. Missing Communications data is not treated as empty recorded contact.`;
  }
  return "Recorded Communications data is unavailable. Missing Communications data is not treated as zero messages.";
}

export const COMMUNICATIONS_FAILURE_LIMITATION =
  "Recorded Communications data could not be loaded. No empty inbox, invented consent, or invented send was substituted.";

export const TARGET_CONSISTENCY_LIMITATION =
  "The supplied record targets did not resolve to one consistent owned customer context.";

export type SafeChannelEligibility = {
  channel: "EMAIL" | "SMS" | "PHONE";
  permitted: boolean;
  available: boolean;
  reason: string | null;
  ownerReason: string | null;
};

export type CommunicationsCustomerProjection = {
  id: string;
  businessId: string;
  displayName: string;
  hasPhone: boolean;
  hasEmail: boolean;
  smsConsentStatus: SmsConsentStatus;
  smsEligible: boolean;
  smsBlockReason: string | null;
  emailAvailable: boolean;
  emailConfigured: boolean;
  emailEligible: boolean;
  targeted: boolean;
};

export type CommunicationsMessageProjection = {
  id: string;
  businessId: string;
  customerId: string;
  channel: string;
  direction: string;
  purpose: string;
  status: string;
  relatedType: string | null;
  relatedId: string | null;
  failureReason: string | null;
  consentContext: string | null;
  provider: string | null;
  occurredAt: string;
  hasSubject: boolean;
  subjectPreview: string | null;
  hasBody: boolean;
};

export type CommunicationsAppointmentProjection = {
  jobId: string;
  businessId: string;
  customerId: string | null;
  confirmationStatus: AppointmentConfirmationStatus;
  notificationStatus: string | null;
  notificationFailed: boolean;
  differentTimeRequested: boolean;
  awaitingCustomer: boolean;
  scheduledAt: string | null;
};

export type CommunicationsPhoneProjection = {
  id: string;
  businessId: string;
  customerId: string | null;
  kind: string;
  status: string;
  direction: string;
  callbackNeeded: boolean;
  occurredAt: string;
};

export type CommunicationsChannelState = {
  emailConfigured: boolean;
  smsConfigured: boolean;
  smsEntitled: boolean;
  voiceConnected: false;
  voiceLimitation: string;
  smsLimitation: string | null;
  emailLimitation: string | null;
};

export type CommunicationsProjectionTotals = {
  customers: number;
  messages: number;
  failedDeliveries: number;
  pendingDeliveries: number;
  blockedOrNotSent: number;
  inbound: number;
  outbound: number;
  smsMessages: number;
  emailMessages: number;
  revokedConsent: number;
  unknownConsent: number;
  grantedConsent: number;
  differentTimeAppointments: number;
  awaitingAppointments: number;
};

export type CommunicationsDependencySignal = {
  domain: "GROWTH" | "MATERIALS" | "WORKFORCE";
  reason: string;
};

export type CommunicationsProjection = {
  totals: CommunicationsProjectionTotals;
  customers: CommunicationsCustomerProjection[];
  messages: CommunicationsMessageProjection[];
  appointments: CommunicationsAppointmentProjection[];
  phoneInteractions: CommunicationsPhoneProjection[];
  channels: CommunicationsChannelState;
  canReadDeep: boolean;
  targetedCustomerUnauthorized: boolean;
  targetedRequestUnauthorized: boolean;
  targetedJobUnauthorized: boolean;
  targetedMessageUnauthorized: boolean;
  targetedEntityMismatch: boolean;
  signals: CommunicationsDependencySignal[];
  snapshotReused: false;
};

export type CommunicationsSpecialistInput = {
  db: Db;
  access: BusinessAccess;
  catalog: CanonicalRecommendationCatalog;
  question: string;
  entityHints?: CosEntityHints;
  denyProductCapabilities?: ProductCapabilityCode[];
  denyRoleCapabilities?: Capability[];
};

let lastCommunicationsProjection: CommunicationsProjection | null = null;

export function resetLastCommunicationsProjection() {
  lastCommunicationsProjection = null;
}

export function getLastCommunicationsProjection() {
  return lastCommunicationsProjection;
}

function addFact(facts: Record<string, string>, keys: string[], key: string, value: string) {
  if (keys.includes(key) || keys.length >= COMMUNICATIONS_CONTEXT_CAPS.facts) return;
  facts[key] = value;
  keys.push(key);
}

function hasRole(access: BusinessAccess, capability: Capability, deny?: Capability[]) {
  if (deny?.includes(capability)) return false;
  return roleHasCapability(access.workspace.role, capability);
}

function hasDeniedProduct(code: ProductCapabilityCode, deny?: ProductCapabilityCode[]) {
  return Boolean(deny?.includes(code));
}

export function phoneDoesNotGrantConsent(
  hasPhone: boolean,
  smsConsentStatus: string | null | undefined,
): SmsConsentStatus {
  const consent = resolveStoredSmsConsent(smsConsentStatus);
  if (hasPhone && consent === "UNKNOWN") return "UNKNOWN";
  return consent;
}

export function unknownConsentIsNotGranted(status: string | null | undefined) {
  return resolveStoredSmsConsent(status) !== "GRANTED";
}

function assertSafeProjection(projection: CommunicationsProjection) {
  const raw = JSON.stringify(projection);
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Communications projection leaked a forbidden field.");
    }
  }
}

export function communicationsProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return FORBIDDEN_PROJECTION_KEYS.some(
    (key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw),
  );
}

function emptyTotals(): CommunicationsProjectionTotals {
  return {
    customers: 0,
    messages: 0,
    failedDeliveries: 0,
    pendingDeliveries: 0,
    blockedOrNotSent: 0,
    inbound: 0,
    outbound: 0,
    smsMessages: 0,
    emailMessages: 0,
    revokedConsent: 0,
    unknownConsent: 0,
    grantedConsent: 0,
    differentTimeAppointments: 0,
    awaitingAppointments: 0,
  };
}

function previewSubject(subject: string | null | undefined) {
  const trimmed = subject?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, COMMUNICATIONS_CONTEXT_CAPS.subjectPreview);
}

function safeChannel(row: {
  channel: string;
  permitted: boolean;
  available: boolean;
  reason: string | null;
  ownerReason: string | null;
}): SafeChannelEligibility {
  const channel =
    row.channel === "EMAIL" || row.channel === "SMS" || row.channel === "PHONE"
      ? row.channel
      : "PHONE";
  return {
    channel,
    permitted: row.permitted,
    available: row.available,
    reason: row.reason,
    ownerReason: row.ownerReason,
  };
}

type GateDecision =
  | { status: "ok"; smsEntitled: boolean }
  | { status: "skip"; skipReason: SpecialistSkipReason; limitation: string };

async function resolveCommunicationsGates(
  db: Db,
  access: BusinessAccess,
  denyProductCapabilities?: ProductCapabilityCode[],
  denyRoleCapabilities?: Capability[],
): Promise<GateDecision> {
  const canManageCommunications = hasRole(
    access,
    CAPABILITIES.MANAGE_COMMUNICATIONS,
    denyRoleCapabilities,
  );
  if (!canManageCommunications) {
    return {
      status: "skip",
      skipReason: "NOT_AUTHORIZED",
      limitation: communicationsEntitlementLimitation("NOT_AUTHORIZED"),
    };
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, slug: true },
  });
  if (!business) {
    return {
      status: "skip",
      skipReason: "UNAVAILABLE",
      limitation: communicationsEntitlementLimitation("UNAVAILABLE"),
    };
  }

  const entitlement = await resolveProductEntitlement(db, business);
  if (!entitlement.operating.canOperate) {
    return {
      status: "skip",
      skipReason: "NOT_ENTITLED",
      limitation: communicationsEntitlementLimitation("NOT_ENTITLED"),
    };
  }

  const smsEntitled =
    !departmentSmsComposeRequiresAddon() ||
    (entitlement.capabilities.includes(PRODUCT_CAPABILITIES.SMS_MESSAGING) &&
      !hasDeniedProduct(PRODUCT_CAPABILITIES.SMS_MESSAGING, denyProductCapabilities));

  return { status: "ok", smsEntitled };
}

type ResolvedTargets = {
  customerId: string | null;
  messageId: string | null;
  scoped: boolean;
  targetedCustomerUnauthorized: boolean;
  targetedRequestUnauthorized: boolean;
  targetedJobUnauthorized: boolean;
  targetedMessageUnauthorized: boolean;
  targetedEntityMismatch: boolean;
};

function suppliedHintCount(hints?: CosEntityHints) {
  if (!hints) return 0;
  return [hints.customerId, hints.requestId, hints.jobId, hints.messageId].filter(Boolean).length;
}

async function resolveTargets(
  db: Db,
  businessId: string,
  hints?: CosEntityHints,
): Promise<ResolvedTargets> {
  const result: ResolvedTargets = {
    customerId: null,
    messageId: null,
    scoped: false,
    targetedCustomerUnauthorized: false,
    targetedRequestUnauthorized: false,
    targetedJobUnauthorized: false,
    targetedMessageUnauthorized: false,
    targetedEntityMismatch: false,
  };

  const derivedCustomerIds: Array<string | null> = [];
  let authorizedMessageId: string | null = null;
  let authorizedMessageCustomerId: string | null = null;

  if (hints?.customerId) {
    result.scoped = true;
    const customer = await db.customer.findFirst({
      where: { id: hints.customerId, businessId },
      select: { id: true, businessId: true },
    });
    if (!customer) result.targetedCustomerUnauthorized = true;
    else derivedCustomerIds.push(customer.id);
  }

  if (hints?.requestId) {
    result.scoped = true;
    const request = await db.serviceRequest.findFirst({
      where: { id: hints.requestId, businessId },
      select: { id: true, customerId: true, businessId: true },
    });
    if (!request) result.targetedRequestUnauthorized = true;
    else derivedCustomerIds.push(request.customerId);
  }

  if (hints?.jobId) {
    result.scoped = true;
    const job = await db.job.findFirst({
      where: { id: hints.jobId, businessId },
      select: { id: true, customerId: true, businessId: true },
    });
    if (!job) result.targetedJobUnauthorized = true;
    else derivedCustomerIds.push(job.customerId);
  }

  if (hints?.messageId) {
    result.scoped = true;
    const message = await db.customerCommunication.findFirst({
      where: { id: hints.messageId, businessId },
      select: { id: true, customerId: true, businessId: true },
    });
    if (!message) result.targetedMessageUnauthorized = true;
    else {
      authorizedMessageId = message.id;
      authorizedMessageCustomerId = message.customerId;
      derivedCustomerIds.push(message.customerId);
    }
  }

  const anyUnauthorized =
    result.targetedCustomerUnauthorized ||
    result.targetedRequestUnauthorized ||
    result.targetedJobUnauthorized ||
    result.targetedMessageUnauthorized;
  const resolvedCustomerIds = [...new Set(derivedCustomerIds.filter((id): id is string => Boolean(id)))];
  const hasUnresolvedAuthorizedHint = derivedCustomerIds.some((id) => !id);
  const mismatch =
    resolvedCustomerIds.length > 1 ||
    (hasUnresolvedAuthorizedHint && (resolvedCustomerIds.length > 0 || derivedCustomerIds.length > 1));

  if (anyUnauthorized || mismatch) {
    result.customerId = null;
    result.messageId = null;
    result.targetedEntityMismatch = mismatch || (anyUnauthorized && suppliedHintCount(hints) > 1);
    return result;
  }

  result.customerId = resolvedCustomerIds[0] ?? null;
  if (
    authorizedMessageId &&
    authorizedMessageCustomerId &&
    result.customerId &&
    authorizedMessageCustomerId === result.customerId
  ) {
    result.messageId = authorizedMessageId;
  }
  return result;
}

function projectCustomer(input: {
  id: string;
  businessId: string;
  name: string;
  email: string | null;
  phone: string | null;
  smsConsentStatus: string | null;
  targeted: boolean;
  smsEntitled: boolean;
  emailConfigured: boolean;
  smsConfigured: boolean;
}): CommunicationsCustomerProjection {
  const hasPhone = isUsableNormalizedPhone(normalizePhone(input.phone));
  const hasEmail = isUsableEmail(input.email);
  const smsConsentStatus = phoneDoesNotGrantConsent(hasPhone, input.smsConsentStatus);
  const sms = safeChannel(
    evaluateComposeChannelEligibility({
      businessId: input.businessId,
      channel: "SMS",
      email: input.email,
      phone: input.phone,
      smsConsentStatus,
      purpose: "GENERAL",
      preferences: null,
      smsEntitled: input.smsEntitled,
      smsConfigured: input.smsConfigured,
      emailConfigured: input.emailConfigured,
    }),
  );
  const email = safeChannel(
    evaluateEmailEligibility({
      businessId: input.businessId,
      email: input.email,
      deliveryConfigured: input.emailConfigured,
    }),
  );
  return {
    id: input.id,
    businessId: input.businessId,
    displayName: input.name,
    hasPhone,
    hasEmail,
    smsConsentStatus,
    smsEligible: sms.permitted && sms.available,
    smsBlockReason: sms.reason,
    emailAvailable: hasEmail,
    emailConfigured: input.emailConfigured,
    emailEligible: email.permitted && email.available,
    targeted: input.targeted,
  };
}

export async function loadCommunicationsProjection(input: {
  db: Db;
  access: BusinessAccess;
  entityHints?: CosEntityHints;
  smsEntitled: boolean;
}): Promise<CommunicationsProjection> {
  recordCommunicationsProjectionLoad();
  if (shouldInjectCommunicationsLoadFailure()) {
    throw new Error("injected communications load failure");
  }

  const businessId = input.access.businessId;
  const emailConfigured = isEmailDeliveryConfigured();
  const smsConfigured = isCustomerMessagingConfigured();
  const targets = await resolveTargets(input.db, businessId, input.entityHints);

  const failClosed =
    targets.targetedCustomerUnauthorized ||
    targets.targetedRequestUnauthorized ||
    targets.targetedJobUnauthorized ||
    targets.targetedMessageUnauthorized ||
    targets.targetedEntityMismatch;

  const scopedCustomerId = failClosed ? null : targets.customerId;
  const pinnedMessageId = failClosed ? null : targets.messageId;
  const messageWhere: Prisma.CustomerCommunicationWhereInput = { businessId };
  if (scopedCustomerId) messageWhere.customerId = scopedCustomerId;
  if (failClosed || (targets.scoped && !scopedCustomerId)) {
    messageWhere.id = "__no-such-owned-communication__";
  }

  const loadMessages = !failClosed && (Boolean(scopedCustomerId) || !targets.scoped);
  const messageSelect = {
    id: true,
    businessId: true,
    customerId: true,
    direction: true,
    channel: true,
    purpose: true,
    subject: true,
    relatedType: true,
    relatedId: true,
    consentContext: true,
    status: true,
    provider: true,
    failureReason: true,
    createdAt: true,
    attemptedAt: true,
    bodySnapshot: true,
  } as const;
  const messageOrder = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const [recentRows, failedRows, pendingRows, emailRows, smsRows] = loadMessages
    ? await Promise.all([
        input.db.customerCommunication.findMany({
          where: messageWhere,
          orderBy: messageOrder,
          take: COMMUNICATIONS_CONTEXT_CAPS.messages,
          select: messageSelect,
        }),
        input.db.customerCommunication.findMany({
          where: { ...messageWhere, status: { in: [...FAILED_STATUSES] } },
          orderBy: messageOrder,
          take: 4,
          select: messageSelect,
        }),
        input.db.customerCommunication.findMany({
          where: { ...messageWhere, status: { in: [...PENDING_STATUSES] } },
          orderBy: messageOrder,
          take: 4,
          select: messageSelect,
        }),
        input.db.customerCommunication.findMany({
          where: { ...messageWhere, channel: "EMAIL" },
          orderBy: messageOrder,
          take: 4,
          select: messageSelect,
        }),
        input.db.customerCommunication.findMany({
          where: { ...messageWhere, channel: "SMS" },
          orderBy: messageOrder,
          take: 4,
          select: messageSelect,
        }),
      ])
    : [[], [], [], [], []];
  const messageRows = [...recentRows];
  const [messageCount, failedCount, pendingCount, blockedCount, inboundCount, outboundCount, smsCount, emailCount] =
    loadMessages
      ? await Promise.all([
          input.db.customerCommunication.count({ where: messageWhere }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, status: { in: [...FAILED_STATUSES] } },
          }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, status: { in: [...PENDING_STATUSES] } },
          }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, status: { in: [...BLOCKED_STATUSES] } },
          }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, direction: "INBOUND" },
          }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, direction: "OUTBOUND" },
          }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, channel: "SMS" },
          }),
          input.db.customerCommunication.count({
            where: { ...messageWhere, channel: "EMAIL" },
          }),
        ])
      : [0, 0, 0, 0, 0, 0, 0, 0];

  if (pinnedMessageId && scopedCustomerId && !messageRows.some((row) => row.id === pinnedMessageId)) {
    const extra = await input.db.customerCommunication.findFirst({
      where: { id: pinnedMessageId, businessId, customerId: scopedCustomerId },
      select: messageSelect,
    });
    if (extra) messageRows.unshift(extra);
  }
  const selectedMessageRows: typeof messageRows = [];
  const seenMessageIds = new Set<string>();
  const pinMessage = (row: (typeof messageRows)[number] | undefined) => {
    if (!row || seenMessageIds.has(row.id) || selectedMessageRows.length >= COMMUNICATIONS_CONTEXT_CAPS.messages) {
      return;
    }
    selectedMessageRows.push(row);
    seenMessageIds.add(row.id);
  };
  if (pinnedMessageId) pinMessage(messageRows.find((row) => row.id === pinnedMessageId));
  for (const row of failedRows) pinMessage(row);
  for (const row of pendingRows) pinMessage(row);
  pinMessage(emailRows[0]);
  pinMessage(smsRows[0]);
  for (const row of messageRows) pinMessage(row);

  const projectedMessages = selectedMessageRows.map((row) => ({
      id: row.id,
      businessId: row.businessId,
      customerId: row.customerId,
      channel: row.channel,
      direction: row.direction,
      purpose: row.purpose,
      status: row.status,
      relatedType: row.relatedType,
      relatedId: row.relatedId,
      failureReason: row.failureReason,
      consentContext: row.consentContext,
      provider: row.provider,
      occurredAt: (row.attemptedAt ?? row.createdAt).toISOString(),
      hasSubject: Boolean(row.subject?.trim()),
      subjectPreview: previewSubject(row.subject),
      hasBody: Boolean(row.bodySnapshot?.trim()),
    }));

  const customerIds = new Set<string>();
  if (scopedCustomerId) customerIds.add(scopedCustomerId);
  for (const row of projectedMessages) customerIds.add(row.customerId);

  if (!failClosed && (scopedCustomerId || !targets.scoped)) {
    const revoked = await input.db.customer.findMany({
      where: {
        businessId,
        smsConsentStatus: "REVOKED",
        ...(scopedCustomerId ? { id: scopedCustomerId } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: COMMUNICATIONS_CONTEXT_CAPS.customers,
      select: { id: true },
    });
    for (const row of revoked) {
      if (customerIds.size >= COMMUNICATIONS_CONTEXT_CAPS.customers) break;
      customerIds.add(row.id);
    }
  }

  const customerRows =
    customerIds.size > 0
      ? await input.db.customer.findMany({
          where: { businessId, id: { in: [...customerIds] } },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: COMMUNICATIONS_CONTEXT_CAPS.customers,
          select: {
            id: true,
            businessId: true,
            name: true,
            email: true,
            phone: true,
            smsConsentStatus: true,
          },
        })
      : [];

  const customers = customerRows.map((row) =>
    projectCustomer({
      ...row,
      targeted: row.id === scopedCustomerId,
      smsEntitled: input.smsEntitled,
      emailConfigured,
      smsConfigured,
    }),
  );

  const appointmentWhere: Prisma.JobWhereInput = {
    businessId,
    scheduledAt: { not: null },
    ...(scopedCustomerId ? { customerId: scopedCustomerId } : {}),
    ...(failClosed || (targets.scoped && !scopedCustomerId) ? { id: "__no-such-owned-job__" } : {}),
  };
  const appointmentRows = await input.db.job.findMany({
    where: appointmentWhere,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: COMMUNICATIONS_CONTEXT_CAPS.appointments,
    select: {
      id: true,
      businessId: true,
      customerId: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      appointmentConfirmationStatus: true,
      appointmentProposalId: true,
      appointmentConfirmedForProposalId: true,
      appointmentConfirmationSource: true,
      appointmentNotificationStatus: true,
      propertyAccessMethod: true,
      propertyAccessInstructions: true,
      propertyAccessContactName: true,
      propertyAccessContactInfo: true,
      propertyAccessPickupLocation: true,
      propertyAccessNote: true,
    },
  });

  const appointments = appointmentRows.map((row) => {
    const confirmationStatus = effectiveAppointmentConfirmationStatus(row);
    const differentTimeRequested = hasPendingAppointmentChangeRequest(row);
    return {
      jobId: row.id,
      businessId: row.businessId,
      customerId: row.customerId,
      confirmationStatus,
      notificationStatus: row.appointmentNotificationStatus,
      notificationFailed: row.appointmentNotificationStatus === "FAILED",
      differentTimeRequested,
      awaitingCustomer: confirmationStatus === "AWAITING_CUSTOMER",
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
    };
  });

  const phoneWhere: Prisma.PhoneInteractionWhereInput = {
    businessId,
    ...(scopedCustomerId ? { customerId: scopedCustomerId } : {}),
    ...(failClosed || (targets.scoped && !scopedCustomerId) ? { id: "__no-such-owned-phone__" } : {}),
  };
  const phoneRows = await input.db.phoneInteraction.findMany({
    where: phoneWhere,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: COMMUNICATIONS_CONTEXT_CAPS.phoneInteractions,
    select: {
      id: true,
      businessId: true,
      customerId: true,
      kind: true,
      status: true,
      direction: true,
      callbackNeeded: true,
      occurredAt: true,
    },
  });

  const phoneInteractions = phoneRows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    customerId: row.customerId,
    kind: row.kind,
    status: row.status,
    direction: row.direction,
    callbackNeeded: row.callbackNeeded,
    occurredAt: row.occurredAt.toISOString(),
  }));

  const revokedConsent = customers.filter((row) => row.smsConsentStatus === "REVOKED").length;
  const unknownConsent = customers.filter((row) => row.smsConsentStatus === "UNKNOWN").length;
  const grantedConsent = customers.filter((row) => row.smsConsentStatus === "GRANTED").length;

  const channels: CommunicationsChannelState = {
    emailConfigured,
    smsConfigured,
    smsEntitled: input.smsEntitled,
    voiceConnected: false,
    voiceLimitation: VOICE_NOT_CONNECTED_REASON,
    smsLimitation: !input.smsEntitled
      ? SMS_ADDON_NOT_ENTITLED_REASON
      : !smsConfigured
        ? SMS_NOT_CONFIGURED_REASON
        : null,
    emailLimitation: emailConfigured ? null : EMAIL_NOT_CONFIGURED_REASON,
  };

  const signals: CommunicationsDependencySignal[] = [];
  if (appointments.some((row) => row.differentTimeRequested)) {
    signals.push({
      domain: "WORKFORCE",
      reason: "A recorded different-time request is a Communications fact. Workforce owns rescheduling.",
    });
  }

  const projection: CommunicationsProjection = {
    totals: {
      customers: customers.length,
      messages: messageCount,
      failedDeliveries: failedCount,
      pendingDeliveries: pendingCount,
      blockedOrNotSent: blockedCount,
      inbound: inboundCount,
      outbound: outboundCount,
      smsMessages: smsCount,
      emailMessages: emailCount,
      revokedConsent,
      unknownConsent,
      grantedConsent,
      differentTimeAppointments: appointments.filter((row) => row.differentTimeRequested).length,
      awaitingAppointments: appointments.filter((row) => row.awaitingCustomer).length,
    },
    customers,
    messages: projectedMessages,
    appointments,
    phoneInteractions,
    channels,
    canReadDeep: true,
    targetedCustomerUnauthorized: targets.targetedCustomerUnauthorized,
    targetedRequestUnauthorized: targets.targetedRequestUnauthorized,
    targetedJobUnauthorized: targets.targetedJobUnauthorized,
    targetedMessageUnauthorized: targets.targetedMessageUnauthorized,
    targetedEntityMismatch: targets.targetedEntityMismatch,
    signals,
    snapshotReused: false,
  };

  assertSafeProjection(projection);
  return projection;
}

function findingsFromProjection(
  projection: CommunicationsProjection,
  catalogKeys: string[],
): Array<{ key: string; title: string; why: string; entityIds?: string[] }> {
  const findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }> = [];
  const t = projection.totals;

  if (t.failedDeliveries > 0) {
    findings.push({
      key: "communications-failed-delivery",
      title: "Recent communication delivery failed",
      why: `${t.failedDeliveries} recorded communication${t.failedDeliveries === 1 ? " has" : "s have"} status FAILED. That is a recorded delivery result, not a read receipt.`,
      entityIds: projection.messages
        .filter((row) => row.status === "FAILED")
        .map((row) => row.id)
        .slice(0, COMMUNICATIONS_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.revokedConsent > 0) {
    findings.push({
      key: "communications-sms-consent-revoked",
      title: "SMS consent is revoked",
      why: `${t.revokedConsent} projected customer${t.revokedConsent === 1 ? " has" : "s have"} SMS consent REVOKED. A stored phone number is not consent. UNKNOWN is not GRANTED. The Coach does not send a text or change consent.`,
      entityIds: projection.customers
        .filter((row) => row.smsConsentStatus === "REVOKED")
        .map((row) => row.id)
        .slice(0, COMMUNICATIONS_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.unknownConsent > 0) {
    findings.push({
      key: "communications-sms-consent-unknown",
      title: "SMS consent is unknown",
      why: `${t.unknownConsent} projected customer${t.unknownConsent === 1 ? " has" : "s have"} SMS consent UNKNOWN. UNKNOWN is not GRANTED. Having a phone number does not grant consent.`,
      entityIds: projection.customers
        .filter((row) => row.smsConsentStatus === "UNKNOWN")
        .map((row) => row.id)
        .slice(0, COMMUNICATIONS_CONTEXT_CAPS.entityIds),
    });
  }

  if (
    !projection.channels.smsConfigured ||
    !projection.channels.emailConfigured ||
    !projection.channels.smsEntitled
  ) {
    const parts = [
      projection.channels.smsLimitation,
      projection.channels.emailLimitation,
    ].filter(Boolean);
    findings.push({
      key: "communications-channel-unavailable",
      title: "A communication channel is unavailable",
      why: `${parts.join(" ")} SMS limitations do not erase recorded email. Email limitations do not erase recorded SMS. The Coach does not send, retry, or connect a provider.`,
    });
  }

  if (t.differentTimeAppointments > 0) {
    findings.push({
      key: "communications-appointment-different-time",
      title: "Customer requested a different appointment time",
      why: `${t.differentTimeAppointments} recorded appointment${t.differentTimeAppointments === 1 ? " has" : "s have"} DIFFERENT_TIME_REQUESTED. That is a recorded request, not a confirmation and not a cancellation.`,
      entityIds: projection.appointments
        .filter((row) => row.differentTimeRequested)
        .map((row) => row.jobId)
        .slice(0, COMMUNICATIONS_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.pendingDeliveries > 0) {
    findings.push({
      key: "communications-pending-delivery",
      title: "Recorded communications are still pending",
      why: `${t.pendingDeliveries} recorded communication${t.pendingDeliveries === 1 ? " is" : "s are"} DRAFT, READY, QUEUED, or ACCEPTED. That is recorded send state, not proof the customer is waiting to reply.`,
      entityIds: projection.messages
        .filter((row) => PENDING_STATUSES.has(row.status))
        .map((row) => row.id)
        .slice(0, COMMUNICATIONS_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.awaitingAppointments > 0) {
    findings.push({
      key: "communications-awaiting-appointment",
      title: "Appointment confirmation is awaiting the customer",
      why: `${t.awaitingAppointments} recorded appointment${t.awaitingAppointments === 1 ? " is" : "s are"} AWAITING_CUSTOMER. That is recorded confirmation state, not a customer reply.`,
      entityIds: projection.appointments
        .filter((row) => row.awaitingCustomer)
        .map((row) => row.jobId)
        .slice(0, COMMUNICATIONS_CONTEXT_CAPS.entityIds),
    });
  }

  for (const key of catalogKeys) {
    if (findings.some((row) => row.key === key)) continue;
    if (isCommunicationsOwnedRecommendationKey(key)) {
      findings.push({
        key,
        title: "Review recorded communications attention",
        why: "An active Communications recommendation is already on the Business Health list. Open the existing communications workspace to review it.",
      });
    }
  }
  return findings.slice(0, COMMUNICATIONS_CONTEXT_CAPS.findings);
}

export function projectCommunicationsFacts(projection: CommunicationsProjection) {
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];
  const t = projection.totals;
  addFact(facts, factKeys, "communications-failed-delivery-count", String(t.failedDeliveries));
  addFact(facts, factKeys, "communications-pending-count", String(t.pendingDeliveries));
  addFact(facts, factKeys, "communications-revoked-consent-count", String(t.revokedConsent));
  addFact(facts, factKeys, "communications-unknown-consent-count", String(t.unknownConsent));
  addFact(facts, factKeys, "communications-granted-consent-count", String(t.grantedConsent));
  addFact(facts, factKeys, "communications-sms-configured", projection.channels.smsConfigured ? "yes" : "no");
  addFact(facts, factKeys, "communications-email-configured", projection.channels.emailConfigured ? "yes" : "no");
  addFact(facts, factKeys, "communications-sms-entitled", projection.channels.smsEntitled ? "yes" : "no");
  addFact(
    facts,
    factKeys,
    "communications-appointment-different-time-count",
    String(t.differentTimeAppointments),
  );
  addFact(facts, factKeys, "communications-email-message-count", String(t.emailMessages));
  addFact(facts, factKeys, "communications-sms-message-count", String(t.smsMessages));
  return { facts, factKeys };
}

export async function runCommunicationsSpecialist(
  input: CommunicationsSpecialistInput,
): Promise<SpecialistResult> {
  recordCommunicationsSpecialistInterpretation();
  const catalogKeys = input.catalog.activeRecommendations
    .map((item) => item.key)
    .filter((key) => isCommunicationsOwnedRecommendationKey(key));

  const gates = await resolveCommunicationsGates(
    input.db,
    input.access,
    input.denyProductCapabilities,
    input.denyRoleCapabilities,
  );
  if (gates.status === "skip") {
    lastCommunicationsProjection = null;
    return {
      specialistId: "COMMUNICATIONS",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: gates.limitation,
      skipReason: gates.skipReason,
    };
  }

  try {
    const projection = await loadCommunicationsProjection({
      db: input.db,
      access: input.access,
      entityHints: input.entityHints,
      smsEntitled: gates.smsEntitled,
    });
    lastCommunicationsProjection = projection;

    const { factKeys } = projectCommunicationsFacts(projection);
    const rawFindings = findingsFromProjection(projection, catalogKeys);
    const findings: SpecialistFinding[] = rawFindings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: isCommunicationsOwnedRecommendationKey(item.key) ? [item.key] : [],
      factKeys,
      entityIds: item.entityIds,
    }));

    const limitations: string[] = [];
    if (!gates.smsEntitled) {
      limitations.push(
        "SMS compose is not entitled in this workspace. That SMS limitation does not erase recorded email and does not invent SMS consent.",
      );
    }
    if (!projection.channels.smsConfigured) {
      limitations.push("SMS delivery is not connected. Recorded SMS history stays recorded history.");
    }
    if (!projection.channels.emailConfigured) {
      limitations.push("Email delivery is not configured. Recorded email history stays recorded history.");
    }
    if (projection.targetedEntityMismatch) {
      limitations.push(TARGET_CONSISTENCY_LIMITATION);
    } else {
      if (projection.targetedCustomerUnauthorized) {
        limitations.push("That customer is not in this business workspace, so it was not targeted.");
      }
      if (projection.targetedRequestUnauthorized) {
        limitations.push("That request is not in this business workspace, so it was not targeted.");
      }
      if (projection.targetedJobUnauthorized) {
        limitations.push("That job is not in this business workspace, so it was not targeted.");
      }
      if (projection.targetedMessageUnauthorized) {
        limitations.push("That message is not in this business workspace, so it was not targeted.");
      }
    }

    return {
      specialistId: "COMMUNICATIONS",
      status: "OK",
      findings,
      factKeys,
      recommendationKeys: catalogKeys,
      limitation: limitations.join(" ") || undefined,
    };
  } catch (error) {
    lastCommunicationsProjection = null;
    return {
      specialistId: "COMMUNICATIONS",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: COMMUNICATIONS_FAILURE_LIMITATION,
      failure: {
        specialistId: "COMMUNICATIONS",
        message: error instanceof Error ? error.message : "Communications projection could not be loaded.",
      },
    };
  }
}

export function emptyCommunicationsProjectionForTests(): CommunicationsProjection {
  return {
    totals: emptyTotals(),
    customers: [],
    messages: [],
    appointments: [],
    phoneInteractions: [],
    channels: {
      emailConfigured: false,
      smsConfigured: false,
      smsEntitled: false,
      voiceConnected: false,
      voiceLimitation: VOICE_NOT_CONNECTED_REASON,
      smsLimitation: SMS_NOT_CONFIGURED_REASON,
      emailLimitation: EMAIL_NOT_CONFIGURED_REASON,
    },
    canReadDeep: false,
    targetedCustomerUnauthorized: false,
    targetedRequestUnauthorized: false,
    targetedJobUnauthorized: false,
    targetedMessageUnauthorized: false,
    targetedEntityMismatch: false,
    signals: [],
    snapshotReused: false,
  };
}
