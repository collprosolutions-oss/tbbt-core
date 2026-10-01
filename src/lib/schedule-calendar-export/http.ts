import { NextResponse } from "next/server";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  ScheduleCalendarExportError,
  buildScheduleCalendarExport,
  type ScheduleCalendarExportScope,
} from "@/lib/schedule-calendar-export";
import { prisma } from "@/lib/prisma";

export async function scheduleCalendarDownloadResponse(
  access: BusinessAccess,
  scope: ScheduleCalendarExportScope,
) {
  try {
    const document = await buildScheduleCalendarExport(prisma, access, { scope });
    return new NextResponse(document.ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${document.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof ScheduleCalendarExportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
