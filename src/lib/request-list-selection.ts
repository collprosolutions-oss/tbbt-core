/**
 * Requests workspace selection for `?selected=`.
 *
 * Resolves only against the already tenant-scoped loaded request set.
 * Missing or foreign IDs never invent a request. Opening the mobile
 * Sheet is a separate viewport decision -- the shared Sheet overlay
 * still mounts on desktop when `open` is true, even if SheetContent
 * is `lg:hidden`.
 */

/** Tailwind `lg` -- same breakpoint as the desktop Request Details panel. */
export const REQUESTS_MOBILE_SHEET_QUERY = "(max-width: 1023px)";
export const REQUESTS_DESKTOP_DETAILS_QUERY = "(min-width: 1024px)";

export function resolveInitialRequestSelection(
  requests: ReadonlyArray<{ id: string }>,
  initialSelectedId?: string | null,
): { selectedId: string | null; matchedSelectedId: string | null } {
  const matchedSelectedId =
    initialSelectedId && requests.some((request) => request.id === initialSelectedId)
      ? initialSelectedId
      : null;
  return {
    selectedId: matchedSelectedId ?? requests[0]?.id ?? null,
    matchedSelectedId,
  };
}

export function requestMobileSheetShouldOpen(
  matchedSelectedId: string | null | undefined,
  isDesktopViewport: boolean,
): boolean {
  return Boolean(matchedSelectedId) && !isDesktopViewport;
}
