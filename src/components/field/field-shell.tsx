import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * Mobile-first Field shell -- deliberately NOT <AppShell> (see
 * src/components/app-shell.tsx): no sidebar, no business-wide nav links,
 * nothing but this member's own name/business and a sign-out control. Every
 * page under src/app/field renders through this instead of the (app)
 * layout, so a MEMBER never receives any management navigation or data.
 */
export function FieldShell({
  businessName,
  userName,
  children,
}: {
  businessName: string;
  userName: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{businessName}</p>
          <p className="truncate text-xs text-muted-foreground">{userName}</p>
        </div>
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 py-5">
        {children}
      </main>
    </div>
  );
}
