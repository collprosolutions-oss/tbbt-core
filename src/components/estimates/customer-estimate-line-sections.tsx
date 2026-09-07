import {
  ESTIMATE_LABOR_SECTION_TITLE,
  ESTIMATE_MATERIALS_SECTION_TITLE,
  ESTIMATE_OTHER_SECTION_TITLE,
  type EstimateDocumentLine,
} from "@/lib/estimate-document";

export function CustomerEstimateLineSections({
  laborLines,
  materialLines,
  otherLines,
  appearance = "web",
  className,
}: {
  laborLines: EstimateDocumentLine[];
  materialLines: EstimateDocumentLine[];
  otherLines: EstimateDocumentLine[];
  appearance?: "web" | "print";
  className?: string;
}) {
  const print = appearance === "print";
  const heading = print
    ? "text-xs font-semibold tracking-wider text-neutral-500"
    : "text-xs font-semibold tracking-wider text-muted-foreground";
  const divider = print
    ? "mt-6 border-t-2 border-neutral-400 pt-6"
    : "mt-6 border-t-2 border-border pt-6";
  const muted = print ? "text-neutral-500" : "text-muted-foreground";
  const hairline = print ? "border-neutral-100" : "border-border/60";
  const scopeColor = print ? "text-neutral-600" : "text-muted-foreground";

  const blocks: Array<{ title: string; lines: EstimateDocumentLine[] }> = [];
  if (laborLines.length > 0) {
    blocks.push({ title: ESTIMATE_LABOR_SECTION_TITLE, lines: laborLines });
  }
  if (materialLines.length > 0) {
    blocks.push({
      title: ESTIMATE_MATERIALS_SECTION_TITLE,
      lines: materialLines,
    });
  }
  if (otherLines.length > 0) {
    blocks.push({ title: ESTIMATE_OTHER_SECTION_TITLE, lines: otherLines });
  }

  if (blocks.length === 0) {
    return (
      <section className={className}>
        <p className={`text-sm ${muted}`}>No line items.</p>
      </section>
    );
  }

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <section key={block.title} className={index > 0 ? divider : undefined}>
          <h3 className={heading}>{block.title}</h3>
          {block.title === ESTIMATE_MATERIALS_SECTION_TITLE ? (
            <CompactCustomerMaterialList
              lines={block.lines}
              appearance={appearance}
            />
          ) : (
            <table className="mt-3 w-full border-collapse text-sm">
              <thead>
                <tr className={`text-left text-xs tracking-wider ${muted}`}>
                  <th className="py-2 pr-3 font-semibold">Description</th>
                  <th className="py-2 px-3 text-right font-semibold">Qty</th>
                  <th className="py-2 px-3 text-right font-semibold">Rate</th>
                  <th className="py-2 pl-3 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {block.lines.map((line, lineIndex) => (
                  <tr
                    key={`${block.title}-${line.description}-${lineIndex}`}
                    className={`border-t ${hairline}`}
                  >
                    <td className="py-2.5 pr-3 align-top">
                      <div className={print ? undefined : "font-medium"}>
                        {line.description}
                      </div>
                      {line.includedWork ? (
                        <div
                          className={`mt-1 whitespace-pre-line text-xs ${scopeColor}`}
                        >
                          <div className="font-semibold tracking-wide">
                            Scope / Included Work
                          </div>
                          {line.includedWork}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2.5 px-3 text-right align-top tabular-nums">
                      {line.quantityLabel}
                    </td>
                    {line.showLinePricing ? (
                      <>
                        <td className="py-2.5 px-3 text-right align-top tabular-nums">
                          {line.unitPriceLabel}
                        </td>
                        <td
                          className={`py-2.5 pl-3 text-right align-top tabular-nums ${print ? "" : "font-medium"}`}
                        >
                          {line.amountLabel}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

function CompactCustomerMaterialList({
  lines,
  appearance,
}: {
  lines: EstimateDocumentLine[];
  appearance: "web" | "print";
}) {
  const leader =
    appearance === "print"
      ? "border-neutral-300"
      : "border-muted-foreground/40";

  return (
    <ul className="customer-materials-compact mt-1.5 text-sm leading-5">
      {lines.map((line, lineIndex) => (
        <li
          key={`${line.description}-${lineIndex}`}
          className="flex items-baseline gap-2 py-px"
        >
          <span className="min-w-0">{line.description}</span>
          <span
            aria-hidden
            className={`min-w-3 flex-1 translate-y-[-0.35em] border-b border-dotted ${leader}`}
          />
          <span className="shrink-0 tabular-nums">{line.quantityLabel}</span>
        </li>
      ))}
    </ul>
  );
}
