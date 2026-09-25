"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import type { SimpleActionState } from "@/components/action-form";

function newGrowthAttemptId() {
  return crypto.randomUUID();
}

/**
 * Holds one browser-generated attemptId for a single logical click.
 * Double-click/retry keeps the same id. A successful submit rotates it so
 * the next intentional action can create another row.
 */
export function GrowthAttemptForm({
  action,
  children,
  className,
}: {
  action: (prev: SimpleActionState, formData: FormData) => Promise<SimpleActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const [attemptId, setAttemptId] = useState(newGrowthAttemptId);
  const seenSuccess = useRef<string | null>(null);
  useEffect(() => {
    if (state.message && state.message !== seenSuccess.current) {
      seenSuccess.current = state.message;
      setAttemptId(newGrowthAttemptId());
    }
  }, [state.message]);
  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="attemptId" value={attemptId} />
      {children}
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
