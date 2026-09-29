"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  JOB_LOCATION_FILTER_ALL,
  JOB_LOCATION_FILTER_UNASSIGNED,
  JOB_LOCATION_UNASSIGNED_LABEL,
} from "@/lib/job-location";

export function LocationFilterSelect({
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
      aria-label="Filter schedule by location"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("page");
        if (event.target.value === JOB_LOCATION_FILTER_ALL) {
          params.delete("location");
        } else {
          params.set("location", event.target.value);
        }
        const query = params.toString();
        router.push(`/jobs${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value={JOB_LOCATION_FILTER_ALL}>All locations</option>
      <option value={JOB_LOCATION_FILTER_UNASSIGNED}>{JOB_LOCATION_UNASSIGNED_LABEL}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
