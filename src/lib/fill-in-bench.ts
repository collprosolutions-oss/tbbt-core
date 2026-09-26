/**
 * Fill-In Bench owner tool — backup workers, subcontractors, helpers,
 * and future hires recorded for this business only.
 *
 * Extends the existing FillInBenchWorker model. This is not a second
 * Membership/User engine, not a marketplace, and not automatic assignment.
 * Saving a bench row never creates a login, Membership, Job assignment,
 * time card, payroll record, or outbound message.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  formatBenchWorkerType,
  skillLabel,
  type FillInBenchRecord,
} from "@/lib/workforce";
import { loadFillInBench } from "@/lib/workforce-data";

type FillInBenchClient = PrismaClient | Prisma.TransactionClient;

export type RecordedBenchSkillFact = {
  skillKey: string;
  label: string;
  recordedActiveCount: number;
};

export function requireFillInBenchManagement(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
}

export async function loadOwnedFillInBench(
  db: FillInBenchClient,
  access: BusinessAccess,
): Promise<FillInBenchRecord[]> {
  requireFillInBenchManagement(access);
  return loadFillInBench(db, access.businessId);
}

export function partitionFillInBench(bench: FillInBenchRecord[]) {
  return {
    active: bench.filter((row) => row.active),
    inactive: bench.filter((row) => !row.active),
  };
}

export function countActiveBenchWorkersWithSkill(
  bench: Array<Pick<FillInBenchRecord, "active" | "skills">>,
  skillKey: string,
) {
  if (!skillKey) return 0;
  return bench.filter((row) => row.active && row.skills.includes(skillKey)).length;
}

export function recordedBenchSkillFacts(
  bench: Array<Pick<FillInBenchRecord, "active" | "skills">>,
  skillKeys?: string[],
): RecordedBenchSkillFact[] {
  const keys = skillKeys?.length
    ? [...new Set(skillKeys.filter(Boolean))]
    : [...new Set(bench.flatMap((row) => (row.active ? row.skills : [])))];
  return keys
    .map((skillKey) => ({
      skillKey,
      label: skillLabel(skillKey),
      recordedActiveCount: countActiveBenchWorkersWithSkill(bench, skillKey),
    }))
    .filter((row) => row.recordedActiveCount > 0);
}

/**
 * Staffing-shortage copy from recorded bench skills only.
 * Never names a person and never calls anyone qualified unless the
 * required skill is actually recorded on an active bench row.
 */
export function describeRecordedBenchSkillFacts(
  bench: Array<Pick<FillInBenchRecord, "active" | "skills">>,
  requiredSkills: string[],
): string | null {
  const required = [...new Set(requiredSkills.map((skill) => skill.trim()).filter(Boolean))];
  if (required.length === 0) return null;
  const statements = required.map((skillKey) => {
    const count = countActiveBenchWorkersWithSkill(bench, skillKey);
    const label = skillLabel(skillKey);
    if (count === 0) {
      return `No active Fill-In Bench worker has the required recorded ${label} skill.`;
    }
    return `${count} active bench worker${count === 1 ? "" : "s"} have ${label} skill recorded.`;
  });
  if (statements.every((line) => line.startsWith("No active"))) {
    return "No active Fill-In Bench worker has the required recorded skill.";
  }
  return statements.join(" ");
}

export function benchWorkerTypeLabel(worker: Pick<FillInBenchRecord, "workerType">) {
  return formatBenchWorkerType(worker.workerType);
}
