import { NextResponse } from "next/server";
import { ForbiddenError } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { SCHEDULE_CALENDAR_FEED_CACHE_CONTROL } from "@/lib/schedule-calendar-subscription/contract";
import { readScheduleCalendarFeed } from "@/lib/schedule-calendar-subscription/feed";
import { ScheduleCalendarSubscriptionError } from "@/lib/schedule-calendar-subscription/ops";

export const SCHEDULE_CALENDAR_FEED_HEADERS = {
  "Content-Type": "text/calendar; charset=utf-8",
  "Cache-Control": SCHEDULE_CALENDAR_FEED_CACHE_CONTROL,
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function feedNotFoundResponse() {
  return new NextResponse("Not found.", {
    status: 404,
    headers: {
      "Cache-Control": SCHEDULE_CALENDAR_FEED_CACHE_CONTROL,
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

export async function scheduleCalendarFeedResponse(rawToken: string) {
  try {
    const document = await readScheduleCalendarFeed(prisma, rawToken);
    return new NextResponse(document.ics, {
      status: 200,
      headers: {
        ...SCHEDULE_CALENDAR_FEED_HEADERS,
        "Content-Disposition": `inline; filename="${document.filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return feedNotFoundResponse();
    }
    if (error instanceof ScheduleCalendarSubscriptionError) {
      return feedNotFoundResponse();
    }
    throw error;
  }
}
