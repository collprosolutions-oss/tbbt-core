/**
 * Bounded customer-to-OWNER project conversation for one active
 * Handyman job. Distinct from the completed-job callback request.
 * Messages are CustomerCommunication rows (relatedType=JOB) and appear
 * in the existing customer communication timeline. OWNER replies go
 * through composeCustomerCommunication. Opening a page never sends.
 */
import { resolveJobTradeCode } from "@/lib/cleaning-visit-workflow";
import { parseProjectLinkToken } from "@/lib/project-link";
import type { TradeCode } from "@/lib/trades";

export const PROJECT_CONVERSATION_PURPOSE = "JOB_UPDATE" as const;
export const PROJECT_CONVERSATION_SUBJECT = "Project conversation";
export const PROJECT_CONVERSATION_RELATED_TYPE = "JOB" as const;
export const PROJECT_CONVERSATION_CUSTOMER_CHANNEL = "PORTAL" as const;
export const PROJECT_CONVERSATION_CUSTOMER_PROVIDER = "portal" as const;

export const PROJECT_CONVERSATION_ACTIVE_JOB_STATUSES = [
  "UNSCHEDULED",
  "SCHEDULED",
  "IN_PROGRESS",
] as const;
export type ProjectConversationActiveJobStatus =
  (typeof PROJECT_CONVERSATION_ACTIVE_JOB_STATUSES)[number];

export const PROJECT_CONVERSATION_OWNER_CHANNELS = ["EMAIL", "SMS"] as const;
export type ProjectConversationOwnerChannel =
  (typeof PROJECT_CONVERSATION_OWNER_CHANNELS)[number];

export const MAX_PROJECT_CONVERSATION_BODY_LENGTH = 500;
export const MAX_PROJECT_CONVERSATION_MESSAGES = 20;
export const MAX_PORTAL_PROJECT_TOKEN_LENGTH = 128;

export const PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE =
  "This project link is not available.";

export const PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE =
  "A project conversation is only available on an active Handyman job.";

export const PROJECT_CONVERSATION_BODY_REQUIRED_MESSAGE =
  "Write a short message about this project.";

export const PROJECT_CONVERSATION_ATTEMPT_REQUIRED_MESSAGE =
  "Retry that send from the form.";

export const PROJECT_CONVERSATION_BOUND_MESSAGE =
  "This project conversation has reached its message limit.";

export const PROJECT_CONVERSATION_PORTAL_RECEIVED_MESSAGE =
  "Your message was recorded on this project. Opening this page does not send a message.";

export const PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE =
  "Message the owner about this active job. This is not a callback request, does not schedule a visit, and opening this page does not send a message.";

export const PROJECT_CONVERSATION_OWNER_WORKFLOW_MESSAGE =
  "Read this job's customer conversation and send a reply. Send uses the Communications consent and delivery path. Opening this page does not send a message.";

export const PROJECT_CONVERSATION_OWNER_SENT_MESSAGE =
  "Reply recorded through Communications. Opening this page did not send a message.";

export const PROJECT_CONVERSATION_OWNER_REUSED_MESSAGE =
  "That reply was already recorded. Opening this page did not send a message.";

export const PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE =
  "That job could not be found.";

export const PROJECT_CONVERSATION_CHANNEL_REQUIRED_MESSAGE =
  "Choose email or SMS for this reply.";

export const PROJECT_CONVERSATION_CUSTOMER_REQUIRED_MESSAGE =
  "This job has no customer to message.";

export const PROJECT_CONVERSATION_JOB_TRADE_SELECT = {
  estimate: {
    select: {
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { serviceCatalogItem: { select: { tradeCode: true } } },
      },
    },
  },
} as const;

export function parseProjectConversationToken(
  raw: string | null | undefined,
): string | null {
  return parseProjectLinkToken(raw);
}

export function parseProjectConversationBody(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_PROJECT_CONVERSATION_BODY_LENGTH);
}

export function isProjectConversationActiveJobStatus(
  status: string | null | undefined,
): status is ProjectConversationActiveJobStatus {
  return (
    PROJECT_CONVERSATION_ACTIVE_JOB_STATUSES as readonly string[]
  ).includes(status ?? "");
}

export function isProjectConversationOwnerChannel(
  value: string | null | undefined,
): value is ProjectConversationOwnerChannel {
  return (PROJECT_CONVERSATION_OWNER_CHANNELS as readonly string[]).includes(
    value ?? "",
  );
}

export function tradeCodeForProjectConversationJob(job: {
  estimate?: {
    serviceRequest?: { tradeCode?: string | null } | null;
    lineItems?: Array<{
      serviceCatalogItem?: { tradeCode?: string | null } | null;
    }>;
  } | null;
}): TradeCode {
  return resolveJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
}

export function projectConversationHandymanEligible(job: {
  status: string;
  estimate?: {
    serviceRequest?: { tradeCode?: string | null } | null;
    lineItems?: Array<{
      serviceCatalogItem?: { tradeCode?: string | null } | null;
    }>;
  } | null;
}): boolean {
  return (
    isProjectConversationActiveJobStatus(job.status) &&
    tradeCodeForProjectConversationJob(job) === "HANDYMAN"
  );
}

export function portalProjectConversationIdempotencyKey(
  jobId: string,
  attemptId: string,
) {
  return `portal-job-convo:${jobId}:${attemptId}`;
}

export function escapeProjectConversationHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function compareProjectConversationMessages(
  left: { occurredAt: string | Date; id: string },
  right: { occurredAt: string | Date; id: string },
) {
  const leftAt =
    left.occurredAt instanceof Date
      ? left.occurredAt.toISOString()
      : left.occurredAt;
  const rightAt =
    right.occurredAt instanceof Date
      ? right.occurredAt.toISOString()
      : right.occurredAt;
  if (leftAt !== rightAt) return leftAt.localeCompare(rightAt);
  return left.id.localeCompare(right.id);
}
