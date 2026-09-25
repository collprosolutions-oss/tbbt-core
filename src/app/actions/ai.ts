"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { appendConversationMessage, ensureAiConversation } from "@/lib/ai/conversations";
import { answerCoachFromFacts, coachSystemPrompt } from "@/lib/ai/coach";
import { runAiTask } from "@/lib/ai/service";
import { runWritingAssist } from "@/lib/ai/writing";
import { isAiAttemptId, isWritingAction } from "@/lib/ai/types";
import { answerKnowledgeFromEntries, retrieveTenantKnowledge } from "@/lib/ai/knowledge";
import { draftReviewResponseFromRecord } from "@/lib/ai/reviews";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { loadBsosFacts } from "@/lib/bsos-data";
import { buildBsosHealthMetrics, buildBsosRecommendations } from "@/lib/bsos";
import { AI_NOT_CONNECTED_MESSAGE } from "@/lib/ai/types";

export type AiActionState = {
  error?: string;
  message?: string;
  text?: string;
  stance?: string;
  keptOriginal?: boolean;
  inProgress?: boolean;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readAttemptId(formData: FormData) {
  const value = readString(formData, "attemptId");
  return isAiAttemptId(value) ? value : "";
}

export async function askBsosCoachAction(
  _prev: AiActionState,
  formData: FormData,
): Promise<AiActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
    const question = readString(formData, "question");
    const attemptId = readAttemptId(formData);
    if (!question) return { error: "Ask a question about recorded TBBT facts." };
    if (!attemptId) return { error: "Retry that request from the form." };

    const { listActiveTradeCodes } = await import("@/lib/business-trades");
    const { workspaceTradeLabel } = await import("@/lib/trade-config");
    const facts = await loadBsosFacts(prisma, access.businessId);
    const activeTradeCodes = await listActiveTradeCodes(prisma, access.businessId);
    const recommendations = buildBsosRecommendations(facts);
    const metrics = buildBsosHealthMetrics(facts);
    const [goals, actionItems] = await Promise.all([
      prisma.businessGoal.findMany({ where: { businessId: access.businessId }, take: 20 }),
      prisma.businessActionItem.findMany({ where: { businessId: access.businessId }, take: 20 }),
    ]);
    const grounded = answerCoachFromFacts(question, {
      facts,
      recommendations,
      metrics,
      goals,
      actionItems,
      activeTradeLabels: [workspaceTradeLabel(activeTradeCodes)],
    });
    const conversation = await ensureAiConversation(prisma, access, {
      area: "COACH",
      title: "BSOS Coach",
      conversationId: readString(formData, "conversationId") || undefined,
    });
    const result = await runAiTask(
      prisma,
      {
        businessId: access.businessId,
        membershipId: access.workspace.membership.id,
        userId: access.workspace.user.id,
      },
      {
        taskType: "COACH_ASK",
        system: coachSystemPrompt(),
        user: JSON.stringify({
          question: sanitizeAiText(question, 1_000),
          facts: grounded.citedFacts,
          recommendations: recommendations.map((item) => ({
            key: item.key,
            title: item.title,
            why: item.why,
          })),
        }),
        inputSummary: question,
        conversationId: conversation.id,
        idempotencyKey: `coach:${access.businessId}:${conversation.id}:${attemptId}`,
        fallback: grounded.output,
        allowedFactKeys: grounded.citedFacts.map((fact) => fact.key),
      },
    );
    if (result.status === "PENDING") {
      return { message: result.message, inProgress: true };
    }
    const output = result.output ?? grounded.output;
    if (result.interactionId) {
      const existingAssistant = await prisma.aiConversationMessage.findFirst({
        where: {
          businessId: access.businessId,
          conversationId: conversation.id,
          interactionId: result.interactionId,
          role: "ASSISTANT",
        },
      });
      if (existingAssistant) {
        revalidatePath("/business-health");
        return {
          message: result.connected ? result.message : AI_NOT_CONNECTED_MESSAGE,
          text: existingAssistant.content,
          stance: existingAssistant.stance ?? output.stance,
        };
      }
    }
    await appendConversationMessage(prisma, access, {
      conversationId: conversation.id,
      role: "USER",
      content: question,
      stance: "FACT",
    });
    await appendConversationMessage(prisma, access, {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: output.text,
      stance: output.stance,
      citedFacts: grounded.citedFacts,
      interactionId: result.interactionId,
    });
    revalidatePath("/business-health");
    return {
      message: result.connected ? result.message : AI_NOT_CONNECTED_MESSAGE,
      text: output.text,
      stance: output.stance,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The coach could not answer that." };
  }
}

export async function askKnowledgeAction(
  _prev: AiActionState,
  formData: FormData,
): Promise<AiActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
    const question = readString(formData, "question");
    const attemptId = readAttemptId(formData);
    if (!question) return { error: "Ask a question about this business's Knowledge Hub." };
    if (!attemptId) return { error: "Retry that request from the form." };
    const hits = await retrieveTenantKnowledge(prisma, access.businessId, question);
    const fallback = answerKnowledgeFromEntries(question, hits);
    const conversation = await ensureAiConversation(prisma, access, {
      area: "KNOWLEDGE",
      title: "Knowledge ask",
    });
    const result = await runAiTask(
      prisma,
      {
        businessId: access.businessId,
        membershipId: access.workspace.membership.id,
        userId: access.workspace.user.id,
      },
      {
        taskType: "KNOWLEDGE_ASK",
        system:
          "Answer only from the supplied tenant Knowledge entries. Never use another business. Return JSON {text, stance, citedFactKeys, notes}.",
        user: JSON.stringify({ question: sanitizeAiText(question, 800), entries: hits }),
        inputSummary: question,
        conversationId: conversation.id,
        idempotencyKey: `knowledge:${access.businessId}:${attemptId}`,
        fallback,
        allowedFactKeys: hits.map((hit) => hit.id),
      },
    );
    if (result.status === "PENDING") {
      return { message: result.message, inProgress: true };
    }
    const output = result.output ?? fallback;
    if (result.interactionId) {
      const existingAssistant = await prisma.aiConversationMessage.findFirst({
        where: {
          businessId: access.businessId,
          conversationId: conversation.id,
          interactionId: result.interactionId,
          role: "ASSISTANT",
        },
      });
      if (existingAssistant) {
        revalidatePath("/knowledge");
        return { message: result.message, text: existingAssistant.content, stance: existingAssistant.stance ?? output.stance };
      }
    }
    await appendConversationMessage(prisma, access, {
      conversationId: conversation.id,
      role: "USER",
      content: question,
    });
    await appendConversationMessage(prisma, access, {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: output.text,
      stance: output.stance,
      citedFacts: hits.map((hit) => ({
        key: hit.id,
        label: hit.title,
        value: hit.trustState,
        href: `/knowledge?selected=${hit.id}`,
      })),
      interactionId: result.interactionId,
    });
    revalidatePath("/knowledge");
    return { message: result.message, text: output.text, stance: output.stance };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That knowledge question could not be answered." };
  }
}

export async function applyWritingAction(
  _prev: AiActionState,
  formData: FormData,
): Promise<AiActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.USE_AI_ASSIST);
    const action = readString(formData, "writingAction");
    if (!isWritingAction(action)) return { error: "Choose a writing action." };
    const writingAction = action;
    if (writingAction === "KEEP_MINE") {
      return { keptOriginal: true, text: readString(formData, "original"), message: "Owner text kept." };
    }
    const original = readString(formData, "original");
    const attemptId = readAttemptId(formData);
    if (!attemptId) return { error: "Retry that request from the form." };
    const result = await runWritingAssist(
      prisma,
      {
        businessId: access.businessId,
        membershipId: access.workspace.membership.id,
        userId: access.workspace.user.id,
      },
      {
        action: writingAction,
        original,
        context: readString(formData, "context") || null,
        idempotencyKey: `writing:${access.businessId}:${action}:${attemptId}`,
      },
    );
    if (result.status === "PENDING") {
      return { message: result.message, inProgress: true };
    }
    return {
      message: result.message,
      text: result.output?.text ?? original,
      stance: result.output?.stance,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That rewrite could not be prepared." };
  }
}

export async function draftReviewResponseAssistAction(
  _prev: AiActionState,
  formData: FormData,
): Promise<AiActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
    const reviewId = readString(formData, "reviewId");
    const attemptId = readAttemptId(formData);
    if (!attemptId) return { error: "Retry that request from the form." };
    const review = access.assertOwned(
      await prisma.review.findFirst({
        where: { id: reviewId, ...access.scope },
        include: { customer: { select: { name: true } } },
      }),
    );
    const fallback = draftReviewResponseFromRecord({
      reviewerName: review.customer.name,
      body: review.reviewText,
    });
    const result = await runAiTask(
      prisma,
      {
        businessId: access.businessId,
        membershipId: access.workspace.membership.id,
        userId: access.workspace.user.id,
      },
      {
        taskType: "REVIEW_RESPONSE",
        system:
          "Draft an owner response to a recorded review. Never invent testimonials. Return JSON {text, stance, citedFactKeys, notes}. The owner must approve any reply.",
        user: JSON.stringify({
          reviewerName: sanitizeAiText(review.customer.name ?? "", 80),
          body: sanitizeAiText(review.reviewText, 1_200),
        }),
        inputSummary: `review-response ${review.id}`,
        idempotencyKey: `review-response:${access.businessId}:${review.id}:${attemptId}`,
        fallback,
      },
    );
    if (result.status === "PENDING") {
      return { message: result.message, inProgress: true };
    }
    return {
      message: result.message,
      text: result.output?.text ?? fallback.text,
      stance: result.output?.stance,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "A response draft could not be prepared." };
  }
}
