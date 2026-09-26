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
  GO_LIVE_CONDITIONAL_SUMMARY,
  GO_LIVE_NO_SCORE_DISCLAIMER,
  GO_LIVE_OPTIONAL_SUMMARY,
  GO_LIVE_READ_ONLY_MESSAGE,
  GO_LIVE_REQUIRED_SUMMARY,
  GO_LIVE_REQUIREMENT_LABELS,
  GO_LIVE_STATUS_LABELS,
  type GoLiveCenter,
  type GoLiveGroupRequirement,
  type GoLiveStatus,
} from "@/lib/go-live";

function statusVariant(status: GoLiveStatus) {
  if (status === "LIVE" || status === "READY") return "success" as const;
  if (status === "PARTIAL") return "warning" as const;
  return "outline" as const;
}

function StatusBadge({ status }: { status: GoLiveStatus }) {
  return <Badge variant={statusVariant(status)}>{GO_LIVE_STATUS_LABELS[status]}</Badge>;
}

function groupBadgeVariant(requirement: GoLiveGroupRequirement) {
  if (requirement === "REQUIRED") return "secondary" as const;
  if (requirement === "CONDITIONAL" || requirement === "MIXED") return "warning" as const;
  return "outline" as const;
}

export function GoLiveHealthCenter({ center }: { center: GoLiveCenter }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Go-live / Integration Health</CardTitle>
          <CardDescription>{GO_LIVE_READ_ONLY_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{center.disclaimer}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Required for core production
              </p>
              <p className="mt-1 text-sm">
                {center.requiredLiveCount} live · {center.requiredReadyCount} ready ·{" "}
                {center.requiredRemainingCount} still open of {center.requiredCards.length}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{GO_LIVE_REQUIRED_SUMMARY}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Conditional
              </p>
              <p className="mt-1 text-sm">
                {center.conditionalCards.length} capabilities. Not counted as required for core
                production.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{GO_LIVE_CONDITIONAL_SUMMARY}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Optional / planned
              </p>
              <p className="mt-1 text-sm">
                {center.optionalCards.length} capabilities. Disconnected is not broken.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{GO_LIVE_OPTIONAL_SUMMARY}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{GO_LIVE_NO_SCORE_DISCLAIMER}</p>
        </CardContent>
      </Card>

      {center.groups.map((group) => (
        <section key={group.id} className="space-y-3">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold">{group.label}</h3>
              <Badge variant={groupBadgeVariant(group.requirement)}>{group.requirementLabel}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{group.summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {group.liveCount} live · {group.readyCount} ready · {group.remainingCount} remaining
              of {group.totalCount}
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {group.cards.map((card) => (
              <article key={card.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{card.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {GO_LIVE_REQUIREMENT_LABELS[card.requirement]}
                    </p>
                  </div>
                  <StatusBadge status={card.status} />
                </div>
                <dl className="mt-3 space-y-2 text-sm">
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Current state
                    </dt>
                    <dd>{card.currentState}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      What works
                    </dt>
                    <dd className="text-muted-foreground">{card.whatWorks}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      What does not
                    </dt>
                    <dd className="text-muted-foreground">{card.whatDoesNot}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Owner next action
                    </dt>
                    <dd>
                      {card.ownerNextAction}{" "}
                      <Link href={card.settingsHref} className="text-primary underline-offset-4 hover:underline">
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
