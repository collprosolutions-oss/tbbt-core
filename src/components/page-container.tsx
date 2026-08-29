import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const WIDTHS = {
  /** Record detail / list pages -- most of the management console. */
  default: "max-w-5xl",
  /** Calendar/grid-heavy pages that need the extra desktop room (Schedule). */
  wide: "max-w-6xl",
  /** Single-column forms (auth, narrow confirmations). */
  narrow: "max-w-3xl",
} as const;

type PageContainerProps = {
  children: ReactNode;
  width?: keyof typeof WIDTHS;
  className?: string;
};

/**
 * The one place every management-console page controls its own width. All
 * of Dashboard/Requests/Customers/Estimates/Jobs/Invoices/Services/Team/
 * Settings previously repeated `mx-auto max-w-3xl space-y-6` by hand --
 * this is that same wrapper, centralized, so a future page (Time Cards,
 * Payroll, Expenses, Reports...) automatically gets the same page width and
 * vertical rhythm for free instead of re-guessing a max-width.
 */
export function PageContainer({
  children,
  width = "default",
  className,
}: PageContainerProps) {
  return (
    <div className={cn("mx-auto w-full space-y-6", WIDTHS[width], className)}>
      {children}
    </div>
  );
}
