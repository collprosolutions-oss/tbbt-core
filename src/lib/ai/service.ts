/**
 * AI service boundary. Authorization happens in the caller. This module
 * records audits, enforces structured output, and never writes financial
 * or permission state.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { isAiProviderConnected, readAiModel } from "@/lib/ai/config";
import { resolveAiProvider } from "@/lib/ai/provider";
import { sanitizeAiText, summarizeAiInput } from "@/lib/ai/sanitize";
import {
  AI_FAILURE_MESSAGE,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
  AI_NOT_CONNECTED_MESSAGE,
  AI_VALIDATION_MESSAGE,
  type AiRunResult,
  type AiTaskType,
  type StructuredAiOutput,
} from "@/lib/ai/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type AiServiceActor = {
  businessId: string;
  membershipId?: string | null;
  userId?: string | null;
};

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function parseStructuredAiOutput(raw: string): StructuredAiOutput | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StructuredAiOutput>;
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return null;
    const stance =
      parsed.stance === "FACT" || parsed.stance === "RECOMMENDATION" || parsed.stance === "MIXED"
        ? parsed.stance
        : "MIXED";
    const citedFactKeys = Array.isArray(parsed.citedFactKeys)
      ? parsed.citedFactKeys.filter((key): key is string => typeof key === "string").slice(0, 20)
      : [];
    return {
      text: sanitizeAiText(text, 4_000),
      stance,
      citedFactKeys,
      notes: typeof parsed.notes === "string" ? sanitizeAiText(parsed.notes, 400) : undefined,
    };
  } catch {
    return null;
  }
}

async function recordUsage(
  db: Db,
  businessId: string,
  status: AiRunResult["status"],
  usage?: { promptTokens?: number; completionTokens?: number },
) {
  const periodStart = monthStart(new Date());
  await db.aiUsagePeriod.upsert({
    where: { businessId_periodStart: { businessId, periodStart } },
    create: {
      businessId,
      periodStart,
      requestCount: 1,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      failedCount: status === "FAILED" || status === "VALIDATION_FAILED" ? 1 : 0,
      skippedCount: status === "SKIPPED_NOT_CONNECTED" ? 1 : 0,
    },
    update: {
      requestCount: { increment: 1 },
      promptTokens: { increment: usage?.promptTokens ?? 0 },
      completionTokens: { increment: usage?.completionTokens ?? 0 },
      failedCount: { increment: status === "FAILED" || status === "VALIDATION_FAILED" ? 1 : 0 },
      skippedCount: { increment: status === "SKIPPED_NOT_CONNECTED" ? 1 : 0 },
    },
  });
}

export async function runAiTask(
  db: Db,
  actor: AiServiceActor,
  input: {
    taskType: AiTaskType;
    system: string;
    user: string;
    inputSummary: string;
    conversationId?: string | null;
    idempotencyKey: string;
    fallback: StructuredAiOutput;
    allowRetry?: boolean;
  },
): Promise<AiRunResult> {
  const existing = await db.aiInteraction.findUnique({
    where: {
      businessId_idempotencyKey: {
        businessId: actor.businessId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    const output = existing.outputSummary ? parseStructuredAiOutput(existing.outputSummary) : input.fallback;
    return {
      status: existing.status as AiRunResult["status"],
      connected: isAiProviderConnected(),
      provider: existing.provider,
      model: existing.model,
      output: output ?? input.fallback,
      message:
        existing.status === "SKIPPED_NOT_CONNECTED"
          ? AI_NOT_CONNECTED_MESSAGE
          : existing.status === "FAILED"
            ? AI_FAILURE_MESSAGE
            : existing.status === "VALIDATION_FAILED"
              ? AI_VALIDATION_MESSAGE
              : "Completed.",
      failureReason: existing.failureReason ?? undefined,
      retryable: false,
      interactionId: existing.id,
    };
  }

  const pending = await db.aiInteraction.create({
    data: {
      businessId: actor.businessId,
      membershipId: actor.membershipId ?? null,
      userId: actor.userId ?? null,
      conversationId: input.conversationId ?? null,
      taskType: input.taskType,
      status: "PENDING",
      inputSummary: summarizeAiInput(input.taskType, input.inputSummary),
      idempotencyKey: input.idempotencyKey,
    },
  });

  const provider = resolveAiProvider();
  if (!provider.connected) {
    const result: AiRunResult = {
      status: "SKIPPED_NOT_CONNECTED",
      connected: false,
      provider: provider.id,
      model: null,
      output: input.fallback,
      message: AI_NOT_CONNECTED_MESSAGE,
      retryable: false,
      interactionId: pending.id,
    };
    await db.aiInteraction.update({
      where: { id: pending.id },
      data: {
        status: result.status,
        provider: provider.id,
        outputSummary: JSON.stringify(input.fallback),
        failureReason: AI_NOT_CONNECTED_MESSAGE,
      },
    });
    await recordUsage(db, actor.businessId, result.status);
    return result;
  }

  let lastFailure = "The AI provider could not complete that request.";
  let lastUsage: AiRunResult["usage"];
  let attempts = 0;
  const maxAttempts = 1 + (input.allowRetry === false ? 0 : AI_MAX_RETRIES);

  while (attempts < maxAttempts) {
    attempts += 1;
    const completed = await provider.complete({
      taskType: input.taskType,
      system: input.system,
      user: input.user,
      jsonSchemaName: "tbbt_ai_output",
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    });
    if (completed.ok) {
      const parsed = parseStructuredAiOutput(completed.text);
      if (!parsed) {
        lastFailure = AI_VALIDATION_MESSAGE;
        lastUsage = completed.usage;
        if (attempts >= maxAttempts) {
          const result: AiRunResult = {
            status: "VALIDATION_FAILED",
            connected: true,
            provider: completed.provider,
            model: completed.model,
            output: input.fallback,
            message: AI_VALIDATION_MESSAGE,
            failureReason: AI_VALIDATION_MESSAGE,
            retryable: false,
            usage: completed.usage,
            interactionId: pending.id,
          };
          await db.aiInteraction.update({
            where: { id: pending.id },
            data: {
              status: result.status,
              provider: completed.provider,
              model: completed.model,
              latencyMs: completed.latencyMs,
              promptTokens: completed.usage?.promptTokens,
              completionTokens: completed.usage?.completionTokens,
              retryCount: attempts - 1,
              outputSummary: JSON.stringify(input.fallback),
              failureReason: AI_VALIDATION_MESSAGE,
            },
          });
          await recordUsage(db, actor.businessId, result.status, completed.usage);
          return result;
        }
        continue;
      }
      const result: AiRunResult = {
        status: "COMPLETED",
        connected: true,
        provider: completed.provider,
        model: completed.model,
        output: parsed,
        message: "AI draft ready. Owner review is still required.",
        retryable: false,
        usage: completed.usage,
        interactionId: pending.id,
      };
      await db.aiInteraction.update({
        where: { id: pending.id },
        data: {
          status: result.status,
          provider: completed.provider,
          model: completed.model,
          latencyMs: completed.latencyMs,
          promptTokens: completed.usage?.promptTokens,
          completionTokens: completed.usage?.completionTokens,
          retryCount: attempts - 1,
          outputSummary: JSON.stringify(parsed),
        },
      });
      await recordUsage(db, actor.businessId, result.status, completed.usage);
      return result;
    }
    lastFailure = completed.error;
    if (!completed.retryable || attempts >= maxAttempts) {
      const result: AiRunResult = {
        status: "FAILED",
        connected: true,
        provider: completed.provider,
        model: completed.model ?? readAiModel(),
        output: input.fallback,
        message: AI_FAILURE_MESSAGE,
        failureReason: completed.error,
        retryable: false,
        interactionId: pending.id,
      };
      await db.aiInteraction.update({
        where: { id: pending.id },
        data: {
          status: result.status,
          provider: completed.provider,
          model: result.model,
          latencyMs: completed.latencyMs,
          retryCount: attempts - 1,
          outputSummary: JSON.stringify(input.fallback),
          failureReason: completed.error,
        },
      });
      await recordUsage(db, actor.businessId, result.status);
      return result;
    }
  }

  const result: AiRunResult = {
    status: "FAILED",
    connected: true,
    provider: "openai",
    model: readAiModel(),
    output: input.fallback,
    message: AI_FAILURE_MESSAGE,
    failureReason: lastFailure,
    retryable: false,
    usage: lastUsage,
    interactionId: pending.id,
  };
  await db.aiInteraction.update({
    where: { id: pending.id },
    data: {
      status: result.status,
      failureReason: lastFailure,
      outputSummary: JSON.stringify(input.fallback),
    },
  });
  await recordUsage(db, actor.businessId, result.status, lastUsage);
  return result;
}

export async function loadAiUsage(db: Db, businessId: string) {
  return db.aiUsagePeriod.findMany({
    where: { businessId },
    orderBy: { periodStart: "desc" },
    take: 6,
  });
}
