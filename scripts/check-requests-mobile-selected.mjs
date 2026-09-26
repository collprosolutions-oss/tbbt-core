/**
 * Focused mobile selected-id regression for the Requests workspace.
 *
 * Proves `?selected=<serviceRequestId>` opens the mobile detail sheet when
 * the ID is already in the tenant-scoped loaded set, leaves the sheet
 * closed for missing/foreign IDs, shows recorded property labels on
 * mobile cards, and keeps the #133 Call / Email / Open customer actions.
 *
 * No page.tsx edits, no mutation, no browser businessId authority, and
 * no second request-load path.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-requests-mobile-selected.mjs
 */
import { readFileSync } from "node:fs";

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

/**
 * Local copy of the workspace resolver used only to pin the contract.
 * Static checks below require the workspace source to keep the same
 * tenant-scoped `requests.some(...)` match and `openMobileSheet` flag.
 */
function resolveInitialRequestSelection(requests, initialSelectedId) {
  const matchedId =
    initialSelectedId && requests.some((request) => request.id === initialSelectedId)
      ? initialSelectedId
      : null;
  return {
    selectedId: matchedId ?? requests[0]?.id ?? null,
    openMobileSheet: Boolean(matchedId),
  };
}

const workspaceSrc = readRepo("src/components/requests/requests-workspace.tsx");
const pageSrc = readRepo("src/app/(app)/requests/page.tsx");
const mobileListStart = workspaceSrc.indexOf("function RequestsMobileList");
const mobileListEnd = workspaceSrc.indexOf("function DetailField");
const mobileListSrc = workspaceSrc.slice(mobileListStart, mobileListEnd);
const detailsStart = workspaceSrc.indexOf("function RequestDetailsPanel");
const detailsSrc = workspaceSrc.slice(detailsStart);

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

console.log("\nSTATIC — ?selected= opens the mobile sheet from the loaded set");
check(
  "Workspace still receives initialSelectedId from the page (page.tsx unchanged)",
  pageSrc.includes("initialSelectedId={params.selected}") &&
    pageSrc.includes("<RequestsWorkspace"),
);
check(
  "Initial selection is resolved only from the already-loaded request set",
  workspaceSrc.includes("export function resolveInitialRequestSelection") &&
    workspaceSrc.includes("requests.some((request) => request.id === initialSelectedId)") &&
    workspaceSrc.includes("openMobileSheet: Boolean(matchedId)"),
);
check(
  "Matching selected ID initializes the mobile sheet open",
  workspaceSrc.includes("useState(initialSelection.openMobileSheet)") &&
    workspaceSrc.includes("useState<string | null>(initialSelection.selectedId)"),
);
check(
  "Tap-to-select still opens the same mobile sheet (no second sheet)",
  workspaceSrc.includes("function selectRequest(id: string)") &&
    workspaceSrc.includes("setMobileOpen(true)") &&
    (workspaceSrc.match(/<Sheet /g) ?? []).length === 1,
);
check(
  "Resolver does not take browser businessId or invent a request",
  !workspaceSrc.includes("businessId?:") &&
    !workspaceSrc.includes("window.") &&
    workspaceSrc.includes("never invent a request") &&
    workspaceSrc.includes("requests[0]?.id ?? null"),
);

console.log("\nUNIT — Selected ID opens the sheet; foreign/missing IDs do not");
const loaded = [{ id: "req_owned_1" }, { id: "req_owned_2" }];
const match = resolveInitialRequestSelection(loaded, "req_owned_2");
check(
  "Matching tenant-scoped ID selects that record and opens the mobile sheet",
  match.selectedId === "req_owned_2" && match.openMobileSheet === true,
);
const missing = resolveInitialRequestSelection(loaded, "req_missing");
check(
  "Missing selected ID does not open the sheet and does not invent a row",
  missing.selectedId === "req_owned_1" && missing.openMobileSheet === false,
);
const foreign = resolveInitialRequestSelection(loaded, "req_foreign_tenant");
check(
  "Foreign selected ID is treated as absent (loaded set only)",
  foreign.selectedId === "req_owned_1" && foreign.openMobileSheet === false,
);
const emptyMatch = resolveInitialRequestSelection([], "req_owned_1");
check(
  "Selected ID against an empty loaded set stays closed and invents nothing",
  emptyMatch.selectedId === null && emptyMatch.openMobileSheet === false,
);
const noParam = resolveInitialRequestSelection(loaded, undefined);
check(
  "No selected param keeps the first-row highlight and leaves the sheet closed",
  noParam.selectedId === "req_owned_1" && noParam.openMobileSheet === false,
);
const blank = resolveInitialRequestSelection(loaded, "");
check(
  "Blank selected ID never opens the sheet",
  blank.selectedId === "req_owned_1" && blank.openMobileSheet === false,
);

console.log("\nSTATIC — #133 contact actions and in-lane constraints");
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
    !mobileListSrc.includes("businessId"),
);
check(
  "No duplicate request-load logic was added (page still maps the list once)",
  pageSrc.includes("const requests: RequestListItem[] = requestsRaw.map") &&
    !workspaceSrc.includes("findMany") &&
    !workspaceSrc.includes("prisma"),
);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
