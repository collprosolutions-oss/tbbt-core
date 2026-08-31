import type { ComponentType } from "react";
import {
  CalendarClock,
  Clock,
  CircleDollarSign,
  FileText,
  Inbox,
  LayoutDashboard,
  Receipt,
  Wallet,
  Settings,
  TrendingUp,
  UserCog,
  Users,
  Wrench,
} from "lucide-react";

/**
 * One icon per real nav destination, keyed by the same hrefs
 * visibleAppNav() (src/lib/nav.ts) already returns. Shared by AppShell's
 * sidebar/mobile drawer AND the Dashboard's KPI cards, so a destination's
 * icon is defined exactly once and always matches between "where you are
 * going" (nav) and "what this number is about" (a KPI card linking there).
 */
export const NAV_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "/dashboard": LayoutDashboard,
  "/requests": Inbox,
  "/customers": Users,
  "/estimates": FileText,
  "/jobs": CalendarClock,
  "/time-cards": Clock,
  "/payroll": CircleDollarSign,
  "/invoices": Receipt,
  "/expenses": Wallet,
  "/reports": TrendingUp,
  "/services": Wrench,
  "/team": UserCog,
  "/settings": Settings,
};
