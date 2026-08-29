"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import type { MembershipRole } from "@prisma/client";
import { signOutAction } from "@/app/actions/auth";
import { visibleAppNav } from "@/lib/nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type AppShellProps = {
  businessName: string;
  tradeLabel: string;
  userName: string;
  userEmail: string;
  role: MembershipRole;
  children: ReactNode;
};

function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  pathname,
  role,
  onNavigate,
}: {
  pathname: string;
  role: MembershipRole;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-1">
      {visibleAppNav(role).map((item) => {
        const active = isNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({
  businessName,
  tradeLabel,
  userName,
  userEmail,
  role,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="px-4 py-5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            TBBT
          </p>
          <p className="mt-1 text-base font-semibold">{businessName}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{tradeLabel}</Badge>
          </div>
        </div>
        <Separator />
        <div className="flex-1 px-3 py-4">
          <NavLinks pathname={pathname} role={role} />
        </div>
        <Separator />
        <div className="space-y-2 px-4 py-4">
          <p className="truncate text-sm font-medium">{userName}</p>
          <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
          <p className="text-xs text-muted-foreground">Role: {role}</p>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm" className="w-full">
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3 md:hidden">
          <div>
            <p className="text-sm font-semibold">{businessName}</p>
            <p className="text-xs text-muted-foreground">TBBT</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
          {menuOpen ? (
            <div className="fixed inset-0 z-50 md:hidden">
              <button
                type="button"
                className="absolute inset-0 bg-black/40"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
              />
              <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r bg-background shadow-lg">
                <div className="px-4 py-4">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground">
                    TBBT
                  </p>
                  <p className="mt-1 text-base font-semibold">{businessName}</p>
                </div>
                <div className="flex-1 px-2">
                  <NavLinks
                    pathname={pathname}
                    role={role}
                    onNavigate={() => setMenuOpen(false)}
                  />
                </div>
                <div className="space-y-2 border-t px-4 py-4">
                  <p className="text-sm font-medium">{userName}</p>
                  <p className="text-xs text-muted-foreground">{role}</p>
                  <form action={signOutAction}>
                    <Button type="submit" variant="outline" size="sm" className="w-full">
                      Sign out
                    </Button>
                  </form>
                </div>
              </aside>
            </div>
          ) : null}
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
