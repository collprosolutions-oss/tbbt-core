import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportCustomersPreview } from "@/components/customers/import-customers-preview";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import {
  CUSTOMER_CSV_IMPORT_ROUTE,
  CustomerCsvImportError,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE,
} from "@/lib/customer-csv-import";
import { loadOwnedImport } from "@/lib/customer-csv-import-ops";
import { formatDate, formatTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Import customer preview",
};

export default async function ImportCustomerPreviewPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const access = await requireManagementPageAccess();
  if (access.workspace.role !== "OWNER") {
    return (
      <PageContainer width="narrow">
        <PageHeader title="Import customer preview" description={OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE}>
          <Button asChild size="sm" variant="outline">
            <Link href="/customers">Back to customers</Link>
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
      error instanceof CustomerCsvImportError &&
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Import customer preview"
        description="Review source, capture date, invalid rows, and possible same-business duplicates. Correct or reject invalid rows before importing customers."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={CUSTOMER_CSV_IMPORT_ROUTE}>New preview</Link>
        </Button>
      </PageHeader>
      <ImportCustomersPreview
        importId={preview.id}
        sourceKind={preview.sourceKind}
        sourceLabel={preview.sourceLabel}
        capturedAtLabel={`${formatDate(preview.capturedAt)} ${formatTime(preview.capturedAt)}`}
        status={preview.status}
        validCount={preview.validCount}
        invalidCount={preview.invalidCount}
        possibleDuplicateCount={preview.possibleDuplicateCount}
        rejectedCount={preview.rejectedCount}
        createdCount={preview.createdCount}
        reusedCount={preview.reusedCount}
        rows={preview.rows.map((row) => ({
          id: row.id,
          rowNumber: row.rowNumber,
          previewStatus: row.previewStatus,
          invalidReason: row.invalidReason,
          name: row.name,
          email: row.email,
          phone: row.phone,
          propertyLabel: row.propertyLabel,
          streetAddress: row.streetAddress,
          unit: row.unit,
          city: row.city,
          region: row.region,
          postalCode: row.postalCode,
          possibleDuplicateCustomerId: row.possibleDuplicateCustomerId,
          createdCustomerId: row.createdCustomerId,
          createdPropertyId: row.createdPropertyId,
          reusedExistingCustomer: row.reusedExistingCustomer,
        }))}
      />
    </PageContainer>
  );
}
