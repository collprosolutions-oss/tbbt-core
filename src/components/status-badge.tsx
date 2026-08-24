import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<
  string,
  "default" | "secondary" | "outline"
> = {
  OPEN: "secondary",
  DRAFT: "outline",
  APPROVED: "secondary",
  UNSCHEDULED: "outline",
  SCHEDULED: "default",
  COMPLETED: "secondary",
  PAID: "default",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANTS[status] ?? "outline"}>{status}</Badge>;
}
