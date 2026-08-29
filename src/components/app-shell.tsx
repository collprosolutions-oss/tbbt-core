"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClock,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  Settings,
  UserCog,
  Users,
  Wrench,
} from "lucide-react";
import type { MembershipRole } from "@prisma/client";
import { signOutAction } from "@/app/actions/auth";
import { visibleAppNav } from "@/lib/nav";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type AppShellProps = {
  businessName: string;
  tradeLabel: string;
  userName: string;
  userEmail: string;
  role: MembershipRole;
  children: ReactNode;
};

/**
 * Purely presentational -- keyed by the same hrefs visibleAppNav() already
 * returns from src/lib/nav.ts, never adding/removing/reordering a
 * destination. A nav item with no matching icon here (a future one) simply
 * renders without one; it still shows its real label and href.
 */
const NAV_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "/dashboard": LayoutDashboard,
  "/requests": Inbox,
  "/customers": Users,
  "/estimates": FileText,
  "/jobs": CalendarClock,
  "/invoices": Receipt,
  "/services": Wrench,
  "/team": UserCog,
  "/settings": Settings,
};

function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-bold tracking-tight text-sidebar-primary-foreground">
        TB
      </span>
      <span className="text-xs font-semibold tracking-[0.14em] text-sidebar-foreground/60 uppercase">
        TBBT
      </span>
    </div>
  );
}

function BusinessIdentity({
  businessName,
  tradeLabel,
}: {
  businessName: string;
  tradeLabel: string;
}) {
  return (
    <div className="space-y-3 px-4 py-5">
      <BrandMark />
      <div>
        <p className="truncate text-base font-semibold text-sidebar-foreground">
          {businessName}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{tradeLabel}</Badge>
        </div>
      </div>
    </div>
  );
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
    <nav className="flex flex-col gap-0.5">
      {visibleAppNav(role).map((item) => {
        const active = isNavActive(pathname, item.href);
        const Icon = NAV_ICONS[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary transition-opacity",
                active ? "opacity-100" : "opacity-0",
              )}
            />
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function AccountArea({
  userName,
  userEmail,
  role,
}: {
  userName: string;
  userEmail: string;
  role: MembershipRole;
}) {
  return (
    <div className="space-y-3 px-4 py-4">
      <div className="flex items-center gap-2.5">
        <Avatar size="sm">
          <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground">
            {initials(userName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-sidebar-foreground">
            {userName}
          </p>
          <p className="truncate text-xs text-sidebar-foreground/60">{userEmail}</p>
        </div>
        <Badge variant="outline" className="border-sidebar-border text-sidebar-foreground/70">
          {role}
        </Badge>
      </div>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="sm" className="w-full gap-1.5">
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </form>
    </div>
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
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <BusinessIdentity businessName={businessName} tradeLabel={tradeLabel} />
        <div className="border-t border-sidebar-border flex-1 overflow-y-auto px-3 py-4">
          <NavLinks pathname={pathname} role={role} />
        </div>
        <div className="border-t border-sidebar-border">
          <AccountArea userName={userName} userEmail={userEmail} role={role} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm md:hidden">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
              TB
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{businessName}</p>
              <p className="text-[11px] text-muted-foreground">{tradeLabel}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
        </header>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="flex w-72 flex-col gap-0 p-0 bg-sidebar text-sidebar-foreground">
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <BusinessIdentity businessName={businessName} tradeLabel={tradeLabel} />
            <div className="flex-1 overflow-y-auto border-t border-sidebar-border px-3 py-4">
              <NavLinks
                pathname={pathname}
                role={role}
                onNavigate={() => setMenuOpen(false)}
              />
            </div>
            <div className="border-t border-sidebar-border">
              <AccountArea userName={userName} userEmail={userEmail} role={role} />
            </div>
          </SheetContent>
        </Sheet>

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
