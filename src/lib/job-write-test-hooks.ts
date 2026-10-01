/**
 * Test-only barriers for owner job writes. Production never sets these.
 */
export const jobWriteTestHooks: {
  afterStartJobRead?: (jobId: string) => Promise<void> | void;
  afterOwnerConfirmRead?: (jobId: string) => Promise<void> | void;
  afterScheduleJobRead?: (jobId: string) => Promise<void> | void;
} = {};
