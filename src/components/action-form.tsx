"use client";

import { useActionState, type ReactNode } from "react";

export type SimpleActionState = { error?: string; message?: string };

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: SimpleActionState, formData: FormData) => Promise<SimpleActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      {children}
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
