/**
 * Route-level OWNER download for the customer-records export.
 *
 * Preview/build stays a read. Only this download path writes the
 * SettingsAuditLog row. Browser business IDs never authorize it.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  CustomerRecordsExportError,
  canExportCustomerRecords,
} from "@/lib/customer-records-export/access";
import { recordCustomerRecordsExportAudit } from "@/lib/customer-records-export/audit";
import {
  buildCustomerRecordsExport,
  type BuildCustomerRecordsExportInput,
} from "@/lib/customer-records-export/build";
import { customerRecordsExportFilename } from "@/lib/customer-records-export/contract";
import { serializeCustomerRecordsExport } from "@/lib/customer-records-export/parse";

export type CustomerRecordsExportDownloadResult =
  | {
      ok: true;
      status: 200;
      filename: string;
      contentType: "application/json; charset=utf-8";
      body: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404;
      error: string;
    };

export async function runCustomerRecordsExportDownload(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: BuildCustomerRecordsExportInput = {},
): Promise<CustomerRecordsExportDownloadResult> {
  if (!canExportCustomerRecords(access.workspace.role)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  try {
    const document = await buildCustomerRecordsExport(prisma, access, input);
    await recordCustomerRecordsExportAudit(prisma, access, document);
    return {
      ok: true,
      status: 200,
      filename: customerRecordsExportFilename(document),
      contentType: "application/json; charset=utf-8",
      body: serializeCustomerRecordsExport(document),
    };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    if (error instanceof CustomerRecordsExportError) {
      return { ok: false, status: error.status as 400 | 403 | 404, error: error.message };
    }
    throw error;
  }
}
