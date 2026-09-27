import Link from "next/link";
import { AutomationRuleToggle } from "@/components/automations/automation-rule-toggle";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AUTOMATIONS_PATH,
  NO_RECORDED_AUTOMATION_RULES_MESSAGE,
  type AutomationOwnerCenter,
  type AutomationRunProjection,
} from "@/lib/automations";

function enabledVariant(enabled: boolean) {
  return enabled ? ("success" as const) : ("outline" as const);
}

function statusVariant(status: string) {
  if (status === "SUCCEEDED") return "success" as const;
  if (status === "FAILED") return "destructive" as const;
  if (status === "BLOCKED") return "warning" as const;
  return "outline" as const;
}

function RunFacts({ run }: { run: AutomationRunProjection }) {
  return (
    <dl className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Recorded status
        </dt>
        <dd>
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
        </dd>
      </div>
      {run.resultSummary ? (
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recorded result
          </dt>
          <dd>{run.resultSummary}</dd>
        </div>
      ) : null}
      {run.lastError ? (
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recorded error
          </dt>
          <dd>{run.lastError}</dd>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Attempt count {run.attemptCount}. Recorded {run.createdAt}
        {run.processedAt ? `. Processed ${run.processedAt}` : ""}.
      </p>
    </dl>
  );
}

export function AutomationCenterView({ center }: { center: AutomationOwnerCenter }) {
  const selected = center.rules.find((rule) => rule.id === center.selectedRuleId) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Automation rules</CardTitle>
          <CardDescription>{center.disclaimer}</CardDescription>
        </CardHeader>
        <CardContent>
          {center.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {NO_RECORDED_AUTOMATION_RULES_MESSAGE}
            </p>
          ) : (
            <ul className="space-y-3">
              {center.rules.map((rule) => (
                <li
                  key={rule.id}
                  className="rounded-xl border bg-card p-4"
                  data-rule-id={rule.id}
                  data-supported={rule.supported ? "true" : "false"}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className="font-medium">{rule.label}</p>
                      {rule.supported ? (
                        <p className="text-sm text-muted-foreground">
                          Trigger: {rule.triggerLabel}. Action: {rule.actionLabel}.
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">{rule.sentence}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={enabledVariant(rule.enabled)}>
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      {rule.supported ? (
                        <Badge variant="secondary">Supported</Badge>
                      ) : (
                        <Badge variant="warning">Unsupported</Badge>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Recorded trigger {rule.recordedTrigger}. Recorded action {rule.recordedAction}.
                    Recorded kind {rule.kind}. Updated {rule.updatedAt}.
                  </p>
                  <p className="mt-1 text-sm">{rule.configSummary}</p>
                  {rule.lastRun ? (
                    <div className="mt-3 rounded-md border p-3">
                      <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Last recorded run
                      </p>
                      <RunFacts run={rule.lastRun} />
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No recorded run yet.</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Link
                      href={`${AUTOMATIONS_PATH}?ruleId=${encodeURIComponent(rule.id)}`}
                      className="text-sm text-primary underline-offset-4 hover:underline"
                    >
                      Show recent runs
                    </Link>
                    {rule.canToggle ? (
                      <AutomationRuleToggle ruleId={rule.id} enabled={rule.enabled} />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This recorded rule cannot be enabled from this page.
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent recorded runs</CardTitle>
            <CardDescription>
              Last {center.historyLimit} AutomationRun rows for this owned rule. Status values
              are recorded exactly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium">{selected.label}</p>
            {center.selectedHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recorded runs for this rule.</p>
            ) : (
              <ul className="space-y-2">
                {center.selectedHistory.map((run) => (
                  <li key={run.id} className="rounded-md border p-3">
                    <RunFacts run={run} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
