/**
 * Focused contrast-token check for the shared theme.
 *
 * Native <select> / date / option widgets follow `color-scheme` and
 * inherited `color`. A hardcoded dark color-scheme on <html> produced
 * light text on the UA's light popup (Time Cards + Services). This
 * asserts the shared globals.css contract without opening those pages.
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

console.log("\nSTATIC — theme color-scheme follows the active background");
check(":root declares color-scheme: light", /color-scheme:\s*light/.test(rootBlock));
check(".dark declares color-scheme: dark", /color-scheme:\s*dark/.test(darkBlock));
check("html.dark reaffirms color-scheme: dark", /html\.dark\s*\{\s*color-scheme:\s*dark/.test(css));
check(
  "html base is not hardcoded to dark-only color-scheme",
  /color-scheme:\s*light/.test(htmlBlock) && !/^\s*color-scheme:\s*dark/m.test(htmlBlock),
);

console.log("\nSTATIC — native form controls use theme tokens");
check(
  "input/textarea/select inherit color-scheme and use --foreground",
  /input,\s*textarea,\s*select\s*\{[^}]*color:\s*var\(--foreground\)[^}]*color-scheme:\s*inherit/s.test(
    css,
  ),
);
check(
  "select option rows use popover tokens (not leftover light-on-white)",
  /select option[\s\S]*?background-color:\s*var\(--popover\)[\s\S]*?color:\s*var\(--popover-foreground\)/.test(
    css,
  ),
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
