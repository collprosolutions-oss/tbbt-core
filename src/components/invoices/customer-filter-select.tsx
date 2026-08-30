"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Real filter: options are this business's own customers who have at
 * least one invoice (see src/app/(app)/invoices/page.tsx). Mirrors the
 * same query-string-driven pattern already used on Estimates/Jobs.
 */
export function CustomerFilterSelect({
  value,
  options,
}: {
  value: string;
  options: { id: string; name: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <select
      aria-label="Filter by customer"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("page");
        if (event.target.value === "all") {
          params.delete("customer");
        } else {
          params.set("customer", event.target.value);
        }
        const query = params.toString();
        router.push(`/invoices${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value="all">All Customers</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
