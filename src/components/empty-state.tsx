import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/**
 * The shared "nothing here yet" card. Every list page (Requests,
 * Customers, Estimates, Invoices, Jobs, Services...) previously hand-built
 * its own `<Card><CardHeader>...` empty message; this is that same visual
 * pattern as one reusable primitive, styled as a calm dashed placeholder so
 * it never competes with real data cards above/below it on the same page.
 */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <Card className={cn("border-dashed bg-transparent shadow-none", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {action ? (
        <CardContent className="flex flex-wrap gap-2">{action}</CardContent>
      ) : null}
    </Card>
  );
}
