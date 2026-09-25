/**
 * Reusable operating procedures / checklists.
 * Not a no-code workflow engine.
 */

export const PROCEDURE_APPROVAL_STATES = ["UNREVIEWED", "APPROVED", "REJECTED"] as const;
export type ProcedureApprovalState = (typeof PROCEDURE_APPROVAL_STATES)[number];

export function isProcedureApprovalState(value: string | undefined): value is ProcedureApprovalState {
  return (PROCEDURE_APPROVAL_STATES as readonly string[]).includes(value ?? "");
}

export type ProcedureStepInput = {
  title: string;
  body?: string;
  required?: boolean;
};
