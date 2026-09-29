/**
 * OWNER writes for warranty statements and customer-reported callbacks.
 *
 * businessId always comes from BusinessAccess. These functions write only
 * JobWarrantyTerm and JobWarrantyCallback rows. They never create a Job,
 * an Invoice, a CustomerCommunication, a thread, or a phone interaction.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE,
  WARRANTY_CALLBACK_ALREADY_REVIEWED_MESSAGE,
  WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE,
  WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE,
  WARRANTY_CALLBACK_NOT_FOUND_MESSAGE,
  WARRANTY_CALLBACK_OUTCOME_REQUIRED_MESSAGE,
  WARRANTY_CALLBACK_REPORT_REQUIRED_MESSAGE,
  WARRANTY_CALLBACK_REVIEW_FIRST_MESSAGE,
  WARRANTY_CALLBACK_UNAVAILABLE_MESSAGE,
  WARRANTY_STATEMENT_REQUIRED_MESSAGE,
  assertWarrantyCallbackActor,
  assertWarrantyTextLength,
  displayRecordedWarrantyTerms,
  normalizeWarrantyText,
  type WarrantyTermsDisplay,
} from "@/lib/warranty-callback";

type Db = PrismaClient | Prisma.TransactionClient;

export class WarrantyCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarrantyCallbackError";
  }
}

export class WarrantyCallbackUnavailableError extends WarrantyCallbackError {
  constructor(message = WARRANTY_CALLBACK_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "WarrantyCallbackUnavailableError";
  }
}

function prismaErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

export function missingWarrantyCallbackSchema(error: unknown) {
  const code = prismaErrorCode(error);
  if (code === "P2002") return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /JobWarrantyTerm|JobWarrantyCallback|jobWarrantyTerm|jobWarrantyCallback|does not exist/i.test(
      message,
    )
  );
}

export function warrantyCallbackErrorMessage(error: unknown, fallback: string) {
  if (error instanceof WarrantyCallbackError || error instanceof ForbiddenError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingWarrantyCallbackSchema(error)) return WARRANTY_CALLBACK_UNAVAILABLE_MESSAGE;
  if (error instanceof Error && error.message === WARRANTY_STATEMENT_REQUIRED_MESSAGE) {
    return error.message;
  }
  if (
    error instanceof Error &&
    /warranty terms|callback|completed job|outcome|characters/i.test(error.message)
  ) {
    return error.message;
  }
  return fallback;
}

const JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
  customerId: true,
  updatedAt: true,
  customer: { select: { id: true, businessId: true } },
} as const;

type OwnedJob = Prisma.JobGetPayload<{ select: typeof JOB_SELECT }>;

function requireBoundedText(text: string) {
  try {
    assertWarrantyTextLength(text);
  } catch (error) {
    throw new WarrantyCallbackError(
      error instanceof Error ? error.message : WARRANTY_CALLBACK_UNAVAILABLE_MESSAGE,
    );
  }
}

function rethrowSchema(error: unknown): never {
  if (error instanceof WarrantyCallbackError || error instanceof ForbiddenError) throw error;
  if (missingWarrantyCallbackSchema(error)) throw new WarrantyCallbackUnavailableError();
  throw error;
}

async function loadOwnedJob(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<OwnedJob> {
  const id = jobId.trim();
  if (!id) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE);
  }
  const job = await db.job.findFirst({
    where: { id, businessId: access.businessId },
    select: JOB_SELECT,
  });
  if (!job) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE);
  }
  access.assertOwned(job);
  if (job.customer && job.customer.businessId !== access.businessId) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE);
  }
  return job;
}

function assertCompleted(job: OwnedJob) {
  if (job.status !== "COMPLETED") {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE);
  }
}

function sameBusinessCustomerId(job: OwnedJob, businessId: string): string | null {
  if (!job.customerId || !job.customer) return null;
  if (job.customer.id !== job.customerId) return null;
  if (job.customer.businessId !== businessId) return null;
  return job.customer.id;
}

const CALLBACK_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  customerId: true,
  report: true,
  status: true,
  reviewNote: true,
  reviewedAt: true,
  reviewedByMembershipId: true,
  outcomeNote: true,
  resolvedAt: true,
  resolvedByMembershipId: true,
  recordedByMembershipId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type WarrantyCallbackRow = Prisma.JobWarrantyCallbackGetPayload<{
  select: typeof CALLBACK_SELECT;
}>;

export type WarrantyCallbackReview = {
  jobId: string;
  businessId: string;
  completed: boolean;
  warranty: WarrantyTermsDisplay;
  callbacks: WarrantyCallbackRow[];
};

export async function loadJobWarrantyCallbackReview(
  db: Db,
  access: BusinessAccess | null | undefined,
  jobId: string,
): Promise<WarrantyCallbackReview | null> {
  assertWarrantyCallbackActor(access);
  try {
    const id = jobId.trim();
    if (!id) return null;
    const job = await db.job.findFirst({
      where: { id, businessId: access.businessId },
      select: JOB_SELECT,
    });
    if (!job) return null;
    access.assertOwned(job);

    const [terms, callbacks] = await Promise.all([
      db.jobWarrantyTerm.findMany({
        where: { businessId: access.businessId, jobId: job.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, statement: true, createdAt: true, businessId: true },
      }),
      db.jobWarrantyCallback.findMany({
        where: { businessId: access.businessId, jobId: job.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: CALLBACK_SELECT,
      }),
    ]);

    return {
      jobId: job.id,
      businessId: access.businessId,
      completed: job.status === "COMPLETED",
      warranty: displayRecordedWarrantyTerms(
        terms.filter((term) => term.businessId === access.businessId),
      ),
      callbacks: callbacks.filter((row) => row.businessId === access.businessId),
    };
  } catch (error) {
    rethrowSchema(error);
  }
}

export async function recordJobWarrantyTerm(
  db: Db,
  access: BusinessAccess | null | undefined,
  input: { jobId: string; statement: string },
) {
  assertWarrantyCallbackActor(access);
  const statement = normalizeWarrantyText(input.statement);
  if (!statement) {
    throw new WarrantyCallbackError(WARRANTY_STATEMENT_REQUIRED_MESSAGE);
  }
  requireBoundedText(statement);
  try {
    const job = await loadOwnedJob(db, access, input.jobId);
    assertCompleted(job);
    return await db.jobWarrantyTerm.create({
      data: {
        businessId: access.businessId,
        jobId: job.id,
        statement,
        recordedByMembershipId: access.workspace.membership.id,
      },
      select: {
        id: true,
        businessId: true,
        jobId: true,
        statement: true,
        createdAt: true,
      },
    });
  } catch (error) {
    rethrowSchema(error);
  }
}

export async function recordCustomerWarrantyCallback(
  db: Db,
  access: BusinessAccess | null | undefined,
  input: { jobId: string; report: string },
) {
  assertWarrantyCallbackActor(access);
  const report = normalizeWarrantyText(input.report);
  if (!report) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_REPORT_REQUIRED_MESSAGE);
  }
  requireBoundedText(report);
  try {
    const job = await loadOwnedJob(db, access, input.jobId);
    assertCompleted(job);
    return await db.jobWarrantyCallback.create({
      data: {
        businessId: access.businessId,
        jobId: job.id,
        customerId: sameBusinessCustomerId(job, access.businessId),
        report,
        status: "REPORTED",
        recordedByMembershipId: access.workspace.membership.id,
      },
      select: CALLBACK_SELECT,
    });
  } catch (error) {
    rethrowSchema(error);
  }
}

async function loadOwnedCallback(db: Db, access: BusinessAccess, callbackId: string) {
  const id = callbackId.trim();
  if (!id) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_NOT_FOUND_MESSAGE);
  }
  const row = await db.jobWarrantyCallback.findFirst({
    where: { id, businessId: access.businessId },
    select: CALLBACK_SELECT,
  });
  if (!row) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_NOT_FOUND_MESSAGE);
  }
  access.assertOwned(row);
  const job = await loadOwnedJob(db, access, row.jobId);
  assertCompleted(job);
  return row;
}

export async function reviewWarrantyCallback(
  db: Db,
  access: BusinessAccess | null | undefined,
  input: { callbackId: string; reviewNote?: string | null },
) {
  assertWarrantyCallbackActor(access);
  const reviewNote = normalizeWarrantyText(input.reviewNote);
  if (reviewNote) requireBoundedText(reviewNote);
  try {
    const existing = await loadOwnedCallback(db, access, input.callbackId);
    if (existing.status === "OUTCOME_RECORDED") {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE);
    }
    if (existing.status !== "REPORTED") {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_ALREADY_REVIEWED_MESSAGE);
    }
    const updated = await db.jobWarrantyCallback.updateMany({
      where: {
        id: existing.id,
        businessId: access.businessId,
        status: "REPORTED",
      },
      data: {
        status: "REVIEWED",
        reviewNote: reviewNote || null,
        reviewedAt: new Date(),
        reviewedByMembershipId: access.workspace.membership.id,
      },
    });
    if (updated.count !== 1) {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_ALREADY_REVIEWED_MESSAGE);
    }
    const row = await db.jobWarrantyCallback.findFirst({
      where: { id: existing.id, businessId: access.businessId },
      select: CALLBACK_SELECT,
    });
    if (!row) {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_NOT_FOUND_MESSAGE);
    }
    return row;
  } catch (error) {
    rethrowSchema(error);
  }
}

export async function recordWarrantyCallbackOutcome(
  db: Db,
  access: BusinessAccess | null | undefined,
  input: { callbackId: string; outcomeNote: string },
) {
  assertWarrantyCallbackActor(access);
  const outcomeNote = normalizeWarrantyText(input.outcomeNote);
  if (!outcomeNote) {
    throw new WarrantyCallbackError(WARRANTY_CALLBACK_OUTCOME_REQUIRED_MESSAGE);
  }
  requireBoundedText(outcomeNote);
  try {
    const existing = await loadOwnedCallback(db, access, input.callbackId);
    if (existing.status === "OUTCOME_RECORDED") {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE);
    }
    if (existing.status !== "REVIEWED") {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_REVIEW_FIRST_MESSAGE);
    }
    const updated = await db.jobWarrantyCallback.updateMany({
      where: {
        id: existing.id,
        businessId: access.businessId,
        status: "REVIEWED",
      },
      data: {
        status: "OUTCOME_RECORDED",
        outcomeNote,
        resolvedAt: new Date(),
        resolvedByMembershipId: access.workspace.membership.id,
      },
    });
    if (updated.count !== 1) {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE);
    }
    const row = await db.jobWarrantyCallback.findFirst({
      where: { id: existing.id, businessId: access.businessId },
      select: CALLBACK_SELECT,
    });
    if (!row) {
      throw new WarrantyCallbackError(WARRANTY_CALLBACK_NOT_FOUND_MESSAGE);
    }
    return row;
  } catch (error) {
    rethrowSchema(error);
  }
}

export async function countWarrantyCallbackSideEffects(db: PrismaClient) {
  const [jobs, invoices, communications, threads, phoneInteractions] = await Promise.all([
    db.job.count(),
    db.invoice.count(),
    db.customerCommunication.count(),
    db.communicationThread.count(),
    db.phoneInteraction.count(),
  ]);
  return { jobs, invoices, communications, threads, phoneInteractions };
}
