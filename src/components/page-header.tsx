import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
};

/**
 * Shared page title block -- every management-console page (and Field Home)
 * renders through this, so heading scale, spacing, and the title/description/
 * actions layout stay identical everywhere without each page re-deciding it.
 */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="border-b border-border/70 pb-5">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      {description ? (
        <div className="mt-1.5 text-sm text-muted-foreground">{description}</div>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
