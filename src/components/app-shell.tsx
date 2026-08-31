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
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { HeaderControlsContext } from "@/components/header-controls-context";
import { cn } from "@/lib/utils";

type AppShellProps = {
  businessName: string;
  /**
   * The active subscriber business's own logo, if one is on file --
   * resolved by the caller (see getBusinessLogoSrc() in
   * src/lib/business-branding.ts), NEVER a hardcoded business name/path
   * here. AppShell renders its existing empty logo slot when this is
   * null/undefined, exactly as it does for a business with no logo yet.
   */
  businessLogoSrc?: string | null;
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
  { label: "Operations", hrefs: ["/requests", "/customers", "/estimates", "/jobs", "/time-cards", "/payroll", "/invoices"] },
  { label: "Business", hrefs: ["/reports", "/services", "/team", "/settings"] },
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
 * TBBT's own platform logo -- the approved brand asset at
 * public/brand/tbbt-logo.png (an unmodified copy of the founder-provided
 * file: same pixels, same aspect ratio, nothing redrawn/recolored/
 * cropped). AppShell is itself a TBBT component, so this is the one place
 * safe to reference it directly, unlike a specific subscriber business's
 * own logo (see businessLogoSrc on AppShellProps). Sized by height so it
 * fits the horizontal top header/mobile bar; width follows automatically
 * from the image's own aspect ratio, never stretched or cropped.
 */
const TBBT_LOGO_SIZE = { width: 1659, height: 948 } as const;

function PlatformLogo({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/tbbt-logo.png"
      alt="TBBT"
      width={TBBT_LOGO_SIZE.width}
      height={TBBT_LOGO_SIZE.height}
      className={cn("w-auto", className)}
    />
  );
}

/**
 * A subscriber business's own logo, if one is on file (see
 * businessLogoSrc on AppShellProps) -- otherwise the same honest empty
 * slot AppShell has always shown for a business with no logo yet.
 *
 * IMPORTANT: this deliberately has NO `overflow-hidden`/rounded-corner
 * clipping and NO `object-cover` on the provided logo -- both would crop
 * part of the source artwork. `object-contain` at the image's own
 * intrinsic aspect ratio (via width/height) only ever letterboxes inside
 * the box; it can never cut off any part of the image, and the box is
 * sized to the logo's own aspect ratio rather than forced square, so the
 * complete, unmodified logo is always shown.
 */
const COLLPRO_LOGO_SIZE = { width: 1254, height: 1254 } as const;

function BusinessLogo({
  src,
  businessName,
  heightClassName = "h-9",
}: {
  src?: string | null;
  businessName: string;
  heightClassName?: string;
}) {
  if (!src) {
    return (
      <span
        className={cn(
          "flex aspect-square shrink-0 items-center justify-center rounded-lg border border-dashed border-sidebar-border text-sidebar-foreground/30",
          heightClassName,
        )}
        title="Business logo not yet provided"
      >
        <ImageOff className="size-4" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={businessName}
      width={COLLPRO_LOGO_SIZE.width}
      height={COLLPRO_LOGO_SIZE.height}
      className={cn("w-auto shrink-0 object-contain", heightClassName)}
    />
  );
}

/**
 * Active business identity + a switcher affordance for the eventual
 * multi-business account model. Only one Business exists per authenticated
 * membership today, so the menu itself is deliberately inert (no business
 * list/mutation logic) -- this is presentation only, never a hardcoded
 * "CollPro" component: businessName/tradeLabel/logoSrc always come from
 * the caller's real workspace data (see getBusinessLogoSrc() in
 * src/lib/business-branding.ts for how logoSrc is resolved).
 *
 * `layout="header"` is the compact horizontal treatment used in the
 * desktop top header; `layout="stacked"` is the fuller vertical treatment
 * still used in the mobile drawer.
 */
function BusinessSwitcher({
  businessName,
  tradeLabel,
  logoSrc,
  layout = "stacked",
}: {
  businessName: string;
  tradeLabel: string;
  logoSrc?: string | null;
  layout?: "stacked" | "header";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {layout === "header" ? (
          <button
            type="button"
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/50"
          >
            <BusinessLogo src={logoSrc} businessName={businessName} heightClassName="h-20" />
            <span className="flex flex-col items-start leading-tight">
              <span className="text-base font-semibold whitespace-nowrap text-sidebar-foreground">
                {businessName}
              </span>
              <span className="text-xs text-sidebar-foreground/50">{tradeLabel}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/40" />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent/50"
          >
            <BusinessLogo src={logoSrc} businessName={businessName} />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] leading-snug font-semibold text-sidebar-foreground">
                {businessName}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{tradeLabel}</Badge>
              </div>
            </div>
            <ChevronsUpDown className="size-3.5 shrink-0 self-center text-sidebar-foreground/40" />
          </button>
        )}
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
                  "relative flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[0.925rem] font-medium transition-colors",
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
                {Icon ? <Icon className="size-[1.1rem] shrink-0" /> : null}
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

/**
 * Compact account control for the desktop top header: avatar + name/role,
 * opening a small menu with the full email and Sign out. Same
 * signOutAction as everywhere else in the app -- this is presentation
 * only.
 */
function AccountMenu({
  userName,
  userEmail,
  role,
}: {
  userName: string;
  userEmail: string;
  role: MembershipRole;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/50"
        >
          <Avatar size="sm">
            <AvatarFallback className="bg-sidebar-accent font-semibold text-sidebar-accent-foreground">
              {initials(userName)}
            </AvatarFallback>
          </Avatar>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-sm font-medium whitespace-nowrap text-sidebar-foreground">
              {userName}
            </span>
            <span className="text-[11px] text-sidebar-foreground/50">{role}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium text-foreground">{userName}</p>
          <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <form action={signOutAction}>
          <DropdownMenuItem asChild variant="destructive">
            <button type="submit" className="w-full">
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({
  businessName,
  businessLogoSrc,
  tradeLabel,
  userName,
  userEmail,
  role,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pageActions, setPageActions] = useState<ReactNode>(null);
  const [pageSearch, setPageSearch] = useState<ReactNode>(null);
  const [pageTitleOverride, setPageTitleOverride] = useState<string | null>(null);
  const currentNavItem = visibleAppNav(role).find((item) => isNavActive(pathname, item.href));
  const pageTitle = pageTitleOverride ?? currentNavItem?.label ?? "Dashboard";

  return (
    <HeaderControlsContext.Provider value={{ setPageActions, setPageSearch, setPageTitle: setPageTitleOverride }}>
    <div className="flex min-h-full flex-col">
      {/*
       * Desktop-only top header: ONE horizontal bar spanning the full
       * width, above both the nav sidebar and the content -- TBBT logo,
       * active-business identity, current section, the current page's own
       * primary action + search (see header-controls-context.tsx --
       * whatever the page itself registers, never hardcoded here), theme
       * control, and account, left to right. The nav sidebar (below) is
       * nav-only now; brand/business/account no longer live inside it on
       * desktop.
       */}
      <header className="hidden h-24 shrink-0 items-center gap-4 border-b border-sidebar-border bg-sidebar px-5 md:flex">
        <Link href="/dashboard" className="flex shrink-0 items-center">
          <PlatformLogo className="h-16" />
        </Link>
        <Separator orientation="vertical" className="h-12 bg-sidebar-border" />
        <BusinessSwitcher
          businessName={businessName}
          tradeLabel={tradeLabel}
          logoSrc={businessLogoSrc}
          layout="header"
        />
        <Separator orientation="vertical" className="h-12 bg-sidebar-border" />
        <p className="shrink-0 truncate text-lg font-semibold text-sidebar-foreground">
          {pageTitle}
        </p>
        {pageActions ? <div className="flex shrink-0 items-center gap-2">{pageActions}</div> : null}
        {pageSearch ? <div className="min-w-0 max-w-sm flex-1">{pageSearch}</div> : null}
        <div className="flex-1" />
        <ThemeToggle />
        <AccountMenu userName={userName} userEmail={userEmail} role={role} />
      </header>

      {/* Mobile-only compact header, unchanged: hamburger opens the drawer below. */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm md:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <BusinessLogo src={businessLogoSrc} businessName={businessName} heightClassName="h-8" />
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

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Desktop nav sidebar -- nav only, starting below the top header. */}
        <aside className="hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar px-4 py-5 md:flex">
          <NavLinks pathname={pathname} role={role} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>

      {/* Mobile drawer: still the fuller stacked treatment (brand, business, nav, account). */}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="flex w-80 flex-col gap-0 p-0 bg-sidebar text-sidebar-foreground">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="px-3.5 py-4">
            <PlatformLogo className="h-11 max-w-full" />
          </div>
          <div className="border-t border-sidebar-border px-2.5 py-3">
            <BusinessSwitcher
              businessName={businessName}
              tradeLabel={tradeLabel}
              logoSrc={businessLogoSrc}
            />
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
    </div>
    </HeaderControlsContext.Provider>
  );
}
