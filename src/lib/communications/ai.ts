import type { Prisma, PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { runAiTask, type AiServiceActor } from "@/lib/ai/service";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { AI_NOT_CONNECTED_MESSAGE, type StructuredAiOutput } from "@/lib/ai/types";
import {
  requireCommunicationsAiCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import { loadCustomerCommunicationTimeline } from "@/lib/communications/timeline";

type Db = PrismaClient | Prisma.TransactionClient;

export const COMMUNICATION_AI_ACTIONS = [
  "draft",
  "rewrite",
  "summarize",
  "follow_up",
] as const;
export type CommunicationAiAction = (typeof COMMUNICATION_AI_ACTIONS)[number];

export function isCommunicationAiAction(value: string): value is CommunicationAiAction {
  return (COMMUNICATION_AI_ACTIONS as readonly string[]).includes(value);
}

const FORBIDDEN_AI_PROMISES =
  "Do not promise scheduling, payment terms, discounts, or consent changes. Suggestion only.";

function templateDraft(topic: string): StructuredAiOutput {
  return {
    text: `Draft from recorded TBBT context: ${topic}. Edit before sending. ${FORBIDDEN_AI_PROMISES}`,
    stance: "RECOMMENDATION",
    citedFactKeys: [],
    notes: AI_NOT_CONNECTED_MESSAGE,
  };
}

function templateRewrite(original: string): StructuredAiOutput {
  const cleaned = original.replace(/\s+/g, " ").trim();
  return {
    text: cleaned
      ? `${cleaned}${cleaned.endsWith(".") ? "" : "."} Review this wording before you send it.`
      : "Add the owner message first. AI cannot send or invent consent.",
    stance: "RECOMMENDATION",
    citedFactKeys: [],
    notes: AI_NOT_CONNECTED_MESSAGE,
  };
}

function templateSummary(count: number): StructuredAiOutput {
  return {
    text:
      count === 0
        ? "No recorded customer communications are available to summarize."
        : `Recorded conversation has ${count} item(s). Review the timeline before you act. ${FORBIDDEN_AI_PROMISES}`,
    stance: "FACT",
    citedFactKeys: ["timeline"],
    notes: AI_NOT_CONNECTED_MESSAGE,
  };
}

function templateFollowUp(customerName: string): StructuredAiOutput {
  return {
    text: `Suggested owner follow-up for ${customerName}: review the last message and decide whether a callback, estimate follow-up, or invoice reminder is appropriate. AI did not create a task or send a message.`,
    stance: "RECOMMENDATION",
    citedFactKeys: [],
    notes: AI_NOT_CONNECTED_MESSAGE,
  };
}

export async function runCommunicationAssist(
  db: Db,
  access: CommunicationAccess & { workspace: CommunicationAccess["workspace"] & { user?: { id?: string | null } } },
  input: {
    action: CommunicationAiAction;
    customerId: string;
    original?: string | null;
    context?: string | null;
    idempotencyKey: string;
  },
) {
  requireCommunicationsAiCapability(access);

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: access.businessId },
    select: { id: true, name: true },
  });
  if (!customer) throw new ForbiddenError();

  const timeline = await loadCustomerCommunicationTimeline(db, access, {
    customerId: customer.id,
  });
  const safeTimeline = timeline.slice(0, 12).map((item) => ({
    purpose: item.purpose,
    channel: item.channel,
    status: item.status,
    direction: item.direction,
    body: sanitizeAiText(item.body, 180),
  }));

  const actor: AiServiceActor = {
    businessId: access.businessId,
    membershipId: access.workspace.membership?.id ?? null,
    userId: access.workspace.user?.id ?? null,
  };

  if (input.action === "summarize") {
    return runAiTask(db, actor, {
      taskType: "COMM_SUMMARIZE",
      system:
        "Summarize only this customer's recorded communications. Never mention another customer. Never change consent, send mail, authorize discounts, or promise scheduling/payment terms.",
      user: JSON.stringify({ customer: customer.name, timeline: safeTimeline }),
      inputSummary: `summarize customer ${customer.id} (${safeTimeline.length} items)`,
      idempotencyKey: input.idempotencyKey,
      fallback: templateSummary(safeTimeline.length),
      allowedFactKeys: ["timeline"],
    });
  }

  if (input.action === "follow_up") {
    return runAiTask(db, actor, {
      taskType: "COMM_FOLLOW_UP",
      system:
        "Suggest one owner follow-up. Suggestion only. Do not create records, send messages, change consent, authorize discounts, or promise scheduling/payment terms.",
      user: JSON.stringify({
        customer: customer.name,
        latest: safeTimeline[0] ?? null,
        context: sanitizeAiText(input.context ?? "", 400),
      }),
      inputSummary: `follow-up suggestion for customer ${customer.id}`,
      idempotencyKey: input.idempotencyKey,
      fallback: templateFollowUp(customer.name),
      allowedFactKeys: ["timeline"],
    });
  }

  if (input.action === "rewrite") {
    const original = sanitizeAiText(input.original ?? "", 2_000);
    return runAiTask(db, actor, {
      taskType: "COMM_REWRITE",
      system:
        "Rewrite tone only. Do not change facts, promise scheduling/payment terms, authorize discounts, or change consent. Suggestion only.",
      user: original || "No owner text.",
      inputSummary: `rewrite customer message ${customer.id}`,
      idempotencyKey: input.idempotencyKey,
      fallback: templateRewrite(original),
    });
  }

  const topic = sanitizeAiText(input.context || input.original || "customer message", 400);
  return runAiTask(db, actor, {
    taskType: "COMM_DRAFT",
    system:
      "Draft a customer message from recorded context only. Do not promise scheduling, payment terms, or discounts. Do not change consent. Suggestion only. The owner must send.",
    user: JSON.stringify({ customer: customer.name, topic, latest: safeTimeline[0] ?? null }),
    inputSummary: `draft customer message ${customer.id}`,
    idempotencyKey: input.idempotencyKey,
    fallback: templateDraft(topic),
    allowedFactKeys: ["timeline"],
  });
}
