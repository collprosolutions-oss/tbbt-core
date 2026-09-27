import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportLeadsPreview } from "@/components/requests/import-leads-preview";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import {
  EXTERNAL_LEAD_IMPORT_ROUTE,
  ExternalLeadImportError,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  OWNER_ONLY_IMPORT_MESSAGE,
} from "@/lib/external-lead-import";
import { loadOwnedImport } from "@/lib/external-lead-import-ops";
import { formatDate, formatTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Import lead preview",
};

export default async function ImportLeadPreviewPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const access = await requireManagementPageAccess();
  if (access.workspace.role !== "OWNER") {
    return (
      <PageContainer width="narrow">
        <PageHeader title="Import lead preview" description={OWNER_ONLY_IMPORT_MESSAGE}>
          <Button asChild size="sm" variant="outline">
            <Link href="/requests">Back to requests</Link>
          </Button>
        </PageHeader>
      </PageContainer>
    );
  }

  const { importId } = await params;
  let preview;
  try {
    preview = await loadOwnedImport(prisma, access, importId);
  } catch (error) {
    if (
      error instanceof ExternalLeadImportError &&
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Import lead preview"
        description="Review source, capture date, invalid rows, and possible same-business duplicates before creating leads."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={EXTERNAL_LEAD_IMPORT_ROUTE}>New preview</Link>
        </Button>
      </PageHeader>
      <ImportLeadsPreview
        importId={preview.id}
        sourceKind={preview.sourceKind}
        sourceLabel={preview.sourceLabel}
        capturedAtLabel={`${formatDate(preview.capturedAt)} ${formatTime(preview.capturedAt)}`}
        status={preview.status}
        validCount={preview.validCount}
        invalidCount={preview.invalidCount}
        possibleDuplicateCount={preview.possibleDuplicateCount}
        createdCount={preview.createdCount}
        rows={preview.rows.map((row) => ({
          id: row.id,
          rowNumber: row.rowNumber,
          previewStatus: row.previewStatus,
          invalidReason: row.invalidReason,
          name: row.name,
          email: row.email,
          phone: row.phone,
          summary: row.summary,
          possibleDuplicateCustomerId: row.possibleDuplicateCustomerId,
          possibleDuplicateRequestId: row.possibleDuplicateRequestId,
          createdRequestId: row.createdRequestId,
        }))}
      />
    </PageContainer>
  );
}
