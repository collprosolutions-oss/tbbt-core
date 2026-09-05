export type WorkPerformedLine = {
  description: string;
  quantityLabel: string;
};

/**
 * Description + quantity list for invoice surfaces that do not need
 * per-service rates. The invoice document/PDF keep Rate and Amount.
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
            <span>{line.description}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              Qty {line.quantityLabel}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
