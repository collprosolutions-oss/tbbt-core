import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReconciliationWorkspace } from "@/components/reconciliation/reconciliation-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import {
  BANK_IMPORT_NOT_AVAILABLE_MESSAGE,
  BANK_NOT_A_BALANCE_MESSAGE,
  BANK_NOT_A_PAYMENT_MESSAGE,
  BANK_RECONCILIATION_ROUTE,
  BankReconciliationError,
  OWNER_ONLY_BANK_RECONCILIATION_MESSAGE,
} from "@/lib/bank-reconciliation";
import { loadOwnedBankReconciliation } from "@/lib/bank-reconciliation-ops";
import { formatDate, formatTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Bank CSV workspace",
};

export default async function BankReconciliationWorkspacePage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const access = await requireManagementPageAccess();
  if (!roleHasCapability(access.workspace.role, CAPABILITIES.REVIEW_BANK_RECONCILIATION)) {
    return (
      <PageContainer width="narrow">
        <PageHeader title="Bank CSV workspace" description={OWNER_ONLY_BANK_RECONCILIATION_MESSAGE}>
          <Button asChild size="sm" variant="outline">
            <Link href={BANK_RECONCILIATION_ROUTE}>Back</Link>
          </Button>
        </PageHeader>
      </PageContainer>
    );
  }

  const { importId } = await params;
  let workspace;
  try {
    workspace = await loadOwnedBankReconciliation(prisma, access, importId);
  } catch (error) {
    if (
      error instanceof BankReconciliationError &&
      error.message === BANK_IMPORT_NOT_AVAILABLE_MESSAGE
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Bank CSV workspace"
        description={`${BANK_NOT_A_PAYMENT_MESSAGE} ${BANK_NOT_A_BALANCE_MESSAGE}`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href={BANK_RECONCILIATION_ROUTE}>New import</Link>
        </Button>
      </PageHeader>
      <ReconciliationWorkspace
        importId={workspace.id}
        sourceLabel={workspace.sourceLabel}
        capturedAtLabel={`${formatDate(workspace.capturedAt)} ${formatTime(workspace.capturedAt)}`}
        postedDepositCents={workspace.postedDepositCents}
        postedWithdrawalCents={workspace.postedWithdrawalCents}
        netPostedCents={workspace.netPostedCents}
        acceptedDepositCents={workspace.acceptedDepositCents}
        acceptedWithdrawalCents={workspace.acceptedWithdrawalCents}
        rowCount={workspace.rowCount}
        candidateMatchCount={workspace.candidateMatchCount}
        unmatchedCount={workspace.unmatchedCount}
        duplicateRowCount={workspace.duplicateRowCount}
        reversedCount={workspace.reversedCount}
        invalidCount={workspace.invalidCount}
        rows={workspace.rows.map((row) => ({
          id: row.id,
          rowNumber: row.rowNumber,
          postedOn: row.postedOn,
          description: row.description,
          amountCents: row.amountCents,
          direction: row.direction,
          reviewStatus: row.reviewStatus,
          invalidReason: row.invalidReason,
          reversalOfRowNumber: row.reversalOfRowNumber,
          duplicateOfRowNumber: row.duplicateOfRowNumber,
          matches: row.matches.map((match) => ({
            id: match.id,
            candidateKind: match.candidateKind,
            candidateId: match.candidateId,
            score: match.score,
            matchReason: match.matchReason,
            status: match.status,
            candidateLabel: match.candidateLabel,
            candidateAmount: match.candidateAmount,
            candidateDate: match.candidateDate,
          })),
        }))}
      />
    </PageContainer>
  );
}
