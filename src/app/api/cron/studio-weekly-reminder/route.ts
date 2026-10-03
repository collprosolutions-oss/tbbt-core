/**
 * Once-daily Vercel cron (Hobby-compatible). Sends the OWNER weekly
 * Marketing Studio reminder only when the business's local day is
 * Monday. Never invoked from a page render. Requires CRON_SECRET.
 *
 * Denied or failed runs log counts and machine reasons only. They never
 * log secrets, phone numbers, emails, customer names, or business ids.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  classifyStudioWeeklyReminderCronAuth,
  logStudioWeeklyReminderCron,
  runScheduledStudioWeeklyReminders,
  summarizeStudioWeeklyReminderCronRun,
} from "@/lib/marketing-studio-reminder";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = classifyStudioWeeklyReminderCronAuth(request.headers);
  if (!auth.ok) {
    logStudioWeeklyReminderCron({ ok: false, reason: auth.reason });
    return NextResponse.json({ ok: false, reason: auth.reason }, { status: 401 });
  }

  try {
    const results = await runScheduledStudioWeeklyReminders(prisma);
    const summary = summarizeStudioWeeklyReminderCronRun(results);
    logStudioWeeklyReminderCron({ ok: true, ...summary });
    return NextResponse.json({ ok: true, ...summary });
  } catch {
    logStudioWeeklyReminderCron({ ok: false, reason: "runner_failed" });
    return NextResponse.json({ ok: false, reason: "runner_failed" }, { status: 500 });
  }
}
