import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  OWNER_DAILY_MORE_NOT_SHOWN,
  OWNER_DAILY_SCAN_LIMIT_REACHED,
  ownerDailyTruncationLabel,
  type OwnerDailyAttentionItem,
} from "@/lib/owner-daily-attention";

export function OwnerDailyAttentionList({
  title,
  items,
  count,
  moreNotShown,
  scanLimited,
  truncationLabel,
}: {
  title: string;
  items: readonly OwnerDailyAttentionItem[];
  count?: number;
  moreNotShown?: boolean;
  scanLimited?: boolean;
  truncationLabel?: string | null;
}) {
  const shown = items.length;
  const total = count ?? shown;
  const truncated = Boolean(moreNotShown) || Boolean(scanLimited) || total > shown;
  if (total <= 0 && shown === 0 && !truncated) return null;
  const label =
    truncationLabel ??
    ownerDailyTruncationLabel(total, shown, truncated);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {title}
        {label ? (
          <span className="ml-1.5 text-muted-foreground">({label})</span>
        ) : null}
      </p>
      {scanLimited || (truncated && shown === 0) ? (
        <p className="text-xs text-muted-foreground">
          {OWNER_DAILY_SCAN_LIMIT_REACHED}
        </p>
      ) : null}
      {truncated ? (
        <p className="text-xs text-muted-foreground">{OWNER_DAILY_MORE_NOT_SHOWN}</p>
      ) : null}
      {items.map((item) => (
        <div
          key={item.key}
          className="flex flex-wrap items-start justify-between gap-2 rounded-xl border p-3"
        >
          <div className="min-w-0">
            <p className="font-medium">{item.name}</p>
            {item.meta ? (
              <p className="text-sm text-muted-foreground">{item.meta}</p>
            ) : null}
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={item.href}>{item.action}</Link>
          </Button>
        </div>
      ))}
    </div>
  );
}
