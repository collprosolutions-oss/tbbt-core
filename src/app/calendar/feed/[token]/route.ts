import { scheduleCalendarFeedResponse } from "@/lib/schedule-calendar-subscription/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return scheduleCalendarFeedResponse(token);
}
