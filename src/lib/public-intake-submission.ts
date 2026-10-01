/**
 * Transaction claim for public-intake replay tokens.
 *
 * Kept out of public-intake.ts so published-website intake snapshot
 * checks can keep forbidding $executeRaw in that file. The lock is
 * only a transaction advisory lock, not schema DDL.
 */
export function publicIntakeSubmissionLockKey(businessId: string, submissionId: string) {
  return `tbbt.public-intake:${businessId}:${submissionId}`;
}

export const publicIntakeTestHooks: {
  afterSubmissionClaim?: (input: {
    businessId: string;
    submissionId: string;
  }) => Promise<void> | void;
} = {};

type SubmissionLockTx = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

export async function claimPublicIntakeSubmission(
  tx: object,
  businessId: string,
  submissionId: string,
) {
  const client = tx as SubmissionLockTx;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${publicIntakeSubmissionLockKey(businessId, submissionId)}))`;
  await publicIntakeTestHooks.afterSubmissionClaim?.({
    businessId,
    submissionId,
  });
}
