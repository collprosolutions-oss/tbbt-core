"use client";

import { useRouter, useSearchParams } from "next/navigation";

const OPTIONS = [10, 25, 50] as const;

/** Real pagination control -- sets `pageSize` and resets to page 1. */
export function PageSizeSelect({ value }: { value: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <select
      aria-label="Rows per page"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("pageSize", event.target.value);
        params.delete("page");
        router.push(`/invoices?${params.toString()}`);
      }}
      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
    >
      {OPTIONS.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
