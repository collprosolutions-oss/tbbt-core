import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureDefaultAutomationRules } from "@/lib/automation/rules";
import type { BusinessEventType } from "@/lib/automation/types";
import { processPendingAutomationRuns } from "@/lib/automation/processor";

type Db = PrismaClient | Prisma.TransactionClient;

export async function emitBusinessEvent(
  db: Db,
  input: {
    businessId: string;
    type: BusinessEventType;
    subjectType: string;
    subjectId: string;
    payload?: Record<string, unknown> | null;
    idempotencyKey: string;
    occurredAt?: Date;
  },
) {
  const existing = await db.businessEvent.findUnique({
    where: {
      businessId_idempotencyKey: {
        businessId: input.businessId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) return { event: existing, created: false };

  try {
    const event = await db.businessEvent.create({
      data: {
        businessId: input.businessId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
      },
    });
    return { event, created: true };
  } catch (error) {
    const raced = await db.businessEvent.findUnique({
      where: {
        businessId_idempotencyKey: {
          businessId: input.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (raced) return { event: raced, created: false };
    throw error;
  }
}

export async function queueAutomationRunsForEvent(
  db: Db,
  businessId: string,
  eventId: string,
  eventType: string,
  occurredAt: Date,
) {
  const rules = (await ensureDefaultAutomationRules(db, businessId)).filter(
    (rule) => rule.eventType === eventType && rule.enabled,
  );
  for (const rule of rules) {
    const availableAt = new Date(occurredAt.getTime() + rule.delayMinutes * 60_000);
    const idempotencyKey = `run:${eventId}:${rule.id}`;
    try {
      await db.automationRun.create({
        data: {
          businessId,
          eventId,
          ruleId: rule.id,
          kind: rule.kind,
          status: "PENDING",
          idempotencyKey,
          availableAt,
        },
      });
    } catch {
      // Unique (businessId, idempotencyKey) makes this retry-safe.
    }
  }
}

/**
 * Emit an event and process due runs. Failures never throw to the caller
 * so a provider outage cannot unwind the core business write.
 */
export async function emitAndProcessBusinessEvent(
  db: Db,
  input: Parameters<typeof emitBusinessEvent>[1],
) {
  try {
    const emitted = await emitBusinessEvent(db, input);
    if (emitted.created) {
      await queueAutomationRunsForEvent(
        db,
        input.businessId,
        emitted.event.id,
        emitted.event.type,
        emitted.event.occurredAt,
      );
    }
    await processPendingAutomationRuns(db, input.businessId);
    return emitted;
  } catch (error) {
    console.error("Automation emit/process failed; core record was not rolled back", error);
    return null;
  }
}
