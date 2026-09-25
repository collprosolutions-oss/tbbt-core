import type { Metadata } from "next";
import Link from "next/link";
import {
  completeRecommendationAction,
  createActionItemAction,
  createGoalAction,
  createRecommendationActionAction,
  dismissRecommendationAction,
  updateActionStatusAction,
  updateGoalStatusAction,
} from "@/app/actions/bsos";
import { ActionForm } from "@/components/action-form";
import { BsosCoachForm } from "@/components/bsos/coach-form";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { BSOS_AREA_LABELS, BSOS_AREAS, parseBsosArea } from "@/lib/bsos";
import { loadBsosWorkspace } from "@/lib/bsos-data";
import { ensureDefaultAutomationRules } from "@/lib/automation/rules";
import { processDueAutomationsAction, updateAutomationRuleAction } from "@/app/actions/automation";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Business Health" };

export default async function BusinessHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const area = parseBsosArea((await searchParams).area);
  const workspace = await loadBsosWorkspace(
    prisma,
    access.businessId,
    access.workspace.membership.id,
  );
  const automationRules = await ensureDefaultAutomationRules(prisma, access.businessId);

  return (
    <PageContainer>
      <PageHeader
        title="Business Health"
        description={`Recorded TBBT facts and owner recommendations. Bank balances and external analytics are never invented.${
          workspace.activeTrades?.length
            ? ` Active trades: ${workspace.activeTrades.map((trade) => trade.label).join(", ")}.`
            : ""
        }`}
      />
      <nav className="mb-4 flex flex-wrap gap-1.5">
        {BSOS_AREAS.map((item) => (
          <Link
            key={item}
            href={item === "health" ? "/business-health" : `/business-health?area=${item}`}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium",
              item === area ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {BSOS_AREA_LABELS[item]}
          </Link>
        ))}
      </nav>

      {area === "coach" && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>BSOS Coach</CardTitle>
            <CardDescription>
              {workspace.coach} Recorded facts stay authoritative. AI can explain them but cannot change permissions or invent balances.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <BsosCoachForm
              conversationId={workspace.conversation?.id}
              aiLabel={workspace.aiLabel}
            />
            {workspace.conversation?.messages?.length ? (
              <ul className="space-y-2 text-sm">
                {workspace.conversation.messages.map((message) => (
                  <li key={message.id} className="rounded-md border p-2">
                    <p className="text-xs uppercase text-muted-foreground">
                      {message.role} · {message.stance}
                    </p>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      )}

      {(area === "health" || area === "coach") && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>{area === "coach" ? "Recorded health behind the coach" : "Recorded health"}</CardTitle>
            <CardDescription>
              These numbers are recorded facts. Recommendations are listed separately.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {workspace.metrics.map((metric) => (
              <div key={metric.key} className="rounded-md border p-3">
                <p className="text-xs uppercase text-muted-foreground">{metric.label}</p>
                <p className="text-lg font-semibold">{metric.value}</p>
                <p className="text-xs text-muted-foreground">{metric.note}</p>
                <Link className="text-sm text-primary" href={metric.href}>
                  Open records
                </Link>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(area === "recommendations" || area === "coach" || area === "feed" || area === "health") && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Prioritized recommendations</CardTitle>
            <CardDescription>Each item explains the recorded facts that produced it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {workspace.recommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recommendations from recorded activity.</p>
            ) : (
              workspace.recommendations.map((item) => (
                <div key={item.key} className="rounded-md border p-3">
                  <p className="font-medium">{item.title}</p>
                  <p className="text-sm text-muted-foreground">Why: {item.why}</p>
                  <ul className="mt-1 text-sm">
                    {item.facts.map((fact) => (
                      <li key={fact.key}>
                        Fact: {fact.label} = {fact.value}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href={item.href}>Open source records</Link>
                    </Button>
                    <ActionForm action={createRecommendationActionAction}>
                      <input type="hidden" name="recommendationKey" value={item.key} />
                      <Button type="submit" size="sm">Create action</Button>
                    </ActionForm>
                    <ActionForm action={dismissRecommendationAction}>
                      <input type="hidden" name="recommendationKey" value={item.key} />
                      <Button type="submit" size="sm" variant="outline">Dismiss</Button>
                    </ActionForm>
                    <ActionForm action={completeRecommendationAction}>
                      <input type="hidden" name="recommendationKey" value={item.key} />
                      <Button type="submit" size="sm" variant="outline">Mark complete</Button>
                    </ActionForm>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {(area === "recommendations" || area === "coach") && workspace.recommendationHistory.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Recommendation history</CardTitle>
            <CardDescription>Dismissed or completed items stay here so they do not keep repeating.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {workspace.recommendationHistory.map((item) => (
              <p key={item.key}>
                {item.title} — {workspace.recommendationStates.find((row) => row.recommendationKey === item.key)?.status}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {area === "feed" && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Automation rules</CardTitle>
            <CardDescription>
              Business-scoped, opt-in, and never marked SENT unless a connected provider accepts the send. Defaults stay off except owner-action suggestions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ActionForm action={processDueAutomationsAction}>
              <Button type="submit" size="sm" variant="outline">Process due automations</Button>
            </ActionForm>
            <ul className="space-y-2">
              {automationRules.map((rule) => (
                <li key={rule.id} className="rounded-md border p-2">
                  <p>{rule.eventType} → {rule.purpose}</p>
                  <ActionForm action={updateAutomationRuleAction} className="mt-2 flex flex-wrap gap-2">
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <select name="enabled" defaultValue={rule.enabled ? "true" : "false"} className="rounded-md border px-2 py-1">
                      <option value="false">disabled</option>
                      <option value="true">enabled</option>
                    </select>
                    {rule.kind === "ACTION_SUGGESTION" ? (
                      <p className="text-xs text-muted-foreground">Owner action only. Changing a channel would not send a message.</p>
                    ) : (
                      <select name="channel" defaultValue={rule.channel} className="rounded-md border px-2 py-1">
                        <option value="NONE">NONE</option>
                        <option value="SMS">SMS</option>
                        <option value="EMAIL">EMAIL</option>
                        <option value="BOTH">BOTH</option>
                      </select>
                    )}
                    <input
                      type="number"
                      name="delayMinutes"
                      defaultValue={rule.delayMinutes}
                      className="w-24 rounded-md border px-2 py-1"
                    />
                    <Button type="submit" size="sm" variant="outline">Save</Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {(area === "goals" || area === "coach") && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Owner goals</CardTitle>
              <CardDescription>Goals are owner text, not fabricated targets.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={createGoalAction} className="mb-4 space-y-2">
                <input className="w-full rounded-md border px-3 py-2 text-sm" name="title" placeholder="Goal title" required />
                <textarea className="w-full rounded-md border px-3 py-2 text-sm" name="description" placeholder="Notes" />
                <input className="w-full rounded-md border px-3 py-2 text-sm" name="recommendationKey" placeholder="Optional recommendation key" />
                <Button type="submit" size="sm">Save goal</Button>
              </ActionForm>
              <ul className="space-y-2 text-sm">
                {workspace.goals.length === 0 ? (
                  <li className="text-sm text-muted-foreground">
                    No owner goals yet. Add one above — TBBT does not invent targets.
                  </li>
                ) : null}
                {workspace.goals.map((goal) => (
                  <li key={goal.id} className="rounded-md border p-2">
                    <p className="font-medium">{goal.title}</p>
                    <p className="text-muted-foreground">{goal.status}</p>
                    <ActionForm action={updateGoalStatusAction} className="mt-2 flex gap-2">
                      <input type="hidden" name="goalId" value={goal.id} />
                      <select name="status" defaultValue={goal.status} className="rounded-md border px-2 py-1">
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="DONE">DONE</option>
                        <option value="PAUSED">PAUSED</option>
                      </select>
                      <Button type="submit" size="sm" variant="outline">Update</Button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Action plan</CardTitle>
              <CardDescription>Owner actions answering a recommendation key.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={createActionItemAction} className="mb-4 space-y-2">
                <input className="w-full rounded-md border px-3 py-2 text-sm" name="title" placeholder="Action title" required />
                <input className="w-full rounded-md border px-3 py-2 text-sm" name="recommendationKey" placeholder="Recommendation key" />
                <textarea className="w-full rounded-md border px-3 py-2 text-sm" name="notes" placeholder="Notes" />
                <Button type="submit" size="sm">Add action</Button>
              </ActionForm>
              <ul className="space-y-2 text-sm">
                {workspace.actionItems.length === 0 ? (
                  <li className="text-sm text-muted-foreground">
                    No action items yet. Add one that answers a recommendation key.
                  </li>
                ) : null}
                {workspace.actionItems.map((item) => (
                  <li key={item.id} className="rounded-md border p-2">
                    <p className="font-medium">{item.title}</p>
                    <p className="text-muted-foreground">{item.recommendationKey} · {item.status}</p>
                    <ActionForm action={updateActionStatusAction} className="mt-2 flex gap-2">
                      <input type="hidden" name="actionId" value={item.id} />
                      <select name="status" defaultValue={item.status} className="rounded-md border px-2 py-1">
                        <option value="OPEN">OPEN</option>
                        <option value="DONE">DONE</option>
                        <option value="DISMISSED">DISMISSED</option>
                      </select>
                      <Button type="submit" size="sm" variant="outline">Update</Button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}
    </PageContainer>
  );
}
