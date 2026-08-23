"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { signOutAction } from "@/app/actions/auth";
import { APP_NAV } from "@/lib/nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type AppShellProps = {
  businessName: string;
  tradeLabel: string;
  userName: string;
  userEmail: string;
  role: string;
  children: ReactNode;
};

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {APP_NAV.map((item) => {
        const active = pathname === item.href;
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
          <p className="mt-1 text-base font-semibold">The Better Business Tool</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{tradeLabel}</Badge>
            <span className="text-xs text-muted-foreground">Available</span>
          </div>
        </div>
        <Separator />
        <div className="flex-1 px-3 py-4">
          <NavLinks pathname={pathname} />
        </div>
        <Separator />
        <div className="space-y-2 px-4 py-4">
          <p className="truncate text-sm font-medium">{businessName}</p>
          <p className="truncate text-xs text-muted-foreground">{userName}</p>
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
            <p className="text-sm font-semibold">TBBT</p>
            <p className="text-xs text-muted-foreground">{businessName}</p>
          </div>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              aria-label="Open menu"
              className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background"
            >
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent
              side="left"
              className="inset-y-0 left-0 h-full w-72 border-r bg-background"
            >
              <SheetHeader>
                <SheetTitle>TBBT</SheetTitle>
              </SheetHeader>
              <div className="px-2">
                <NavLinks
                  pathname={pathname}
                  onNavigate={() => setMenuOpen(false)}
                />
                <Separator className="my-4" />
                <p className="text-sm font-medium">{userName}</p>
                <p className="text-xs text-muted-foreground">{role}</p>
                <form action={signOutAction} className="mt-4">
                  <Button type="submit" variant="outline" size="sm" className="w-full">
                    Sign out
                  </Button>
                </form>
              </div>
            </SheetContent>
          </Sheet>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
