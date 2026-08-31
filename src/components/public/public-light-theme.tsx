"use client";

import { useLayoutEffect } from "react";

/**
 * Public customer pages use a light presentation. The root layout still
 * defaults the document to the internal TBBT dark theme; this removes
 * that class only while a public page is mounted.
 */
export function PublicLightTheme() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    root.classList.remove("dark");
    return () => {
      if (hadDark) {
        root.classList.add("dark");
      }
    };
  }, []);
  return null;
}
