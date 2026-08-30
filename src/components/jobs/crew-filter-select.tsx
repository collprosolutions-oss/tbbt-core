"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Real filter: options are this business's own active MEMBER-role
 * memberships (the exact same eligible-assignee list already used by
 * AssignJobMemberForm on the Work Order page) -- not a fabricated crew
 * roster. "Unassigned" is a real, structural Job state (see
 * Job.assignedMembershipId in prisma/schema.prisma), not a placeholder.
 */
export function CrewFilterSelect({
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
      aria-label="Filter by crew/assignee"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("page");
        if (event.target.value === "all") {
          params.delete("crew");
        } else {
          params.set("crew", event.target.value);
        }
        const query = params.toString();
        router.push(`/jobs${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value="all">All Crew</option>
      <option value="unassigned">Unassigned</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
