/**
 * Expected Duration presets for job scheduling.
 *
 * Multi-day projects must be schedulable without dropping the existing
 * shorter hour / half-day / full-day choices. No database access.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-job-schedule-duration.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CUSTOM_DURATION_MAX_HOURS,
  DURATION_PRESETS,
  WORK_DAY_MINUTES,
  durationPresetForMinutes,
  expectedEnd,
  formatDurationMinutes,
  parseDurationMinutes,
  scheduleWindow,
} = await import("@/lib/job-schedule");

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const form = readRepo("src/components/jobs/schedule-job-form.tsx");

console.log("\nSTATIC — Expected duration choices");

check("Full day remains 8 hours (480 minutes)", WORK_DAY_MINUTES === 480);
check("Custom duration accepts multi-day hour totals", CUSTOM_DURATION_MAX_HOURS === 240);

const values = DURATION_PRESETS.map((item) => item.value);
const labels = DURATION_PRESETS.map((item) => item.label);
const minutesByValue = Object.fromEntries(
  DURATION_PRESETS.map((item) => [item.value, item.minutes]),
);

for (const value of ["30", "60", "90", "120", "180", "240", "half", "full"]) {
  check(`Keeps existing shorter-duration choice ${value}`, values.includes(value));
}

check("Adds 1 day", values.includes("1d") && labels.includes("1 day"));
check("Adds 2 days", values.includes("2d") && minutesByValue["2d"] === 960);
check("Adds 3 days", values.includes("3d") && minutesByValue["3d"] === 1440);
check("Adds 4 days", values.includes("4d") && minutesByValue["4d"] === 1920);
check("Adds 5 days", values.includes("5d") && minutesByValue["5d"] === 2400);
check("1 day matches Full day minutes", minutesByValue["1d"] === WORK_DAY_MINUTES);
check("Half day still equals 4 hours", minutesByValue.half === 240);
check("Schedule form renders every preset plus Custom", form.includes("DURATION_PRESETS") && form.includes('value="custom"'));
check("Custom hours hint covers multi-day totals", form.includes("including multi-day jobs"));

console.log("\nUNIT — Parse / display / window");

check("30 minutes stays 30 minutes", parseDurationMinutes("30", "").ok && parseDurationMinutes("30", "").minutes === 30);
check("Full day stores 480 minutes", parseDurationMinutes("full", "").minutes === 480);
check("1 day stores 480 minutes", parseDurationMinutes("1d", "").minutes === 480);
check("2 days stores 960 minutes", parseDurationMinutes("2d", "").minutes === 960);
check("5 days stores 2400 minutes", parseDurationMinutes("5d", "").minutes === 2400);

const custom16 = parseDurationMinutes("custom", "16");
check("Custom 16 hours stores 960 minutes", custom16.ok && custom16.minutes === 960);
const custom240 = parseDurationMinutes("custom", "240");
check("Custom 240 hours is accepted", custom240.ok && custom240.minutes === 14400);
const custom241 = parseDurationMinutes("custom", "241");
check("Custom above the multi-day cap is rejected", custom241.ok === false);
const customEmpty = parseDurationMinutes("custom", "");
check("Empty custom hours is rejected", customEmpty.ok === false);

check("Existing 480-minute jobs still display as Full day", formatDurationMinutes(480) === "Full day");
check("Existing 240-minute jobs still display as 4 hours", formatDurationMinutes(240) === "4 hours");
check("960 minutes displays as 2 days", formatDurationMinutes(960) === "2 days");
check("1440 minutes displays as 3 days", formatDurationMinutes(1440) === "3 days");
check("1920 minutes displays as 4 days", formatDurationMinutes(1920) === "4 days");
check("2400 minutes displays as 5 days", formatDurationMinutes(2400) === "5 days");
check("480 minutes reloads as Full day, not the 1 day alias", durationPresetForMinutes(480) === "full");
check("240 minutes reloads as 4 hours, not Half day", durationPresetForMinutes(240) === "240");
check("960 minutes reloads as 2 days", durationPresetForMinutes(960) === "2d");
check("16 hours matches the 2-day preset", durationPresetForMinutes(16 * 60) === "2d");
check("Odd 7-hour duration reloads as Custom", durationPresetForMinutes(420) === "custom");

const start = new Date("2026-09-06T08:00:00");
const twoDay = scheduleWindow(start, 960);
check(
  "2-day window ends 16 hours later (960 minutes)",
  twoDay.end.getTime() === start.getTime() + 960 * 60 * 1000,
);
const fiveDayEnd = expectedEnd(start, 2400);
check(
  "5-day expected end is 2400 minutes after start",
  fiveDayEnd.getTime() === start.getTime() + 2400 * 60 * 1000,
);

console.log(
  failed === 0
    ? `\nAll job-schedule duration checks passed (${passed}).`
    : `\n${failed} job-schedule duration check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
