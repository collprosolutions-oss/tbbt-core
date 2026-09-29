import type { Metadata } from "next";
import Link from "next/link";
import { CollectionsWorklist } from "@/components/invoices/collections-worklist";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  BANK_NOT_CONNECTED_COLLECTIONS_MESSAGE,
  COLLECTIONS_BALANCE_MESSAGE,
  COLLECTIONS_NO_DUE_DATE_MESSAGE,
  COLLECTIONS_OWNER_NEXT_STEP_MESSAGE,
  COLLECTIONS_OWNER_RESOLVE_MESSAGE,
  COLLECTIONS_READ_ONLY_MESSAGE,
  COLLECTIONS_UNAVAILABLE_MESSAGE,
  assertCanReadCollectionsWorklist,
  collectionsWorklistWriteAllowed,
  loadCollectionsWorklist,
} from "@/lib/collections";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Collections",
};

export default async function CollectionsWorklistPage() {
  const access = await requireManagementPageAccess();
  assertCanReadCollectionsWorklist(access);
  const workspace = await loadCollectionsWorklist(prisma, access);
  const canWrite = collectionsWorklistWriteAllowed(access.workspace.role);

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Collections"
        description={`Unpaid sent invoices for ${access.workspace.business.name}. ${COLLECTIONS_READ_ONLY_MESSAGE} ${COLLECTIONS_BALANCE_MESSAGE} ${COLLECTIONS_NO_DUE_DATE_MESSAGE} ${BANK_NOT_CONNECTED_COLLECTIONS_MESSAGE}${canWrite ? ` ${COLLECTIONS_OWNER_NEXT_STEP_MESSAGE} ${COLLECTIONS_OWNER_RESOLVE_MESSAGE}` : ""}`}
      >
        <p className="text-sm">
          <Link href="/invoices" className="underline underline-offset-4">
            Back to invoices
          </Link>
        </p>
      </PageHeader>
      {workspace.unavailable ? (
        <p className="text-sm text-muted-foreground">{COLLECTIONS_UNAVAILABLE_MESSAGE}</p>
      ) : null}
      <CollectionsWorklist workspace={workspace} canWrite={canWrite} />
    </PageContainer>
  );
}
