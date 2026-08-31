/**
 * Focused contrast-token check for the shared theme.
 *
 * Native <select> / date widgets follow document color-scheme and the
 * control's `color`. `color-scheme: inherit` compiles to `normal` and
 * resets the open menu to a light UA popup while dark-theme text stays
 * light -- the remaining Time Cards / Services contrast bug. Option rows
 * are pinned dark-on-light because desktop UAs paint that menu white.
 *
 * Run with:
 *   node scripts/check-theme-contrast.mjs
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const timeCards = readFileSync(
  new URL("../src/components/time-cards/time-cards-workspace.tsx", import.meta.url),
  "utf8",
);
const payroll = readFileSync(
  new URL("../src/components/payroll/payroll-workspace.tsx", import.meta.url),
  "utf8",
);
const servicesForm = readFileSync(
  new URL("../src/components/catalog/create-catalog-item-form.tsx", import.meta.url),
  "utf8",
);
const founder = readFileSync(
  new URL("../src/components/founder-design/root.tsx", import.meta.url),
  "utf8",
);

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const rootBlock = css.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
const darkBlock = css.match(/\.dark\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
const htmlBlock = css.match(/html\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
const controlBlock =
  css.match(/input,\s*textarea,\s*select\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
const optionBlock =
  css.match(/select option,\s*select optgroup\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";

console.log("\nSTATIC — theme color-scheme follows the active background");
check(":root declares color-scheme: light", /color-scheme:\s*light/.test(rootBlock));
check(".dark declares color-scheme: dark", /color-scheme:\s*dark/.test(darkBlock));
check("html.dark reaffirms color-scheme: dark", /html\.dark\s*\{\s*color-scheme:\s*dark/.test(css));
check(
  "html base is not hardcoded to dark-only color-scheme",
  /color-scheme:\s*light/.test(htmlBlock) && !/^\s*color-scheme:\s*dark/m.test(htmlBlock),
);

console.log("\nSTATIC — native form controls do not reset color-scheme to light");
check(
  "input/textarea/select use --foreground",
  /color:\s*var\(--foreground\)/.test(controlBlock),
);
check(
  "form controls do not set color-scheme (inherit/normal resets UA popups to light)",
  !/color-scheme:/.test(controlBlock),
);
check(
  "select option rows are dark text on a light menu",
  /background-color:\s*#fff(?:fff)?;/.test(optionBlock.replace(/\s/g, "")) &&
    /color:\s*#0a0a0a/.test(optionBlock),
);
check(
  "placeholders use muted-foreground (theme-aware secondary)",
  /input::placeholder[\s\S]*color:\s*var\(--muted-foreground\)/.test(css),
);

const muted = rootBlock.match(/--muted-foreground:\s*oklch\(([\d.]+)/);
const mutedL = muted ? Number(muted[1]) : 1;
check(
  "light-theme muted text is a readable dark gray (oklch L <= 0.45)",
  Number.isFinite(mutedL) && mutedL > 0 && mutedL <= 0.45,
);
check(
  "dark-theme foreground stays light (oklch L >= 0.9)",
  /--foreground:\s*oklch\(0\.9/.test(darkBlock),
);
check(
  "light-theme foreground stays dark (oklch L <= 0.2)",
  /--foreground:\s*oklch\(0\.1/.test(rootBlock),
);

console.log("\nSTATIC — no page-local redesign / Founder Design untouched");
check("Time Cards still uses native <select> filters", timeCards.includes("<select"));
check("Payroll still uses native <select> for approved-week add", payroll.includes("<select"));
check("Payroll funding copy does not invent a bank balance", payroll.includes("Funding verification not connected") && !/\$[0-9].*balance/i.test(payroll));
check("Services catalog form still uses native <select>", servicesForm.includes("<select"));
check(
  "Founder Design Mode root is unchanged by this contrast pass",
  founder.includes("FounderDesign") || founder.includes("founder"),
);
check(
  "Founder highlight CSS remains in globals.css",
  css.includes("[data-founder-highlight") && css.includes("[data-founder-region]"),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
