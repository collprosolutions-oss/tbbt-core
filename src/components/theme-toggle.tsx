"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Minimal, session-only light/dark control for the AppShell header. The
 * theme tokens for BOTH modes already exist in globals.css (the original
 * light `:root` block was never removed, only `.dark` was restyled to the
 * approved navy palette), so this simply toggles the `dark` class on
 * `<html>` -- no new theme system, no persistence, nothing else touched.
 * Dark is still the default on every fresh load (set server-side in
 * src/app/layout.tsx), matching the approved default visual direction.
 */
export function ThemeToggle() {
  const [isDark, setIsDark] = useState(true);

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        document.documentElement.classList.toggle("dark");
        setIsDark((current) => !current);
      }}
    >
      {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}
