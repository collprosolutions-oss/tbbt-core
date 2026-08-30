import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type RecordRowProps = {
  /** Primary line -- usually a name plus an inline StatusBadge/chip. */
  title: ReactNode;
  /** Secondary inline chips row (status, amount, date) under the title. */
  meta?: ReactNode;
  /** A single line of supporting text below meta (address, email, etc.). */
  subtitle?: ReactNode;
  /** Trailing content -- typically an "Open" button. */
  action?: ReactNode;
  className?: string;
};

/**
 * The shared "one record, one row" primitive: a name/title, optional
 * status + amount + date chips, an optional supporting line, and a
 * trailing action. Used anywhere a page lists related records inline
 * instead of as full Cards -- e.g. a Customer's own Requests/Estimates/
 * Jobs/Invoices, or a Team roster -- so that pattern is defined once
 * instead of as slightly different ad hoc flex rows per page.
 */
export function RecordRow({ title, meta, subtitle, action, className }: RecordRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/40 p-3 text-sm",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 font-medium">{title}</div>
        {meta ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {meta}
          </div>
        ) : null}
        {subtitle ? (
          <p className="truncate text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
