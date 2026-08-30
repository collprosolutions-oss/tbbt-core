"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Real filter: options are this business's own active catalog services
 * (the same list already used elsewhere, e.g. "Add catalog item" on an
 * estimate). Changing it re-navigates with `?service=<id>` so filtering
 * happens server-side (src/app/(app)/requests/page.tsx), matching the
 * app's existing query-string-driven pattern -- no client-side dataset,
 * no fabricated options.
 */
export function ServiceFilterSelect({
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
      aria-label="Filter by service"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        if (event.target.value === "all") {
          params.delete("service");
        } else {
          params.set("service", event.target.value);
        }
        const query = params.toString();
        router.push(`/requests${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-44 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value="all">All services</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
