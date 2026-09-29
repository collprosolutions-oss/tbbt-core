import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportCatalogPreview } from "@/components/catalog/import-catalog-preview";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { splitCatalogDescription } from "@/lib/estimate-line-scope";
import { formatDate, formatTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  SERVICE_CATALOG_IMPORT_ROUTE,
  ServiceCatalogImportError,
} from "@/lib/service-catalog-import";
import { loadOwnedCatalogImport } from "@/lib/service-catalog-import-ops";

export const metadata: Metadata = {
  title: "Catalog import preview",
};

export default async function ImportCatalogPreviewPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const access = await requireManagementPageAccess();
  if (access.workspace.role !== "OWNER") {
    return (
      <PageContainer width="narrow">
        <PageHeader title="Catalog import preview" description={OWNER_ONLY_CATALOG_IMPORT_MESSAGE}>
          <Button asChild size="sm" variant="outline">
            <Link href="/services">Back to Services</Link>
          </Button>
        </PageHeader>
      </PageContainer>
    );
  }

  const { importId } = await params;
  let preview;
  try {
    preview = await loadOwnedCatalogImport(prisma, access, importId);
  } catch (error) {
    if (
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE
    ) {
      notFound();
    }
    throw error;
  }

  const matchedIds = preview.rows
    .map((row) => row.matchedCatalogItemId)
    .filter((id): id is string => Boolean(id));
  const currentItems =
    matchedIds.length === 0
      ? []
      : await prisma.serviceCatalogItem.findMany({
          where: { businessId: access.businessId, id: { in: matchedIds } },
          select: {
            id: true,
            name: true,
            description: true,
            pricingMode: true,
            price: true,
            category: true,
            active: true,
          },
        });
  const currentById = new Map(currentItems.map((item) => [item.id, item]));

  return (
    <PageContainer>
      <PageHeader
        title="Catalog import preview"
        description="Review validation errors and same-business name matches. Matched services change only when you pick update. Blank cells keep existing values. Catalog rows are written only after you confirm."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={SERVICE_CATALOG_IMPORT_ROUTE}>New preview</Link>
        </Button>
      </PageHeader>
      <ImportCatalogPreview
        importId={preview.id}
        sourceKind={preview.sourceKind}
        sourceLabel={preview.sourceLabel}
        capturedAtLabel={`${formatDate(preview.capturedAt)} ${formatTime(preview.capturedAt)}`}
        status={preview.status}
        validCount={preview.validCount}
        invalidCount={preview.invalidCount}
        nameMatchCount={preview.nameMatchCount}
        writtenCount={preview.writtenCount}
        confirmingRecoverable={preview.confirmingRecoverable}
        rows={preview.rows.map((row) => {
          const current = row.matchedCatalogItemId
            ? currentById.get(row.matchedCatalogItemId)
            : undefined;
          return {
            id: row.id,
            rowNumber: row.rowNumber,
            previewStatus: row.previewStatus,
            invalidReason: row.invalidReason,
            name: row.name,
            description: row.description,
            pricingMode: row.pricingMode,
            price: row.price?.toString() ?? "",
            category: row.category,
            tradeCode: row.tradeCode,
            unitLabel: row.unitLabel,
            recurrenceEligible: row.recurrenceEligible,
            active: row.active,
            matchedCatalogItemId: row.matchedCatalogItemId,
            writtenCatalogItemId: row.writtenCatalogItemId,
            writeAction: row.writeAction,
            matchDecision: row.matchDecision,
            current: current
              ? {
                  id: current.id,
                  name: current.name,
                  description: splitCatalogDescription(current.description).includedWork,
                  pricingMode: current.pricingMode,
                  price: current.price?.toString() ?? "",
                  category: current.category,
                  active: current.active,
                }
              : null,
          };
        })}
      />
    </PageContainer>
  );
}
