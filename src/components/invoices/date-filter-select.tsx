"use client";

import { useRouter, useSearchParams } from "next/navigation";

const OPTIONS = [
  { value: "all", label: "All Dates" },
  { value: "30d", label: "Last 30 Days" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
] as const;

/** Real filter on Invoice.createdAt -- no fabricated due-date field. */
export function DateFilterSelect({ value }: { value: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <select
      aria-label="Filter by date"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("page");
        if (event.target.value === "all") {
          params.delete("range");
        } else {
          params.set("range", event.target.value);
        }
        const query = params.toString();
        router.push(`/invoices${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-36 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      {OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
