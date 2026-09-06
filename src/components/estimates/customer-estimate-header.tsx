/**
 * Customer-facing estimate identity header.
 *
 * Receives a resolved logo URL and business name from the page. It must
 * never look up a tenant by slug — that mapping stays in
 * src/lib/business-branding.ts.
 */
import { StatusBadge } from "@/components/status-badge";

export function CustomerEstimateHeader({
  businessName,
  logoSrc,
  status,
  totalLabel,
}: {
  businessName: string;
  logoSrc: string | null;
  status: string;
  totalLabel: string;
}) {
  return (
    <header className="rounded-xl border bg-card px-4 py-4 shadow-sm ring-1 ring-foreground/10 md:px-6 md:py-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 md:gap-5">
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoSrc}
              alt={`${businessName} logo`}
              width={220}
              height={220}
              className="h-10 w-auto shrink-0 object-contain sm:h-12 md:h-16 lg:h-20"
            />
          ) : null}
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">
              {businessName}
            </p>
            <p className="mt-0.5 text-xs font-semibold tracking-[0.18em] text-muted-foreground">
              ESTIMATE
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <StatusBadge status={status} />
          <p className="text-xl font-semibold tracking-tight md:text-2xl">
            {totalLabel}
          </p>
        </div>
      </div>
    </header>
  );
}
