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
  RUNNING: "default",
  READY: "success",
  NEEDS_REVIEW: "warning",
  READY_FOR_REVIEW: "default",
  REVIEWED: "success",
  AUTHORIZED: "success",
  PROCESSED: "success",
  NEEDS_ATTENTION: "warning",
  RECORDED: "outline",
  FLAGGED: "warning",
  PENDING: "warning",
  REIMBURSED: "success",
  NONE: "outline",
  PRIVATE: "outline",
};

const LABELS: Record<string, string> = {
  RUNNING: "Working",
  READY: "Ready",
  NEEDS_REVIEW: "Review",
  READY_FOR_REVIEW: "Ready for Review",
  REVIEWED: "Reviewed",
  AUTHORIZED: "Authorized",
  PROCESSED: "Processed",
  NEEDS_ATTENTION: "Needs Attention",
  MANUAL_EXTERNAL: "Processed externally",
  RECORDED: "Recorded",
  FLAGGED: "Flagged",
  PENDING: "Pending",
  REIMBURSED: "Reimbursed",
  NONE: "No",
  PRIVATE: "Private",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANTS[status] ?? "outline"}>{LABELS[status] ?? status}</Badge>;
}
