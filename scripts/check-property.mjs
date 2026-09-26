/**
 * Customer property Directions action.
 *
 * Uses the existing canonical maps URL helper. Never geocodes or invents
 * coordinates. Edit stays. Missing address produces no Directions action.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-property.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { directionsUrl } = await import("@/lib/directions");
const { formatAddress } = await import("@/lib/format");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

const item = readRepo("src/components/properties/property-item.tsx");
const page = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const helper = readRepo("src/lib/directions.ts");

console.log("\nUNIT — Canonical directions helper");
const recorded = {
  addressLine1: "10 Main St",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
};
const href = directionsUrl(recorded);
check(
  "directionsUrl is built from the recorded address only",
  href ===
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(recorded))}` &&
    href.includes("10%20Main%20St"),
);
check("directionsUrl(null) returns null", directionsUrl(null) === null);
check(
  "empty recorded address produces no Directions href",
  directionsUrl({ addressLine1: "" }) === null,
);
check(
  "helper does not geocode or invent coordinates",
  !helper.includes("geocode") &&
    !helper.includes("latitude") &&
    !helper.includes("longitude") &&
    helper.includes("Do not require a paid Maps API"),
);

console.log("\nSTATIC — Property item Directions + Edit");
check(
  "Property item uses the canonical directions helper",
  item.includes('import { directionsUrl } from "@/lib/directions"') &&
    item.includes("const directionsHref = directionsUrl(property)") &&
    item.includes("<a href={directionsHref}"),
);
check(
  "Directions renders only when a recorded address produces a href",
  item.includes("{directionsHref ? (") &&
    item.includes("Directions") &&
    !item.includes("No address on file"),
);
check(
  "Directions opens the maps URL and Edit remains",
  item.includes('target="_blank"') &&
    item.includes("rel=\"noreferrer noopener\"") &&
    item.includes("onClick={() => setEditing(true)}") &&
    item.includes("Edit"),
);
check(
  "Property actions use phone tap targets",
  item.includes('const PHONE_ACTION_CLASS = "min-h-11 min-w-11 px-4"') &&
    item.includes("className={PHONE_ACTION_CLASS}"),
);
check(
  "Property item does not geocode or invent coordinates",
  !item.includes("geocode") &&
    !item.includes("latitude") &&
    !item.includes("longitude") &&
    !item.includes("navigator.geolocation"),
);
check(
  "Customer profile still renders PropertyItem from scoped customer properties",
  page.includes("<PropertyItem") &&
    page.includes("customer.properties.map") &&
    page.includes("where: { id: customerId, ...access.scope }"),
);

if (failed > 0) {
  console.error(`\nproperty check failed: ${failed} failure(s)`);
  process.exit(1);
}

console.log(`\nproperty check passed (${passed} checks)`);
