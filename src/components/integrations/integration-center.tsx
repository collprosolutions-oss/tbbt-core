import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  GO_LIVE_PATH,
  INTEGRATION_CENTER_READ_ONLY_MESSAGE,
  type IntegrationCenter,
  type IntegrationCard,
} from "@/lib/integrations";
import type { GoLiveRequirement, GoLiveStatus } from "@/lib/go-live";

function statusVariant(status: GoLiveStatus) {
  if (status === "LIVE" || status === "READY") return "success" as const;
  if (status === "PARTIAL") return "warning" as const;
  return "outline" as const;
}

function requirementVariant(requirement: GoLiveRequirement) {
  if (requirement === "REQUIRED") return "secondary" as const;
  if (requirement === "CONDITIONAL") return "warning" as const;
  return "outline" as const;
}

function IntegrationStatusBadge({ item }: { item: IntegrationCard }) {
  return <Badge variant={statusVariant(item.status)}>{item.statusLabel}</Badge>;
}

export function IntegrationCenterView({ center }: { center: IntegrationCenter }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Integration Center</CardTitle>
          <CardDescription>{INTEGRATION_CENTER_READ_ONLY_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{center.disclaimer}</p>
          <p className="text-sm text-muted-foreground">
            Current plan: {center.planName}. Product entitlements are shown on
            integrations that belong to a paid capability. Plans are not changed
            from this page.
          </p>
          <p className="text-xs text-muted-foreground">
            <Link href={GO_LIVE_PATH} className="text-primary underline-offset-4 hover:underline">
              Open Go-live / Integration Health
            </Link>{" "}
            for the production readiness board, including planned placeholders
            that are not listed here.
          </p>
        </CardContent>
      </Card>

      {center.categories.map((category) => (
        <section key={category.id} className="space-y-3">
          <h2 className="text-base font-semibold">{category.id}</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {category.items.map((item) => (
              <article key={item.key} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{item.displayName}</p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                  <IntegrationStatusBadge item={item} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant={requirementVariant(item.requirement)}>
                    {item.requirementLabel}
                  </Badge>
                  {item.entitlement ? (
                    <Badge variant={item.entitlement.entitled ? "secondary" : "outline"}>
                      {item.entitlement.entitled
                        ? `${item.entitlement.label} included`
                        : `${item.entitlement.label} not included`}
                    </Badge>
                  ) : null}
                </div>
                <dl className="mt-3 space-y-2 text-sm">
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Current state
                    </dt>
                    <dd>{item.currentState}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      What works
                    </dt>
                    <dd className="text-muted-foreground">{item.whatWorks}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      What does not
                    </dt>
                    <dd className="text-muted-foreground">{item.whatDoesNot}</dd>
                  </div>
                  {item.entitlement ? (
                    <div>
                      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Product entitlement
                      </dt>
                      <dd className="text-muted-foreground">
                        {item.entitlement.entitled
                          ? `${item.entitlement.label} is included on the current plan.`
                          : `${item.entitlement.label} is not included on the current plan.`}{" "}
                        Implementation: {item.entitlement.implementationStatus}.{" "}
                        {item.entitlement.note}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Owner next action
                    </dt>
                    <dd>
                      {item.ownerNextAction}{" "}
                      <Link
                        href={item.settingsHref}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        Open related settings
                      </Link>
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
