import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  JobPropertyExportError,
  buildCompletedJobPropertyExport,
  jobPropertyExportFilename,
  serializeJobPropertyExport,
} from "@/lib/job-property-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const access = await requireBusinessAccess();
  const url = new URL(request.url);
  const includePrivateCustomer = url.searchParams.get("includePrivateCustomer") === "1";
  const includePhotos = url.searchParams.get("includePhotos") === "1";

  try {
    const document = await buildCompletedJobPropertyExport(prisma, access, {
      jobId,
      includePrivateCustomer,
      includePhotos,
    });
    return new NextResponse(serializeJobPropertyExport(document), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${jobPropertyExportFilename(document)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof JobPropertyExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
