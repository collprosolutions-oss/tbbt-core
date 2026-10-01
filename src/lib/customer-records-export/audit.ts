/**
 * Persist who exported customer records and when.
 *
 * Reuses SettingsAuditLog (settingArea data-export). Preview/build stays
 * a read. Only the OWNER download path writes this row.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { assertCanExportCustomerRecords } from "@/lib/customer-records-export/access";
import {
  CUSTOMER_RECORDS_EXPORT_AUDIT_AREA,
  CUSTOMER_RECORDS_EXPORT_AUDIT_KEY,
  type CustomerRecordsExportDocument,
} from "@/lib/customer-records-export/contract";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

export type CustomerRecordsExportAuditRecord = {
  id: string;
  businessId: string;
  changedByMembershipId: string;
  settingArea: string;
  settingKey: string;
  previousValue: string | null;
  newValue: string | null;
  changedAt: Date;
};

export function customerRecordsExportAuditPayload(document: CustomerRecordsExportDocument) {
  return {
    contract: document.contract,
    version: document.version,
    exportedAt: document.exportedAt,
    authorizedByMembershipId: document.authorization.authorizedByMembershipId,
    customerCount: document.provenance.page.count,
    truncated: document.provenance.page.truncated,
    cursor: document.provenance.page.cursor,
    nextCursor: document.provenance.page.nextCursor,
    customerId: document.provenance.page.customerId,
  };
}

export async function recordCustomerRecordsExportAudit(
  prisma: PrismaClient,
  access: BusinessAccess,
  document: CustomerRecordsExportDocument,
): Promise<CustomerRecordsExportAuditRecord> {
  assertCanExportCustomerRecords(access);
  return writeSettingsAuditLog(prisma, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: CUSTOMER_RECORDS_EXPORT_AUDIT_AREA,
    settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY,
    previousValue: null,
    newValue: customerRecordsExportAuditPayload(document),
  });
}
