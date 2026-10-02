/**
 * Test-only barrier for sendEstimate. Production never sets this.
 * Kept out of the "use server" actions file so Next.js can load
 * /estimates/new (use-server files may only export async functions).
 */
export const estimateSendTestHooks: {
  afterEstimateLock?: (input: { estimateId: string }) => Promise<void> | void;
} = {};
