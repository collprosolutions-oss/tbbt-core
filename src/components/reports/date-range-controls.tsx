"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { DATE_PRESET_LABELS, DATE_PRESETS, type DatePreset } from "@/lib/reports";

export function DateRangeControls({
  preset,
  from,
  to,
}: {
  preset: DatePreset;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function push(next: { range?: DatePreset; from?: string; to?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    const nextPreset = next.range ?? preset;
    if (nextPreset === "month") params.delete("range");
    else params.set("range", nextPreset);
    const nextFrom = next.from ?? from;
    const nextTo = next.to ?? to;
    if (nextPreset === "custom" && nextFrom) params.set("from", nextFrom);
    else params.delete("from");
    if (nextPreset === "custom" && nextTo) params.set("to", nextTo);
    else params.delete("to");
    const query = params.toString();
    router.push(`/reports${query ? `?${query}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Report date range"
        value={preset}
        onChange={(event) => push({ range: event.target.value as DatePreset })}
        className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
      >
        {DATE_PRESETS.map((option) => (
          <option key={option} value={option}>
            {DATE_PRESET_LABELS[option]}
          </option>
        ))}
      </select>
      {preset === "custom" ? (
        <>
          <input
            type="date"
            aria-label="From date"
            value={from}
            onChange={(event) => push({ range: "custom", from: event.target.value, to })}
            className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm"
          />
          <input
            type="date"
            aria-label="To date"
            value={to}
            onChange={(event) => push({ range: "custom", from, to: event.target.value })}
            className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm"
          />
        </>
      ) : null}
    </div>
  );
}
