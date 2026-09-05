/**
 * Customer Project Portal identity header.
 *
 * Receives a resolved logo URL and business name from the page. It must
 * never look up a tenant by slug — that mapping stays in
 * src/lib/business-branding.ts.
 */
export function ProjectPortalHeader({
  businessName,
  logoSrc,
  customerName,
  address,
}: {
  businessName: string;
  logoSrc: string | null;
  customerName?: string | null;
  address?: string | null;
}) {
  const who = customerName?.trim() ? `For ${customerName.trim()}.` : "";
  const where = address?.trim() ?? "";
  const detail = [who, where].filter(Boolean).join(" ");

  return (
    <header className="rounded-xl border bg-card px-4 py-4 shadow-sm ring-1 ring-foreground/10 md:px-6 md:py-5">
      <div className="flex items-center gap-3 md:gap-5">
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoSrc}
            alt={`${businessName} logo`}
            width={220}
            height={220}
            className="h-12 w-auto shrink-0 object-contain md:h-16 lg:h-20"
          />
        ) : null}
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">
            {businessName}
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight md:text-2xl">
            Your Project
          </h1>
          {detail ? (
            <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
          ) : null}
        </div>
      </div>
    </header>
  );
}
