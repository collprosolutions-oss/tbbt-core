import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  CustomerRecordsExportError,
  buildCustomerRecordsExport,
  customerRecordsExportFilename,
  serializeCustomerRecordsExport,
} from "@/lib/customer-records-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireBusinessAccess();
  const url = new URL(request.url);

  try {
    const document = await buildCustomerRecordsExport(prisma, access, {
      cursor: url.searchParams.get("cursor"),
      customerId: url.searchParams.get("customerId"),
    });
    return new NextResponse(serializeCustomerRecordsExport(document), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${customerRecordsExportFilename(document)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof CustomerRecordsExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
