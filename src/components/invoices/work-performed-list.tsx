import { lineItemIncludedWork, lineItemTitle } from "@/lib/estimate-line-scope";

export type WorkPerformedLine = {
  description: string;
  includedWork?: string | null;
  quantityLabel: string;
};

/**
 * Description + quantity list for owner invoice surfaces that do not
 * need per-service rates. The customer invoice document/PDF show labor
 * rates and a single Materials lump sum — never raw material unit prices.
 */
export function WorkPerformedList({
  lines,
}: {
  lines: readonly WorkPerformedLine[];
}) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">
        WORK PERFORMED
      </h3>
      <ul className="space-y-1.5 text-sm">
        {lines.map((line, index) => (
          <li
            key={`${line.description}-${index}`}
            className="flex justify-between gap-4"
          >
            <span className="min-w-0">
              <span>{lineItemTitle(line.description)}</span>
              {line.includedWork || lineItemIncludedWork(line.description) ? (
                <span className="mt-1 block whitespace-pre-line text-xs text-muted-foreground">
                  {line.includedWork || lineItemIncludedWork(line.description)}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              Qty {line.quantityLabel}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
