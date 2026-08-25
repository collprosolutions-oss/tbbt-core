export const DURATION_PRESETS = [
  { value: "30", minutes: 30, label: "30 minutes" },
  { value: "60", minutes: 60, label: "1 hour" },
  { value: "90", minutes: 90, label: "1.5 hours" },
  { value: "120", minutes: 120, label: "2 hours" },
  { value: "180", minutes: 180, label: "3 hours" },
  { value: "240", minutes: 240, label: "4 hours" },
  { value: "half", minutes: 240, label: "Half day" },
  { value: "full", minutes: 480, label: "Full day" },
] as const;

export function durationPresetForMinutes(minutes: number | null | undefined) {
  if (minutes == null) {
    return "";
  }
  const preset = DURATION_PRESETS.find((item) => item.minutes === minutes);
  if (preset && preset.value !== "half") {
    return preset.value;
  }
  return "custom";
}

export function parseDurationMinutes(
  preset: string,
  customHours: string,
): { ok: true; minutes: number | null } | { ok: false; error: string } {
  if (!preset) {
    return { ok: true, minutes: null };
  }

  if (preset === "custom") {
    const hours = Number(customHours);
    if (!customHours.trim() || Number.isNaN(hours) || hours <= 0 || hours > 24) {
      return {
        ok: false,
        error: "Enter a custom duration between 0 and 24 hours.",
      };
    }
    return { ok: true, minutes: Math.round(hours * 60) };
  }

  const match = DURATION_PRESETS.find((item) => item.value === preset);
  if (!match) {
    return { ok: false, error: "Choose a duration." };
  }
  return { ok: true, minutes: match.minutes };
}

export function parseScheduleStart(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const start = new Date(`${date}T${time}:00`);
  if (Number.isNaN(start.getTime())) {
    return null;
  }
  return start;
}

export function scheduleWindow(start: Date, durationMinutes: number | null) {
  const minutes = Math.max(durationMinutes ?? 0, 1);
  return {
    start,
    end: new Date(start.getTime() + minutes * 60 * 1000),
  };
}

export function schedulesOverlap(
  aStart: Date,
  aDuration: number | null,
  bStart: Date,
  bDuration: number | null,
) {
  const a = scheduleWindow(aStart, aDuration);
  const b = scheduleWindow(bStart, bDuration);
  return a.start < b.end && b.start < a.end;
}

export function formatDurationMinutes(minutes: number) {
  const preset = DURATION_PRESETS.find(
    (item) => item.minutes === minutes && item.value !== "half",
  );
  if (preset) {
    return preset.label;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (minutes < 60) {
    return `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hr ${rest} min`;
}

export function expectedEnd(start: Date, durationMinutes: number) {
  return new Date(start.getTime() + durationMinutes * 60 * 1000);
}
