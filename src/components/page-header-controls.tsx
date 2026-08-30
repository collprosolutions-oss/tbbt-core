"use client";

import { useLayoutEffect, type ReactNode } from "react";
import { useHeaderControls } from "@/components/header-controls-context";

/**
 * A page renders this (anywhere in its own JSX -- it renders no DOM
 * itself) to populate the shared desktop top header's contextual "primary
 * page action" and "page search" slots, per the approved header
 * architecture:
 *
 *   TBBT logo -> business switcher -> page title -> primary page action
 *   -> page search -> (communication/notifications, where implemented)
 *   -> theme -> account
 *
 * Both props are optional -- a page only passes what it actually,
 * genuinely has. There is no default/fallback content invented here.
 */
export function PageHeaderControls({
  actions,
  search,
}: {
  actions?: ReactNode;
  search?: ReactNode;
}) {
  const controls = useHeaderControls();

  // useLayoutEffect (not useEffect) so this commits before the browser
  // paints the first hydrated frame -- minimizes, though can't fully
  // eliminate, the moment between server-rendered HTML (which has no way
  // to know what a *different* part of the tree, AppShell's header,
  // should show) and the client picking this page's own registered
  // content up.
  useLayoutEffect(() => {
    controls?.setPageActions(actions ?? null);
    controls?.setPageSearch(search ?? null);
    return () => {
      controls?.setPageActions(null);
      controls?.setPageSearch(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, search]);

  return null;
}
