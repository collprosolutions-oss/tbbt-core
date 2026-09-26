/**
 * Focused mobile/desktop selected-id regression for the Requests workspace.
 *
 * Imports the production resolver from src/lib/request-list-selection.ts
 * (not a copied local implementation) and statically checks the workspace
 * wires viewport, table vs card selection, and URL-param continuity.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-requests-mobile-selected.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  REQUESTS_DESKTOP_DETAILS_QUERY,
  REQUESTS_MOBILE_SHEET_QUERY,
  requestMobileSheetShouldOpen,
  resolveInitialRequestSelection,
} = await import("@/lib/request-list-selection");

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${label}`);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const workspaceSrc = readRepo("src/components/requests/requests-workspace.tsx");
const pageSrc = readRepo("src/app/(app)/requests/page.tsx");
const sheetSrc = readRepo("src/components/ui/sheet.tsx");
const selectionSrc = readRepo("src/lib/request-list-selection.ts");
const packageSrc = readRepo("package.json");
const mobileListStart = workspaceSrc.indexOf("function RequestsMobileList");
const mobileListEnd = workspaceSrc.indexOf("function DetailField");
const mobileListSrc = workspaceSrc.slice(mobileListStart, mobileListEnd);
const detailsStart = workspaceSrc.indexOf("function RequestDetailsPanel");
const detailsSrc = workspaceSrc.slice(detailsStart);
const workspaceFnStart = workspaceSrc.indexOf("export function RequestsWorkspace");
const workspaceFnSrc = workspaceSrc.slice(workspaceFnStart, mobileListStart);

console.log("\nSTATIC — Production resolver is the source of truth");
check(
  "Workspace imports resolveInitialRequestSelection from the production helper",
  workspaceSrc.includes('from "@/lib/request-list-selection"') &&
    workspaceSrc.includes("resolveInitialRequestSelection") &&
    workspaceSrc.includes("requestMobileSheetShouldOpen"),
);
check(
  "Production resolver matches only the already-loaded request set",
  selectionSrc.includes("requests.some((request) => request.id === initialSelectedId)") &&
    selectionSrc.includes("never invent a request"),
);
check(
  "package.json does not add a requests-mobile-selected npm script",
  !packageSrc.includes("test:requests-mobile-selected"),
);

console.log("\nSTATIC — Mobile cards show the recorded property label");
check(
  "RequestsMobileList renders propertyLabel when it is recorded",
  mobileListSrc.includes("{request.propertyLabel ? (") &&
    mobileListSrc.includes("{request.propertyLabel}") &&
    mobileListSrc.includes("truncate text-xs text-muted-foreground"),
);
check(
  "Missing property labels stay omitted on the card (no fake address)",
  mobileListSrc.includes("{request.propertyLabel ? (") &&
    !mobileListSrc.includes('"None on file"'),
);
check(
  "This lane did not add a second property formatter or address fetch",
  !workspaceSrc.includes("formatAddress") &&
    !workspaceSrc.includes("prisma") &&
    workspaceSrc.includes("propertyLabel: string | null"),
);

console.log("\nSTATIC — Desktop sheet overlay cannot open from ?selected=");
check(
  "Shared Sheet overlay still portals independently of SheetContent className",
  sheetSrc.includes("<SheetOverlay />") &&
    sheetSrc.includes("SheetPortal") &&
    workspaceSrc.includes("SheetOverlay portals independently"),
);
check(
  "mobileOpen starts closed so SSR/desktop never mount the overlay",
  workspaceFnSrc.includes("useState(false)") &&
    !workspaceFnSrc.includes("useState(initialSelection.openMobileSheet)") &&
    !workspaceFnSrc.includes("useState(true)"),
);
check(
  "Desktop details stay on the lg panel; sheet open is gated by the lg query",
  workspaceSrc.includes('id="details" className="hidden lg:block"') &&
    workspaceSrc.includes("REQUESTS_MOBILE_SHEET_QUERY") &&
    selectionSrc.includes(REQUESTS_MOBILE_SHEET_QUERY) &&
    selectionSrc.includes(REQUESTS_DESKTOP_DETAILS_QUERY),
);
check(
  "Desktop table row selection does not open the mobile Sheet",
  workspaceFnSrc.includes("function selectDesktopRow") &&
    workspaceFnSrc.includes("onSelect={selectDesktopRow}") &&
    !/function selectDesktopRow\([^)]*\) \{\s*setSelectedId\(id\);\s*setMobileOpen\(true\);/s.test(
      workspaceFnSrc,
    ),
);
check(
  "Mobile card tap opens the Sheet through a separate callback",
  workspaceFnSrc.includes("function selectMobileCard") &&
    workspaceFnSrc.includes("onSelect={selectMobileCard}") &&
    workspaceFnSrc.includes("setMobileOpen(true)") &&
    !workspaceFnSrc.includes("function selectRequest"),
);
check(
  "initialSelectedId changes are applied after mount (A → B navigation)",
  workspaceFnSrc.includes("appliedSelectedParam") &&
    workspaceFnSrc.includes("[initialSelectedId, requests]") &&
    workspaceFnSrc.includes("setSelectedId(matchedSelectedId)"),
);

console.log("\nUNIT — Production resolver: owned / foreign / missing");
const loaded = [{ id: "req_owned_1" }, { id: "req_owned_2" }];
const match = resolveInitialRequestSelection(loaded, "req_owned_2");
check(
  "Matching tenant-scoped ID selects that record",
  match.selectedId === "req_owned_2" && match.matchedSelectedId === "req_owned_2",
);
check(
  "Mobile valid selected ID opens the bottom Sheet",
  requestMobileSheetShouldOpen(match.matchedSelectedId, false) === true,
);
check(
  "Desktop valid selected ID keeps the Sheet closed (no overlay / focus trap)",
  requestMobileSheetShouldOpen(match.matchedSelectedId, true) === false,
);
const missing = resolveInitialRequestSelection(loaded, "req_missing");
check(
  "Missing selected ID does not invent a row",
  missing.selectedId === "req_owned_1" && missing.matchedSelectedId === null,
);
check(
  "Missing selected ID never opens the Sheet",
  requestMobileSheetShouldOpen(missing.matchedSelectedId, false) === false &&
    requestMobileSheetShouldOpen(missing.matchedSelectedId, true) === false,
);
const foreign = resolveInitialRequestSelection(loaded, "req_foreign_tenant");
check(
  "Foreign selected ID is treated as absent (loaded set only)",
  foreign.selectedId === "req_owned_1" && foreign.matchedSelectedId === null,
);
const emptyMatch = resolveInitialRequestSelection([], "req_owned_1");
check(
  "Selected ID against an empty loaded set stays closed and invents nothing",
  emptyMatch.selectedId === null &&
    emptyMatch.matchedSelectedId === null &&
    requestMobileSheetShouldOpen(emptyMatch.matchedSelectedId, false) === false,
);
const noParam = resolveInitialRequestSelection(loaded, undefined);
check(
  "No selected param keeps the first-row highlight and leaves the Sheet closed",
  noParam.selectedId === "req_owned_1" &&
    noParam.matchedSelectedId === null &&
    requestMobileSheetShouldOpen(noParam.matchedSelectedId, false) === false,
);

console.log("\nUNIT — URL selected ID A → B uses the production resolver");
const fromA = resolveInitialRequestSelection(loaded, "req_owned_1");
const fromB = resolveInitialRequestSelection(loaded, "req_owned_2");
check(
  "A → B changes the selected request to B",
  fromA.selectedId === "req_owned_1" && fromB.selectedId === "req_owned_2",
);
check(
  "A → B opens the Sheet on mobile and stays non-modal on desktop",
  requestMobileSheetShouldOpen(fromB.matchedSelectedId, false) === true &&
    requestMobileSheetShouldOpen(fromB.matchedSelectedId, true) === false,
);
const fromBToForeign = resolveInitialRequestSelection(loaded, "req_foreign_tenant");
check(
  "A → foreign does not invent a row and does not open the Sheet",
  fromBToForeign.matchedSelectedId === null &&
    requestMobileSheetShouldOpen(fromBToForeign.matchedSelectedId, false) === false,
);

console.log("\nSTATIC — #133 contact actions and in-lane constraints");
check(
  "Workspace still receives initialSelectedId from the page (page.tsx unchanged)",
  pageSrc.includes("initialSelectedId={params.selected}") &&
    pageSrc.includes("<RequestsWorkspace"),
);
check(
  "Call / Email actions from #133 remain on the details panel",
  detailsSrc.includes("<RequestContactActions") &&
    detailsSrc.includes("phone={request.customer?.phone}") &&
    detailsSrc.includes("email={request.customer?.email}"),
);
check(
  "Open customer action from #133 remains",
  detailsSrc.includes("Open customer") &&
    detailsSrc.includes("href={`/customers/${request.customer.id}`}"),
);
check(
  "Workspace still does not mutate requests",
  !workspaceSrc.includes(".update(") &&
    !workspaceSrc.includes(".create(") &&
    !workspaceSrc.includes(".delete(") &&
    !workspaceSrc.includes("fetch(") &&
    workspaceSrc.includes("selecting a row only changes local"),
);
check(
  "Workspace does not treat browser businessId as authority",
  !workspaceSrc.includes("params.businessId") &&
    !workspaceSrc.includes("searchParams") &&
    !workspaceSrc.includes("localStorage") &&
    !mobileListSrc.includes("businessId") &&
    !selectionSrc.includes("businessId"),
);
check(
  "No duplicate request-load logic was added (page still maps the list once)",
  pageSrc.includes("const requests: RequestListItem[] = requestsRaw.map") &&
    !workspaceSrc.includes("findMany") &&
    !workspaceSrc.includes("prisma") &&
    !selectionSrc.includes("prisma") &&
    !selectionSrc.includes("findMany"),
);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
