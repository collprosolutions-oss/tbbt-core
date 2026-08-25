import type { ReactNode } from "react";

export function ServiceCategoryGroup({
  category,
  count,
  children,
}: {
  category: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        {category} ({count})
      </summary>
      <div className="space-y-3 border-t px-4 py-3">{children}</div>
    </details>
  );
}
