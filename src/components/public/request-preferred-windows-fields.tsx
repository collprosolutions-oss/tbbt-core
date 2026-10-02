"use client";

import { Label } from "@/components/ui/label";
import {
  MAX_REQUEST_PREFERRED_WINDOWS,
  PREFERRED_WINDOWS_NOT_A_BOOKING,
  type PreferredWindowDraft,
} from "@/lib/request-preferred-windows";

export function RequestPreferredWindowsFields({
  value,
  onChange,
}: {
  value: PreferredWindowDraft[];
  onChange: (next: PreferredWindowDraft[]) => void;
}) {
  function update(index: number, patch: Partial<PreferredWindowDraft>) {
    onChange(value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Preferred days or times (optional)</legend>
      <p className="text-sm text-muted-foreground">{PREFERRED_WINDOWS_NOT_A_BOOKING}</p>
      <p className="text-xs text-muted-foreground">
        Add up to {MAX_REQUEST_PREFERRED_WINDOWS} preferred days or time windows. The owner
        still reviews and schedules the visit.
      </p>
      {value.map((row, index) => (
        <div key={`pref-${index}`} className="space-y-2 rounded-lg border border-input bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Preference {index + 1}</p>
            <button
              type="button"
              className="text-sm font-semibold text-[var(--public-blue)]"
              onClick={() => onChange(value.filter((_, rowIndex) => rowIndex !== index))}
            >
              Remove
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`preferred-kind-${index}`}>Type</Label>
              <select
                id={`preferred-kind-${index}`}
                value={row.kind}
                onChange={(event) =>
                  update(index, {
                    kind: event.target.value === "WINDOW" ? "WINDOW" : "DAY",
                    startLocal: event.target.value === "WINDOW" ? row.startLocal : "",
                    endLocal: event.target.value === "WINDOW" ? row.endLocal : "",
                  })
                }
                className="h-12 w-full rounded-lg border border-input bg-white px-3 text-base"
              >
                <option value="DAY">Preferred day</option>
                <option value="WINDOW">Time window</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`preferred-date-${index}`}>Date</Label>
              <input
                id={`preferred-date-${index}`}
                type="date"
                value={row.localDate}
                onChange={(event) => update(index, { localDate: event.target.value })}
                className="h-12 w-full rounded-lg border border-input bg-white px-3 text-base"
                required
              />
            </div>
          </div>
          {row.kind === "WINDOW" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`preferred-start-${index}`}>Start</Label>
                <input
                  id={`preferred-start-${index}`}
                  type="time"
                  value={row.startLocal ?? ""}
                  onChange={(event) => update(index, { startLocal: event.target.value })}
                  className="h-12 w-full rounded-lg border border-input bg-white px-3 text-base"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`preferred-end-${index}`}>End</Label>
                <input
                  id={`preferred-end-${index}`}
                  type="time"
                  value={row.endLocal ?? ""}
                  onChange={(event) => update(index, { endLocal: event.target.value })}
                  className="h-12 w-full rounded-lg border border-input bg-white px-3 text-base"
                  required
                />
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {value.length < MAX_REQUEST_PREFERRED_WINDOWS ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="public-btn public-btn-outline"
            onClick={() =>
              onChange([...value, { kind: "DAY", localDate: "", startLocal: "", endLocal: "" }])
            }
          >
            Add a preferred day
          </button>
          <button
            type="button"
            className="public-btn public-btn-outline"
            onClick={() =>
              onChange([
                ...value,
                { kind: "WINDOW", localDate: "", startLocal: "", endLocal: "" },
              ])
            }
          >
            Add a time window
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}
