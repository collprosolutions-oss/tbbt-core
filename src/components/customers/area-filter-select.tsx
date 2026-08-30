"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Real filter: options are the distinct property cities already on file
 * for this business's own customers (see src/app/(app)/customers/page.tsx)
 * -- not a separate "service area" concept the schema doesn't have.
 * Mirrors src/components/requests/service-filter-select.tsx's exact
 * query-string-driven pattern.
 */
export function AreaFilterSelect({
  value,
  options,
}: {
  value: string;
  options: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <select
      aria-label="Filter by service area"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("page");
        if (event.target.value === "all") {
          params.delete("area");
        } else {
          params.set("area", event.target.value);
        }
        const query = params.toString();
        router.push(`/customers${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value="all">All Service Areas</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
