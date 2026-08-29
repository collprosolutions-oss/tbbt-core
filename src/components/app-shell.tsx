"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, ChevronsUpDown, ImageOff, LogOut, Menu } from "lucide-react";
import type { MembershipRole } from "@prisma/client";
import { signOutAction } from "@/app/actions/auth";
import { visibleAppNav } from "@/lib/nav";
import { NAV_ICONS } from "@/lib/nav-icons";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
 * Presentational grouping of the real nav destinations visibleAppNav()
 * (src/lib/nav.ts) returns -- this ONLY affects section headers in the
 * sidebar, never which items exist, their labels, hrefs, or the
 * capability gating that decides who sees them. An item whose href isn't
 * listed here still renders, in a trailing "More" section, so a future nav
 * addition can never silently disappear.
 */
const NAV_SECTIONS: readonly { label: string; hrefs: readonly string[] }[] = [
  { label: "Overview", hrefs: ["/dashboard"] },
  { label: "Operations", hrefs: ["/requests", "/customers", "/estimates", "/jobs", "/invoices"] },
  { label: "Business", hrefs: ["/services", "/team", "/settings"] },
];

function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * TBBT's platform identity.
 *
 * IMPORTANT: no real TBBT logo file exists anywhere in this repository
 * (checked the full working tree AND every commit on every branch -- the
 * only image assets that exist at all are public/icon.svg and
 * src/app/icon.svg, a plain auto-generated favicon, not a designed logo).
 * Per explicit direction, this deliberately does NOT invent a "TB"
 * monogram or any other replacement mark to fill that gap. Instead this
 * renders an honest, clearly-empty logo slot (a dashed outline with a
 * "no image" glyph) sized for a real logo file to be dropped in later,
 * plus the platform's own name as plain text -- never a fabricated icon.
 */
function PlatformBrand() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-sidebar-border text-sidebar-foreground/30"
        title="TBBT logo not yet provided"
      >
        <ImageOff className="size-4" />
      </span>
      <div className="leading-tight">
        <p className="text-base font-bold tracking-tight text-sidebar-foreground">TBBT</p>
        <p className="text-[10px] font-medium tracking-wide text-sidebar-foreground/50 uppercase">
          Business Operating System
        </p>
      </div>
    </div>
  );
}

/**
 * Active business identity + a switcher affordance for the eventual
 * multi-business account model. Only one Business exists per authenticated
 * membership today, so the menu itself is deliberately inert (no business
 * list/mutation logic) -- this is presentation only, never a hardcoded
 * "CollPro" component: businessName/tradeLabel always come from the
 * caller's real workspace data.
 */
function BusinessSwitcher({
  businessName,
  tradeLabel,
}: {
  businessName: string;
  tradeLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent/50"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-snug font-semibold text-sidebar-foreground">
              {businessName}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{tradeLabel}</Badge>
            </div>
          </div>
          <ChevronsUpDown className="mt-1 size-3.5 shrink-0 text-sidebar-foreground/40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Business</DropdownMenuLabel>
        <DropdownMenuItem className="justify-between">
          <span className="min-w-0 truncate">{businessName}</span>
          <Check className="size-3.5 shrink-0" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-xs text-muted-foreground">
          Additional businesses will appear here.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const items = visibleAppNav(role);
  const grouped = NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: items.filter((item) => section.hrefs.includes(item.href)),
  })).filter((section) => section.items.length > 0);
  const groupedHrefs = new Set(NAV_SECTIONS.flatMap((section) => section.hrefs));
  const leftover = items.filter((item) => !groupedHrefs.has(item.href));
  if (leftover.length > 0) {
    grouped.push({ label: "More", items: leftover });
  }

  return (
    <nav className="flex flex-col gap-4">
      {grouped.map((section) => (
        <div key={section.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-sidebar-foreground/40 uppercase">
            {section.label}
          </p>
          {section.items.map((item) => {
            const active = isNavActive(pathname, item.href);
            const Icon = NAV_ICONS[item.href];
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-2 left-0 w-0.5 rounded-full bg-sidebar-primary transition-opacity",
                    active ? "opacity-100" : "opacity-0",
                  )}
                />
                {Icon ? <Icon className="size-4 shrink-0" /> : null}
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
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
    <div className="space-y-3.5 px-4 py-5">
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarFallback className="bg-sidebar-accent font-semibold text-sidebar-accent-foreground">
            {initials(userName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-sidebar-foreground">
            {userName}
          </p>
          <p className="truncate text-xs text-sidebar-foreground/55">{userEmail}</p>
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
      <aside className="hidden w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="px-3.5 py-4">
          <PlatformBrand />
        </div>
        <div className="border-t border-sidebar-border px-2.5 py-3">
          <BusinessSwitcher businessName={businessName} tradeLabel={tradeLabel} />
        </div>
        <div className="flex-1 overflow-y-auto border-t border-sidebar-border px-3 py-4">
          <NavLinks pathname={pathname} role={role} />
        </div>
        <div className="border-t border-sidebar-border">
          <AccountArea userName={userName} userEmail={userEmail} role={role} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm md:hidden">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground/50"
              title="TBBT logo not yet provided"
            >
              <ImageOff className="size-3.5" />
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
          <SheetContent side="left" className="flex w-80 flex-col gap-0 p-0 bg-sidebar text-sidebar-foreground">
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <div className="px-3.5 py-4">
              <PlatformBrand />
            </div>
            <div className="border-t border-sidebar-border px-2.5 py-3">
              <BusinessSwitcher businessName={businessName} tradeLabel={tradeLabel} />
            </div>
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
