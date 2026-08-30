/**
 * Founder Design Mode -- curated icon IDs and a small accessible color
 * palette. Icons are a closed allow-list of lucide-react glyphs already
 * used in this repo (nav + approved operating pages). No marketplace,
 * no uploads, no extra icon package.
 */
import type { ComponentType } from "react";
import {
  AlertTriangle,
  Briefcase,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarX2,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Clock,
  DollarSign,
  FileText,
  Inbox,
  LayoutDashboard,
  Plus,
  Receipt,
  Send,
  Sparkles,
  Timer,
  TrendingUp,
  UserPlus,
  Users,
  Wrench,
} from "lucide-react";

export const CURATED_ICON_IDS = [
  "inbox",
  "file-text",
  "calendar-clock",
  "calendar-days",
  "calendar-check",
  "calendar-x",
  "receipt",
  "users",
  "wrench",
  "sparkles",
  "check-circle",
  "send",
  "dollar-sign",
  "circle-dollar",
  "briefcase",
  "timer",
  "trending-up",
  "layout-dashboard",
  "alert-triangle",
  "clipboard-list",
  "user-plus",
  "plus",
  "clock",
] as const;
export type CuratedIconId = (typeof CURATED_ICON_IDS)[number];

export function isCuratedIconId(value: string): value is CuratedIconId {
  return (CURATED_ICON_IDS as readonly string[]).includes(value);
}

export const CURATED_ICON_LABELS: Record<CuratedIconId, string> = {
  inbox: "Inbox",
  "file-text": "Document",
  "calendar-clock": "Calendar clock",
  "calendar-days": "Calendar",
  "calendar-check": "Calendar check",
  "calendar-x": "Calendar cancel",
  receipt: "Receipt",
  users: "Users",
  wrench: "Wrench",
  sparkles: "Sparkles",
  "check-circle": "Check",
  send: "Send",
  "dollar-sign": "Dollar",
  "circle-dollar": "Dollar circle",
  briefcase: "Briefcase",
  timer: "Timer",
  "trending-up": "Trending up",
  "layout-dashboard": "Dashboard",
  "alert-triangle": "Alert",
  "clipboard-list": "Clipboard",
  "user-plus": "Add user",
  plus: "Plus",
  clock: "Clock",
};

export const CURATED_ICONS: Record<CuratedIconId, ComponentType<{ className?: string }>> = {
  inbox: Inbox,
  "file-text": FileText,
  "calendar-clock": CalendarClock,
  "calendar-days": CalendarDays,
  "calendar-check": CalendarCheck,
  "calendar-x": CalendarX2,
  receipt: Receipt,
  users: Users,
  wrench: Wrench,
  sparkles: Sparkles,
  "check-circle": CheckCircle2,
  send: Send,
  "dollar-sign": DollarSign,
  "circle-dollar": CircleDollarSign,
  briefcase: Briefcase,
  timer: Timer,
  "trending-up": TrendingUp,
  "layout-dashboard": LayoutDashboard,
  "alert-triangle": AlertTriangle,
  "clipboard-list": ClipboardList,
  "user-plus": UserPlus,
  plus: Plus,
  clock: Clock,
};

export const ICON_COLORS = ["default", "blue", "green", "orange", "purple", "gold", "red", "gray"] as const;
export type IconColorToken = (typeof ICON_COLORS)[number];

export function isIconColorToken(value: string): value is IconColorToken {
  return (ICON_COLORS as readonly string[]).includes(value);
}

export const ICON_COLOR_LABELS: Record<IconColorToken, string> = {
  default: "Default",
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  purple: "Purple",
  gold: "Yellow / Gold",
  red: "Red",
  gray: "Gray",
};

/**
 * Accessible icon+tint pairs (dark-mode aware). "default" is omitted so
 * the component's own approved treatment (primary, muted, or the page's
 * existing accent) stays in place until the founder picks a color.
 */
export const ICON_COLOR_CLASSES: Record<Exclude<IconColorToken, "default">, string> = {
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  purple: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  gold: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  red: "bg-red-500/15 text-red-700 dark:text-red-400",
  gray: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400",
};

export const ICON_COLOR_FG_CLASSES: Record<Exclude<IconColorToken, "default">, string> = {
  blue: "text-blue-700 dark:text-blue-400",
  green: "text-emerald-700 dark:text-emerald-400",
  orange: "text-orange-700 dark:text-orange-400",
  purple: "text-violet-700 dark:text-violet-400",
  gold: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
  gray: "text-zinc-600 dark:text-zinc-400",
};

export function iconTintClass(color: IconColorToken | undefined): string | undefined {
  if (!color || color === "default") return undefined;
  return ICON_COLOR_CLASSES[color];
}

export function iconForegroundClass(color: IconColorToken | undefined): string | undefined {
  if (!color || color === "default") return undefined;
  return ICON_COLOR_FG_CLASSES[color];
}
