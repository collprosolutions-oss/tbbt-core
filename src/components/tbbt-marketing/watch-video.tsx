"use client";

import { useState } from "react";
import { Play } from "lucide-react";

export function TbbtWatchVideoButton({
  className = "tbbt-btn tbbt-btn--ghost tbbt-btn--lg",
  label = "Watch Video",
}: {
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        className={className}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Play size={16} />
        {label}
        <span className="tbbt-soon">Coming Soon</span>
      </button>
      {open ? (
        <p className="tbbt-video-note" role="status">
          A product walkthrough video will appear here. No video has been
          published yet, so this button does not link to a placeholder URL.
        </p>
      ) : null}
    </div>
  );
}
