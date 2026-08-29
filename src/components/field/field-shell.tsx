import type { ReactNode } from "react";
import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/actions/auth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * Mobile-first Field shell -- deliberately NOT <AppShell> (see
 * src/components/app-shell.tsx): no sidebar, no business-wide nav links,
 * nothing but this member's own name/business and a sign-out control. Every
 * page under src/app/field renders through this instead of the (app)
 * layout, so a MEMBER never receives any management navigation or data.
 *
 * Styled as a simplified sibling of AppShell (same dark navy header, same
 * identity-block idea) rather than a different visual language, per the
 * "same professional family resemblance, simpler and mobile-first" brief.
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
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar size="sm">
            <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground">
              {initials(userName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-sidebar-foreground">
              {businessName}
            </p>
            <p className="truncate text-xs text-sidebar-foreground/60">{userName}</p>
          </div>
        </div>
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm" className="gap-1.5">
            <LogOut className="size-3.5" />
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
