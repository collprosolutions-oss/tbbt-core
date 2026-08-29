import { Badge, type badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/**
 * One status -> one color, everywhere. This is the single lookup every
 * StatusBadge use across the app shares, so a status always reads the same
 * way whether it's on the Dashboard, a list card, or a record detail page.
 */
const VARIANTS: Record<string, BadgeVariant> = {
  OPEN: "secondary",
  CONVERTED: "outline",
  DRAFT: "outline",
  SENT: "default",
  APPROVED: "success",
  UNSCHEDULED: "warning",
  SCHEDULED: "default",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
  PAID: "success",
  DECLINED: "destructive",
  CANCELLED: "outline",
  DISMISSED: "outline",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANTS[status] ?? "outline"}>{status}</Badge>;
}
