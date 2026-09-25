/**
 * Chief of Staff runner. Read/explain only.
 *
 * Deterministic facts → planner → specialist results → conflicts →
 * grounded fallback → exactly one runAiTask(COS_ASK).
 *
 * Orchestration status is not AI-provider status.
 *
 * One logical attempt has at most one active recovery worker. The
 * AiInteraction claim lease is acquired before any catalog/fan-out work
 * and is held through the single synthesis call.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { appendConversationMessage, ensureAiConversation } from "@/lib/ai/conversations";
import { coachSystemPrompt } from "@/lib/ai/coach";
import { sanitizeAiText, summarizeAiInput } from "@/lib/ai/sanitize";
import { claimAiInteraction, parseStructuredAiOutput, runAiTask } from "@/lib/ai/service";
import {
  AI_FAILURE_MESSAGE,
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
  /** Test-only: fail after the audit pair exists, before fan-out. */
  failCatalog?: boolean;
  /** Test-only: fail after catalog/plan, before runAiTask owns synthesis. */
  failBeforeProvider?: boolean;
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

const PRE_PROVIDER_FAILURE_TEXT =
  "Recorded Business Health facts could not be loaded for this request. No substitute facts were invented.";

function preProviderFallback(): StructuredAiOutput {
  return {
    text: PRE_PROVIDER_FAILURE_TEXT,
    stance: "MIXED",
    citedFactKeys: [],
  };
}

let synthesisCallCount = 0;
let orchestrationWorkerCount = 0;

export function resetSynthesisCallCount() {
  synthesisCallCount = 0;
}

export function getSynthesisCallCount() {
  return synthesisCallCount;
}

export function resetOrchestrationWorkerCount() {
  orchestrationWorkerCount = 0;
}

export function getOrchestrationWorkerCount() {
  return orchestrationWorkerCount;
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

function sanitizeFailureReason(reason: string) {
  return sanitizeAiText(reason, 400).replace(
    /\b(password|api[_-]?key|secret|token|authorization)\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  );
}

function inProgressResult(interactionId: string, orchestrationId: string): ChiefOfStaffRunResult {
  return {
    inProgress: true,
    message: AI_IN_PROGRESS_MESSAGE,
    interactionId,
    orchestrationId,
    orchestrationStatus: "PENDING",
    aiStatus: "PENDING",
  };
}

async function replayTerminal(input: {
  db: Db;
  conversationId: string;
  businessId: string;
  interactionId: string;
  orchestrationId: string;
  orchestrationStatus: OrchestrationStatus;
  fallback?: StructuredAiOutput;
}): Promise<ChiefOfStaffRunResult> {
  const interaction = await input.db.aiInteraction.findUnique({
    where: { id: input.interactionId },
  });
  const fallback = input.fallback ?? preProviderFallback();
  const stored = interaction?.outputSummary
    ? parseStructuredAiOutput(interaction.outputSummary)
    : null;
  const output = stored ?? fallback;
  const existingAssistant = await input.db.aiConversationMessage.findFirst({
    where: {
      businessId: input.businessId,
      conversationId: input.conversationId,
      interactionId: input.interactionId,
      role: "ASSISTANT",
    },
  });
  const aiStatus = (interaction?.status ?? "FAILED") as AiRunResult["status"];
  return {
    error: aiStatus === "FAILED" && !existingAssistant ? output.text : undefined,
    message:
      aiStatus === "SKIPPED_NOT_CONNECTED"
        ? AI_NOT_CONNECTED_MESSAGE
        : aiStatus === "FAILED"
          ? AI_FAILURE_MESSAGE
          : aiStatus === "PENDING"
            ? AI_IN_PROGRESS_MESSAGE
            : undefined,
    text: existingAssistant?.content ?? output.text,
    stance: existingAssistant?.stance ?? output.stance,
    interactionId: input.interactionId,
    orchestrationId: input.orchestrationId,
    orchestrationStatus: input.orchestrationStatus,
    aiStatus,
    citedFactKeys: output.citedFactKeys,
  };
}

async function pendingOrReplay(input: {
  db: Db;
  access: BusinessAccess;
  conversationId: string;
  interactionId: string;
  orchestrationId: string;
}): Promise<ChiefOfStaffRunResult> {
  const [interaction, orchestration] = await Promise.all([
    input.db.aiInteraction.findUnique({ where: { id: input.interactionId } }),
    input.db.aiOrchestrationRun.findUnique({ where: { id: input.orchestrationId } }),
  ]);
  if (orchestration && orchestration.status !== "PENDING") {
    return replayTerminal({
      db: input.db,
      conversationId: input.conversationId,
      businessId: input.access.businessId,
      interactionId: input.interactionId,
      orchestrationId: input.orchestrationId,
      orchestrationStatus: orchestration.status as OrchestrationStatus,
    });
  }
  if (interaction && interaction.status !== "PENDING") {
    return replayTerminal({
      db: input.db,
      conversationId: input.conversationId,
      businessId: input.access.businessId,
      interactionId: input.interactionId,
      orchestrationId: input.orchestrationId,
      orchestrationStatus: (orchestration?.status as OrchestrationStatus) ?? "FAILED",
    });
  }
  return inProgressResult(input.interactionId, input.orchestrationId);
}

async function finalizePreProviderFailure(input: {
  db: Db;
  interactionId: string;
  orchestrationId: string;
  reason: string;
  failures?: OrchestrationSkipFailure["failures"];
}): Promise<ChiefOfStaffRunResult> {
  const fallback = preProviderFallback();
  const failureReason = sanitizeFailureReason(input.reason);
  await input.db.aiInteraction.update({
    where: { id: input.interactionId },
    data: {
      status: "FAILED",
      failureReason,
      claimedAt: null,
      outputSummary: JSON.stringify(fallback),
    },
  });
  await input.db.aiOrchestrationRun.update({
    where: { id: input.orchestrationId },
    data: {
      status: "FAILED",
      skippedFailure: {
        skipped: [],
        failures: input.failures ?? [{ specialistId: "ATTENTION", message: failureReason }],
      } satisfies OrchestrationSkipFailure,
    },
  });
  return {
    error: failureReason,
    text: fallback.text,
    stance: fallback.stance,
    interactionId: input.interactionId,
    orchestrationId: input.orchestrationId,
    orchestrationStatus: "FAILED",
    aiStatus: "FAILED",
    citedFactKeys: [],
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
    return replayTerminal({
      db,
      conversationId: conversation.id,
      businessId: access.businessId,
      interactionId: existing.interactionId,
      orchestrationId: existing.id,
      orchestrationStatus: existing.status as OrchestrationStatus,
      fallback: {
        text: "Recorded TBBT facts were reused for this request.",
        stance: "MIXED",
        citedFactKeys: [],
      },
    });
  }

  let interactionId = existing?.interactionId;
  let orchestrationId = existing?.id;

  if (existing?.status === "PENDING") {
    const won = await claimAiInteraction(db, { id: existing.interactionId });
    if (!won) {
      return pendingOrReplay({
        db,
        access,
        conversationId: conversation.id,
        interactionId: existing.interactionId,
        orchestrationId: existing.id,
      });
    }
  } else if (!existing) {
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
      if (!raced) {
        return { error: "That coach request could not be recorded." };
      }
      if (raced.status !== "PENDING") {
        return replayTerminal({
          db,
          conversationId: conversation.id,
          businessId: access.businessId,
          interactionId: raced.interactionId,
          orchestrationId: raced.id,
          orchestrationStatus: raced.status as OrchestrationStatus,
        });
      }
      const won = await claimAiInteraction(db, { id: raced.interactionId });
      if (!won) {
        return pendingOrReplay({
          db,
          access,
          conversationId: conversation.id,
          interactionId: raced.interactionId,
          orchestrationId: raced.id,
        });
      }
      interactionId = raced.interactionId;
      orchestrationId = raced.id;
    }
  }

  if (!interactionId || !orchestrationId) {
    return { error: "That coach request could not be recorded." };
  }

  orchestrationWorkerCount += 1;
  resetDeepLoaderInvocations();

  let catalog: CanonicalRecommendationCatalog;
  let synthesis: ReturnType<typeof synthesizeCoachAnswer>;
  let plan: ReturnType<typeof planSpecialists>;
  let specialistResults: SpecialistResult[];
  let conflicts: ReturnType<typeof resolveConflicts>;
  try {
    if (input.test?.failCatalog) {
      throw new Error("injected catalog failure");
    }
    catalog = await loadCanonicalRecommendationCatalog(db, access.businessId);

    plan = planSpecialists({
      question,
      activeRecommendationKeys: catalog.activeRecommendations.map((item) => item.key),
    });

    specialistResults = [];
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

    conflicts = resolveConflicts({
      results: specialistResults,
      recommendations: catalog.activeRecommendations,
      facts: catalog.facts,
    });

    if (input.test?.failBeforeProvider) {
      throw new Error("injected pre-provider failure");
    }

    const extras = await loadCoachExtras(db, access.businessId);
    const { listActiveTradeCodes } = await import("@/lib/business-trades");
    const { workspaceTradeLabel } = await import("@/lib/trade-config");
    const activeTradeCodes = await listActiveTradeCodes(db as PrismaClient, access.businessId);
    synthesis = synthesizeCoachAnswer({
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
  } catch (error) {
    return finalizePreProviderFailure({
      db,
      interactionId,
      orchestrationId,
      reason:
        error instanceof Error ? error.message : "Business Health facts could not be loaded.",
    });
  }

  const failed = specialistResults.filter((row) => row.status === "FAILED");
  const ok = specialistResults.filter((row) => row.status === "OK");
  const orchestrationStatus: OrchestrationStatus =
    failed.length > 0 && ok.length > 0 ? "PARTIAL" : failed.length > 0 ? "FAILED" : "COMPLETED";

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
      alreadyClaimed: true,
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
