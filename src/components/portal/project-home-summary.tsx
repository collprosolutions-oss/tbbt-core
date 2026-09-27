import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PortalNextAction } from "@/lib/portal-project-home";

export type ProjectHomeFact = {
  label: string;
  value: string;
  href?: string;
};

/**
 * Mobile-first Project Home snapshot: current status, next appointment,
 * and the next customer action. Links only — no new mutations.
 */
export function ProjectHomeSummary({
  facts,
  nextAction,
  contact,
}: {
  facts: ProjectHomeFact[];
  nextAction: PortalNextAction;
  contact: {
    businessName: string;
    phone: string | null;
    email: string | null;
  };
}) {
  const isAnchor = nextAction.href.startsWith("#");
  const isExternalPath = nextAction.href.startsWith("/");

  return (
    <section className="space-y-4" aria-labelledby="project-home-heading">
      <Card className="border-primary/20">
        <CardHeader>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Your next step
          </p>
          <CardTitle id="project-home-heading" className="text-xl md:text-2xl">
            {nextAction.title}
          </CardTitle>
          <CardDescription>{nextAction.detail}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {nextAction.kind !== "none" ? (
            isAnchor ? (
              <Button asChild className="h-11 w-full sm:w-auto">
                <a href={nextAction.href}>{nextAction.title}</a>
              </Button>
            ) : isExternalPath ? (
              <Button asChild className="h-11 w-full sm:w-auto">
                <Link href={nextAction.href}>{nextAction.title}</Link>
              </Button>
            ) : null
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            {contact.phone ? (
              <Button asChild variant="outline" className="h-11 w-full sm:w-auto">
                <a href={`tel:${contact.phone.replace(/\D/g, "")}`}>
                  Call {contact.businessName}
                </a>
              </Button>
            ) : null}
            {contact.email ? (
              <Button asChild variant="outline" className="h-11 w-full sm:w-auto">
                <a href={`mailto:${contact.email}`}>Email {contact.businessName}</a>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project Home</CardTitle>
          <CardDescription>
            Recorded facts for this project. Nothing here is guessed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.label} className="rounded-lg border bg-muted/30 p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {fact.label}
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {fact.href ? (
                    <a href={fact.href} className="underline underline-offset-4">
                      {fact.value}
                    </a>
                  ) : (
                    fact.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}
