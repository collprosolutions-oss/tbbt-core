"use client";

import { useState } from "react";

export function TbbtWatchVideoButton() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        className="tbbt-btn tbbt-btn--ghost tbbt-btn--lg"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Watch Video
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
