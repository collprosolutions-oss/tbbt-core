import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { RecordNavItem } from "@/lib/record-nav";
import { cn } from "@/lib/utils";

export function RecordNav({
  items = [],
  backHref,
  backLabel,
}: {
  items?: readonly RecordNavItem[];
  backHref?: string;
  backLabel?: string;
}) {
  if (items.length === 0 && !backHref) return null;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      {items.length > 0 ? (
        <nav
          aria-label="Related records"
          className="flex flex-wrap gap-2"
        >
          {items.map((item) =>
            item.current || !item.href ? (
              <span
                key={`${item.kind}:${item.id}`}
                aria-current={item.current ? "page" : undefined}
                className={cn(
                  "inline-flex h-7 items-center rounded-[min(var(--radius-md),12px)] border px-2.5 text-[0.8rem] font-medium",
                  item.current
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border bg-background text-muted-foreground",
                )}
              >
                {item.label}
              </span>
            ) : (
              <Button
                key={`${item.kind}:${item.id}`}
                asChild
                size="sm"
                variant="outline"
              >
                <Link href={item.href}>{item.label}</Link>
              </Button>
            ),
          )}
        </nav>
      ) : null}
      {backHref && backLabel ? (
        <Button asChild size="sm" variant="outline">
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}
