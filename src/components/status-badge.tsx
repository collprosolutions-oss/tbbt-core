import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  OPEN: "secondary",
  CONVERTED: "outline",
  DRAFT: "outline",
  SENT: "default",
  APPROVED: "secondary",
  UNSCHEDULED: "outline",
  SCHEDULED: "default",
  IN_PROGRESS: "default",
  COMPLETED: "secondary",
  PAID: "default",
  DECLINED: "destructive",
  CANCELLED: "outline",
  DISMISSED: "outline",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANTS[status] ?? "outline"}>{status}</Badge>;
}
