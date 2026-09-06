export function IncludedWorkDisplay({
  includedWork,
  className,
}: {
  includedWork?: string | null;
  className?: string;
}) {
  const text = includedWork?.trim();
  if (!text) {
    return null;
  }

  return (
    <div className={className ?? "mt-1"}>
      <p className="text-xs font-medium text-muted-foreground">
        Scope / Included Work
      </p>
      <p className="whitespace-pre-line text-sm">{text}</p>
    </div>
  );
}
