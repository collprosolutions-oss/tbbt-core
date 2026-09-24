import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureDefaultAutomationRules } from "@/lib/automation/rules";
import { appointmentReminderAvailableAt, parseServerScheduledAt } from "@/lib/automation/timing";
import type { BusinessEventType } from "@/lib/automation/types";
import { processPendingAutomationRuns } from "@/lib/automation/processor";

type Db = PrismaClient | Prisma.TransactionClient;

function eventPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveAvailableAt(
  rule: { purpose: string; delayMinutes: number },
  event: { type: string; occurredAt: Date; payload: unknown },
) {
  if (rule.purpose === "APPOINTMENT_REMINDER") {
    const scheduledAt = parseServerScheduledAt(eventPayload(event.payload).scheduledAt);
    if (!scheduledAt) return null;
    return appointmentReminderAvailableAt(scheduledAt, rule.delayMinutes);
  }
  return new Date(event.occurredAt.getTime() + rule.delayMinutes * 60_000);
}

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

export async function skipSupersededAppointmentReminders(
  db: Db,
  input: { businessId: string; jobId: string; proposalId: number },
) {
  const pending = await db.automationRun.findMany({
    where: {
      businessId: input.businessId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
    include: { event: true, rule: true },
  });
  for (const run of pending) {
    if (run.rule?.purpose !== "APPOINTMENT_REMINDER") continue;
    if (run.event.subjectType !== "JOB" || run.event.subjectId !== input.jobId) continue;
    const proposalId = eventPayload(run.event.payload).proposalId;
    if (proposalId === input.proposalId) continue;
    await db.automationRun.updateMany({
      where: {
        id: run.id,
        businessId: input.businessId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: {
        status: "SKIPPED",
        resultSummary: "Superseded by a later appointment proposal. SENT was not recorded.",
        processedAt: new Date(),
      },
    });
  }
}

export async function queueAutomationRunsForEvent(
  db: Db,
  businessId: string,
  event: { id: string; type: string; occurredAt: Date; payload: unknown },
) {
  const rules = (await ensureDefaultAutomationRules(db, businessId)).filter(
    (rule) => rule.eventType === event.type && rule.enabled,
  );
  for (const rule of rules) {
    const availableAt = resolveAvailableAt(rule, event);
    if (!availableAt) continue;
    const idempotencyKey = `run:${event.id}:${rule.id}`;
    try {
      await db.automationRun.create({
        data: {
          businessId,
          eventId: event.id,
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
      await queueAutomationRunsForEvent(db, input.businessId, emitted.event);
      if (input.type === "APPOINTMENT_CHANGED") {
        const proposalId = eventPayload(input.payload).proposalId;
        if (typeof proposalId === "number") {
          await skipSupersededAppointmentReminders(db, {
            businessId: input.businessId,
            jobId: input.subjectId,
            proposalId,
          });
        }
      }
    }
    await processPendingAutomationRuns(db, input.businessId);
    return emitted;
  } catch (error) {
    console.error("Automation emit/process failed; core record was not rolled back", error);
    return null;
  }
}
