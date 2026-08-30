"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Lets a PAGE (rendered as `{children}` deep inside AppShell) provide
 * content for the shared desktop top header's contextual slots --
 * primary page action and page search -- without AppShell hardcoding any
 * page-specific control. See src/components/page-header-controls.tsx for
 * the component pages actually use; AppShell (src/components/
 * app-shell.tsx) is the sole Provider and is what actually renders
 * whatever the current page registers.
 *
 * A page that has no real primary action, or no real search capability
 * yet, simply never calls this -- the corresponding header slot renders
 * nothing. Nothing here fabricates data or search behavior; it only
 * relays whatever real, already-working JSX (a real Link/Button to a
 * real route, a real search form) a page chooses to provide.
 */
export type HeaderControlsContextValue = {
  setPageActions: (node: ReactNode) => void;
  setPageSearch: (node: ReactNode) => void;
  /**
   * Overrides the header's page-title segment for the current page only
   * (AppShell still derives the default from src/lib/nav.ts -- this never
   * changes a nav label/sidebar link, only what a specific page's own
   * header segment displays, for the rare case where the approved header
   * title differs from the sidebar's short nav label).
   */
  setPageTitle: (title: string | null) => void;
};

export const HeaderControlsContext = createContext<HeaderControlsContextValue | null>(null);

export function useHeaderControls() {
  return useContext(HeaderControlsContext);
}
