/**
 * Hourly Vercel cron. Sends the OWNER weekly Marketing Studio reminder
 * only during each business's local Monday 09:00–17:00 window. Never
 * invoked from a page render. Requires CRON_SECRET.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authorizeStudioWeeklyReminderCron,
  runScheduledStudioWeeklyReminders,
} from "@/lib/marketing-studio-reminder";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!authorizeStudioWeeklyReminderCron(request.headers)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const results = await runScheduledStudioWeeklyReminders(prisma);
  const sent = results.filter((row) => row.reminder?.smsSendClaimedAt).length;
  return NextResponse.json({
    ok: true,
    considered: results.length,
    claimed: sent,
  });
}
