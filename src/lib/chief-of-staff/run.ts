/**
 * Chief of Staff runner. Read/explain only.
 *
 * Deterministic facts → planner → specialist results → conflicts →
 * grounded fallback → exactly one runAiTask(COS_ASK).
 *
 * Orchestration status is not AI-provider status.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { appendConversationMessage, ensureAiConversation } from "@/lib/ai/conversations";
import { coachSystemPrompt } from "@/lib/ai/coach";
import { sanitizeAiText, summarizeAiInput } from "@/lib/ai/sanitize";
import { AI_PENDING_STALE_MS, runAiTask } from "@/lib/ai/service";
import {
  AI_IN_PROGRESS_MESSAGE,
  AI_NOT_CONNECTED_MESSAGE,
  isAiAttemptId,
  type AiRunResult,
  type StructuredAiOutput,
} from "@/lib/ai/types";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { buildBsosHealthMetrics } from "@/lib/bsos";
import { loadSpecialistContext, resetDeepLoaderInvocations } from "@/lib/chief-of-staff/context";
import { resolveConflicts } from "@/lib/chief-of-staff/conflicts";
import { planSpecialists } from "@/lib/chief-of-staff/planner";
import {
  loadCanonicalRecommendationCatalog,
  type CanonicalRecommendationCatalog,
} from "@/lib/chief-of-staff/recommendations";
import { synthesizeCoachAnswer } from "@/lib/chief-of-staff/synthesize";
import type {
  OrchestrationSkipFailure,
  OrchestrationStatus,
  SpecialistId,
  SpecialistResult,
} from "@/lib/chief-of-staff/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type ChiefOfStaffTestHooks = {
  failSpecialistId?: SpecialistId;
};

export type ChiefOfStaffRunResult = {
  inProgress?: boolean;
  error?: string;
  message?: string;
  text?: string;
  stance?: string;
  interactionId?: string;
  orchestrationId?: string;
  orchestrationStatus?: OrchestrationStatus;
  aiStatus?: AiRunResult["status"];
  citedFactKeys?: string[];
};

let synthesisCallCount = 0;

export function resetSynthesisCallCount() {
  synthesisCallCount = 0;
}

export function getSynthesisCallCount() {
  return synthesisCallCount;
}

function projectSpecialist(context: ReturnType<typeof loadSpecialistContext>): SpecialistResult {
  return {
    specialistId: context.specialistId,
    status: "OK",
    findings: context.findings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: [item.key],
      factKeys: context.factKeys,
    })),
    factKeys: context.factKeys,
    recommendationKeys: context.recommendationKeys,
  };
}

async function loadCoachExtras(db: Db, businessId: string) {
  const [goals, actionItems] = await Promise.all([
    db.businessGoal.findMany({ where: { businessId }, take: 20 }),
    db.businessActionItem.findMany({ where: { businessId }, take: 20 }),
  ]);
  return { goals, actionItems };
}

function isStaleClaim(claimedAt: Date | null | undefined, now = new Date()) {
  if (!claimedAt) return true;
  return claimedAt.getTime() < now.getTime() - AI_PENDING_STALE_MS;
}

async function replayCompleted(input: {
  db: Db;
  access: BusinessAccess;
  conversationId: string;
  interactionId: string;
  orchestrationId: string;
  orchestrationStatus: OrchestrationStatus;
  idempotencyKey: string;
  fallback: StructuredAiOutput;
  allowedFactKeys: string[];
  citedFacts: unknown;
}): Promise<ChiefOfStaffRunResult> {
  synthesisCallCount += 1;
  const aiResult = await runAiTask(
    input.db as PrismaClient,
    {
      businessId: input.access.businessId,
      membershipId: input.access.workspace.membership.id,
      userId: input.access.workspace.user.id,
    },
    {
      taskType: "COS_ASK",
      system: coachSystemPrompt(),
      user: "replay",
      inputSummary: "replay",
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      fallback: input.fallback,
      allowedFactKeys: input.allowedFactKeys,
    },
  );
  if (aiResult.status === "PENDING") {
    return {
      inProgress: true,
      message: AI_IN_PROGRESS_MESSAGE,
      interactionId: input.interactionId,
      orchestrationId: input.orchestrationId,
      orchestrationStatus: "PENDING",
      aiStatus: "PENDING",
    };
  }
  const output = aiResult.output ?? input.fallback;
  const existingAssistant = await input.db.aiConversationMessage.findFirst({
    where: {
      businessId: input.access.businessId,
      conversationId: input.conversationId,
      interactionId: input.interactionId,
      role: "ASSISTANT",
    },
  });
  return {
    message: aiResult.connected ? aiResult.message : AI_NOT_CONNECTED_MESSAGE,
    text: existingAssistant?.content ?? output.text,
    stance: existingAssistant?.stance ?? output.stance,
    interactionId: input.interactionId,
    orchestrationId: input.orchestrationId,
    orchestrationStatus: input.orchestrationStatus,
    aiStatus: aiResult.status,
    citedFactKeys: output.citedFactKeys,
  };
}

export async function runChiefOfStaffCoach(
  db: Db,
  access: BusinessAccess,
  input: {
    question: string;
    attemptId: string;
    conversationId?: string;
    /** Ignored. Browser businessId is never authorization. */
    browserBusinessId?: string;
    test?: ChiefOfStaffTestHooks;
  },
): Promise<ChiefOfStaffRunResult> {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  void input.browserBusinessId;
  const question = sanitizeAiText(input.question, 1_000).replace(
    /\b(password|api[_-]?key|secret|token|authorization)\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  );
  if (!question) return { error: "Ask a question about recorded TBBT facts." };
  if (!isAiAttemptId(input.attemptId)) return { error: "Retry that request from the form." };

  const conversation = await ensureAiConversation(db as PrismaClient, access, {
    area: "COACH",
    title: "BSOS Coach",
    conversationId: input.conversationId,
  });
  const idempotencyKey = `coach:${access.businessId}:${conversation.id}:${input.attemptId}`;

  const existing = await db.aiOrchestrationRun.findUnique({
    where: {
      businessId_idempotencyKey: {
        businessId: access.businessId,
        idempotencyKey,
      },
    },
  });
  if (existing && existing.status !== "PENDING") {
    const fallback: StructuredAiOutput = {
      text: "Recorded TBBT facts were reused for this request.",
      stance: "MIXED",
      citedFactKeys: [],
    };
    return replayCompleted({
      db,
      access,
      conversationId: conversation.id,
      interactionId: existing.interactionId,
      orchestrationId: existing.id,
      orchestrationStatus: existing.status as OrchestrationStatus,
      idempotencyKey,
      fallback,
      allowedFactKeys: [],
      citedFacts: [],
    });
  }

  if (existing?.status === "PENDING") {
    const interaction = await db.aiInteraction.findUnique({ where: { id: existing.interactionId } });
    if (interaction && !isStaleClaim(interaction.claimedAt)) {
      return {
        inProgress: true,
        message: AI_IN_PROGRESS_MESSAGE,
        interactionId: existing.interactionId,
        orchestrationId: existing.id,
        orchestrationStatus: "PENDING",
        aiStatus: "PENDING",
      };
    }
  }

  let interactionId = existing?.interactionId;
  let orchestrationId = existing?.id;
  if (!existing) {
    try {
      const created = await (db as PrismaClient).$transaction(async (tx) => {
        const interaction = await tx.aiInteraction.create({
          data: {
            businessId: access.businessId,
            membershipId: access.workspace.membership.id,
            userId: access.workspace.user.id,
            conversationId: conversation.id,
            taskType: "COS_ASK",
            status: "PENDING",
            inputSummary: summarizeAiInput("COS_ASK", question),
            idempotencyKey,
            claimedAt: new Date(),
          },
        });
        const orchestration = await tx.aiOrchestrationRun.create({
          data: {
            businessId: access.businessId,
            membershipId: access.workspace.membership.id,
            interactionId: interaction.id,
            conversationId: conversation.id,
            status: "PENDING",
            questionSummary: summarizeAiInput("COS_ASK", question),
            specialistIds: [],
            factKeys: [],
            recommendationKeys: [],
            idempotencyKey,
          },
        });
        return { interaction, orchestration };
      });
      interactionId = created.interaction.id;
      orchestrationId = created.orchestration.id;
    } catch {
      const raced = await db.aiOrchestrationRun.findUnique({
        where: {
          businessId_idempotencyKey: {
            businessId: access.businessId,
            idempotencyKey,
          },
        },
      });
      if (raced?.status === "PENDING") {
        return {
          inProgress: true,
          message: AI_IN_PROGRESS_MESSAGE,
          interactionId: raced.interactionId,
          orchestrationId: raced.id,
          orchestrationStatus: "PENDING",
          aiStatus: "PENDING",
        };
      }
      if (raced) {
        return replayCompleted({
          db,
          access,
          conversationId: conversation.id,
          interactionId: raced.interactionId,
          orchestrationId: raced.id,
          orchestrationStatus: raced.status as OrchestrationStatus,
          idempotencyKey,
          fallback: { text: "Recorded TBBT facts were reused for this request.", stance: "MIXED", citedFactKeys: [] },
          allowedFactKeys: [],
          citedFacts: [],
        });
      }
      return { error: "That coach request could not be recorded." };
    }
  }

  if (!interactionId || !orchestrationId) {
    return { error: "That coach request could not be recorded." };
  }

  resetDeepLoaderInvocations();
  let catalog: CanonicalRecommendationCatalog;
  try {
    catalog = await loadCanonicalRecommendationCatalog(db, access.businessId);
  } catch (error) {
    await db.aiOrchestrationRun.update({
      where: { id: orchestrationId },
      data: {
        status: "FAILED",
        skippedFailure: {
          skipped: [],
          failures: [{ specialistId: "ATTENTION", message: error instanceof Error ? error.message : "Catalog load failed" }],
        } satisfies OrchestrationSkipFailure,
      },
    });
    return { error: error instanceof Error ? error.message : "Business Health facts could not be loaded." };
  }

  const plan = planSpecialists({
    question,
    activeRecommendationKeys: catalog.activeRecommendations.map((item) => item.key),
  });

  const specialistResults: SpecialistResult[] = [];
  for (const specialistId of plan.selectedIds) {
    try {
      if (input.test?.failSpecialistId === specialistId) {
        throw new Error("injected specialist failure");
      }
      const context = loadSpecialistContext(specialistId, catalog, question);
      specialistResults.push(projectSpecialist(context));
    } catch (error) {
      specialistResults.push({
        specialistId,
        status: "FAILED",
        findings: [],
        factKeys: [],
        recommendationKeys: [],
        limitation:
          "Part of the recorded attention view could not be loaded. No substitute facts were invented.",
        failure: {
          specialistId,
          message: error instanceof Error ? error.message : "Specialist failed",
        },
      });
    }
  }

  const conflicts = resolveConflicts({
    results: specialistResults,
    recommendations: catalog.activeRecommendations,
    facts: catalog.facts,
  });
  const extras = await loadCoachExtras(db, access.businessId);
  const { listActiveTradeCodes } = await import("@/lib/business-trades");
  const { workspaceTradeLabel } = await import("@/lib/trade-config");
  const activeTradeCodes = await listActiveTradeCodes(db as PrismaClient, access.businessId);
  const synthesis = synthesizeCoachAnswer({
    question,
    catalog,
    specialistResults,
    conflicts,
    coachContext: {
      facts: catalog.facts,
      recommendations: catalog.activeRecommendations,
      metrics: buildBsosHealthMetrics(catalog.facts),
      goals: extras.goals,
      actionItems: extras.actionItems,
      activeTradeLabels: [workspaceTradeLabel(activeTradeCodes)],
    },
  });

  const failed = specialistResults.filter((row) => row.status === "FAILED");
  const ok = specialistResults.filter((row) => row.status === "OK");
  const orchestrationStatus: OrchestrationStatus =
    failed.length > 0 && ok.length > 0 ? "PARTIAL" : failed.length > 0 ? "FAILED" : "COMPLETED";

  await db.aiInteraction.update({
    where: { id: interactionId },
    data: { claimedAt: null },
  });

  synthesisCallCount += 1;
  const aiResult = await runAiTask(
    db as PrismaClient,
    {
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
      userId: access.workspace.user.id,
    },
    {
      taskType: "COS_ASK",
      system: coachSystemPrompt(),
      user: JSON.stringify(synthesis.payload),
      inputSummary: question,
      conversationId: conversation.id,
      idempotencyKey,
      fallback: synthesis.output,
      allowedFactKeys: synthesis.citedFacts.map((fact) => fact.key),
    },
  );

  if (aiResult.status === "PENDING") {
    return {
      inProgress: true,
      message: AI_IN_PROGRESS_MESSAGE,
      interactionId,
      orchestrationId,
      orchestrationStatus: "PENDING",
      aiStatus: "PENDING",
    };
  }

  await db.aiOrchestrationRun.update({
    where: { id: orchestrationId },
    data: {
      status: orchestrationStatus,
      specialistIds: plan.selectedIds,
      factKeys: synthesis.citedFacts.map((fact) => fact.key),
      recommendationKeys: synthesis.recommendationKeys,
      conflictMetadata: conflicts,
      skippedFailure: {
        skipped: plan.skipped,
        failures: failed
          .map((row) => row.failure)
          .filter((row): row is NonNullable<typeof row> => Boolean(row)),
      } satisfies OrchestrationSkipFailure,
    },
  });

  const output = aiResult.output ?? synthesis.output;
  const existingAssistant = await db.aiConversationMessage.findFirst({
    where: {
      businessId: access.businessId,
      conversationId: conversation.id,
      interactionId,
      role: "ASSISTANT",
    },
  });
  if (existingAssistant) {
    return {
      message: aiResult.connected ? aiResult.message : AI_NOT_CONNECTED_MESSAGE,
      text: existingAssistant.content,
      stance: existingAssistant.stance ?? output.stance,
      interactionId,
      orchestrationId,
      orchestrationStatus,
      aiStatus: aiResult.status,
      citedFactKeys: output.citedFactKeys,
    };
  }

  await appendConversationMessage(db as PrismaClient, access, {
    conversationId: conversation.id,
    role: "USER",
    content: question,
    stance: "FACT",
  });
  await appendConversationMessage(db as PrismaClient, access, {
    conversationId: conversation.id,
    role: "ASSISTANT",
    content: output.text,
    stance: output.stance,
    citedFacts: synthesis.citedFacts,
    interactionId,
  });

  return {
    message: aiResult.connected ? aiResult.message : AI_NOT_CONNECTED_MESSAGE,
    text: output.text,
    stance: output.stance,
    interactionId,
    orchestrationId,
    orchestrationStatus,
    aiStatus: aiResult.status,
    citedFactKeys: output.citedFactKeys,
  };
}
