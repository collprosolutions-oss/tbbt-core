import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CustomerRecordsExportPanel } from "@/components/customers/customer-records-export-panel";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  CustomerRecordsExportError,
  buildCustomerRecordsExport,
  canExportCustomerRecords,
} from "@/lib/customer-records-export";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Customer records export",
};

export default async function CustomerRecordsExportPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; customerId?: string }>;
}) {
  const access = await requireManagementPageAccess();
  if (!canExportCustomerRecords(access.workspace.role)) {
    redirect("/access-restricted");
  }

  const params = await searchParams;
  let document;
  try {
    document = await buildCustomerRecordsExport(prisma, access, {
      cursor: params.cursor,
      customerId: params.customerId,
    });
  } catch (error) {
    if (error instanceof CustomerRecordsExportError && error.code === "NOT_FOUND") {
      redirect("/customers/records-export");
    }
    throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Customer records export"
        description="OWNER-authorized, versioned snapshot of this workspace’s customers and their same-business properties, structured addresses, requests, estimates, jobs, invoices, payments, invoice credits, and time cards. Large exports stay paginated. Private files stay permitted references."
      />
      <CustomerRecordsExportPanel document={document} />
    </PageContainer>
  );
}
