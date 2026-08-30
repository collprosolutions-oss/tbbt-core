"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Real filter: options are this business's own active catalog services
 * (same list already used by src/components/requests/service-filter-select.tsx
 * and the estimate builder's "Add catalog item" picker). Only estimates
 * that trace back to a service request with a selected catalog item can
 * match this filter -- manual estimates and "Other / not sure" requests
 * simply won't match any option, which is truthful rather than fabricated.
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
        params.delete("page");
        if (event.target.value === "all") {
          params.delete("service");
        } else {
          params.set("service", event.target.value);
        }
        const query = params.toString();
        router.push(`/estimates${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value="all">All Services</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
