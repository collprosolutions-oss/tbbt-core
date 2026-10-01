import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { OwnerDailyAttentionItem } from "@/lib/owner-daily-attention";

export function OwnerDailyAttentionList({
  title,
  items,
}: {
  title: string;
  items: readonly OwnerDailyAttentionItem[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
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
