import { requireBusinessAccess } from "@/lib/access";
import { scheduleCalendarDownloadResponse } from "@/lib/schedule-calendar-export/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireBusinessAccess();
  return scheduleCalendarDownloadResponse(access, "assigned");
}
