"use client";

import { useState, type ComponentProps } from "react";

/**
 * Customer checkout / deposit submit. The first tap disables the button
 * so a second tap cannot open another Stripe test session.
 */
export function OnceSubmitButton({
  pendingLabel,
  children,
  className,
  disabled,
  onClick,
  ...props
}: ComponentProps<"button"> & { pendingLabel: string }) {
  const [pending, setPending] = useState(false);

  return (
    <button
      {...props}
      type="submit"
      className={className}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || pending || disabled) {
          event.preventDefault();
          return;
        }
        // Disable after this click's default submit is queued. Setting
        // pending synchronously remounts a disabled button and cancels
        // the first Pay Invoice POST, leaving "Opening checkout…".
        window.setTimeout(() => setPending(true), 0);
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
