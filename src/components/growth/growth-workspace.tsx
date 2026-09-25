import Link from "next/link";
import {
  approveReactivationAction,
  correctLeadAttributionAction,
  createGrowthActionAction,
  explainGrowthAction,
  proposeGrowthAngleAction,
  recordCampaignCostAction,
  setGrowthActionStatusAction,
} from "@/app/actions/growth";
import { ActionForm } from "@/components/action-form";
import { GrowthAttemptForm } from "@/components/growth/growth-attempt-form";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "@/lib/lead-attribution";
import { formatMoney } from "@/lib/format";
import {
  GROWTH_AREA_LABELS,
  GROWTH_AREAS,
  COLLECTED_CASH_MESSAGE,
  GROWTH_NO_AUTO_MESSAGE,
  GROWTH_NO_SPAM_MESSAGE,
  ORIGINAL_SOURCE_PRESERVED_MESSAGE,
  RECOVERY_QUEUE_LABELS,
  type GrowthArea,
} from "@/lib/growth";
import { outreachEligibilityLabel } from "@/lib/growth-engine";
import { cn } from "@/lib/utils";
import type { GrowthWorkspaceProps } from "@/components/growth/types";

export function GrowthWorkspace({ area, source }: GrowthWorkspaceProps) {
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto border-b border-border/60 pb-3">
        {GROWTH_AREAS.map((item) => {
          const query = item === "overview" ? "" : `?area=${item}`;
          const active = item === area;
          return (
            <Link
              key={item}
              href={`/growth${query}`}
              className={cn(
                "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {GROWTH_AREA_LABELS[item]}
            </Link>
          );
        })}
      </nav>

      {area === "overview" || area === "funnel" ? <FunnelBody source={source} /> : null}
      {area === "overview" || area === "attribution" ? <AttributionBody source={source} /> : null}
      {area === "overview" || area === "campaigns" ? <CampaignBody source={source} /> : null}
      {area === "recovery" ? <RecoveryBody source={source} /> : null}
      {area === "reactivation" ? <ReactivationBody source={source} /> : null}
      {area === "reviews" ? <ReviewsBody source={source} /> : null}
      {area === "referrals" ? <ReferralsBody source={source} /> : null}
      {area === "local" ? <LocalBody source={source} /> : null}
      {area === "recommendations" || area === "overview" ? <RecommendationsBody source={source} /> : null}
      {area === "social" ? <SocialBody source={source} /> : null}
    </div>
  );
}

function FunnelBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead-to-revenue funnel</CardTitle>
        <CardDescription>
          Stages appear only when recorded. Missing stages are not fabricated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {source.funnel.stages.length === 0 ? (
          <EmptyState title="No funnel records yet" description="Requests, estimates, jobs, invoices, reviews, and referrals will appear as they are recorded." />
        ) : (
          <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {source.funnel.stages.map((stage) => (
              <li key={stage.key} className="rounded-md border border-border/70 p-3">
                <p className="text-sm text-muted-foreground">{stage.label}</p>
                <p className="text-xl font-semibold">{stage.count}</p>
                {stage.amount != null ? <p className="text-sm">{formatMoney(stage.amount)}</p> : null}
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">
          {COLLECTED_CASH_MESSAGE} Invoiced is SENT + PAID. Path:{" "}
          {source.funnel.path.join(" → ")}.
        </p>
      </CardContent>
    </Card>
  );
}

function AttributionBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead source attribution</CardTitle>
        <CardDescription>{ORIGINAL_SOURCE_PRESERVED_MESSAGE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Leads</th>
                <th className="py-2 pr-3">Estimates</th>
                <th className="py-2 pr-3">Wins</th>
                <th className="py-2 pr-3">Collected</th>
              </tr>
            </thead>
            <tbody>
              {source.sources.map((row) => (
                <tr key={row.source} className="border-t border-border/60">
                  <td className="py-2 pr-3">{row.source}</td>
                  <td className="py-2 pr-3">{row.leads}</td>
                  <td className="py-2 pr-3">{row.estimates}</td>
                  <td className="py-2 pr-3">{row.wins}</td>
                  <td className="py-2 pr-3">{formatMoney(row.collectedRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {source.attributions.slice(0, 8).map((row) => (
          <div key={row.requestId} className="rounded-md border border-border/70 p-3 text-sm">
            <p className="font-medium">{row.customerName}</p>
            <p className="text-muted-foreground">
              {row.label}
              {row.source ? ` · current ${row.source}` : ""}
              {row.originalSource ? ` · original ${row.originalSource}` : ""}
              {row.landingPagePath ? ` · ${row.landingPagePath}` : ""}
            </p>
            <ActionForm action={correctLeadAttributionAction} className="mt-2 grid gap-2 sm:grid-cols-4">
              <input type="hidden" name="requestId" value={row.requestId} />
              <select name="leadSource" defaultValue={row.source ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
                <option value="">Unknown</option>
                {LEAD_SOURCES.map((item) => (
                  <option key={item} value={item}>
                    {LEAD_SOURCE_LABELS[item]}
                  </option>
                ))}
              </select>
              <Input name="landingPagePath" defaultValue={row.landingPagePath ?? ""} placeholder="Landing / local path" />
              <Input name="reason" placeholder="Correction reason" />
              <Button type="submit" size="sm">
                Correct working source
              </Button>
            </ActionForm>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CampaignBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaign performance</CardTitle>
        <CardDescription>
          ROI uses recorded collected cash and a recorded campaign cost. Average ticket is collected revenue per win.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {source.campaigns.length === 0 ? (
          <EmptyState title="No campaign records" description="Create a campaign in Marketing, then attribute requests to it." />
        ) : (
          source.campaigns.map((row) => (
            <div key={row.campaignId ?? "none"} className="rounded-md border border-border/70 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{row.name}</p>
                <Badge variant="outline">{row.costAvailable ? `ROI ${row.roi}` : "Cost/ROI unavailable"}</Badge>
              </div>
              <p className="text-muted-foreground">
                {row.leads} leads · {row.estimates} estimates · {row.wins} wins · {row.losses} losses ·
                invoiced {formatMoney(row.invoicedRevenue)} · collected {formatMoney(row.collectedRevenue)}
                {row.conversion != null ? ` · conversion ${(row.conversion * 100).toFixed(1)}%` : ""}
                {row.averageTicket != null ? ` · avg ticket ${formatMoney(row.averageTicket)}` : ""}
                {` · ${row.reviews} reviews · ${row.referrals} referrals`}
              </p>
              {row.roiMessage ? <p className="text-xs text-muted-foreground">{row.roiMessage}</p> : null}
              {row.campaignId ? (
                <ActionForm action={recordCampaignCostAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="campaignId" value={row.campaignId} />
                  <Input
                    name="recordedCost"
                    defaultValue={row.recordedCost != null ? String(row.recordedCost) : ""}
                    placeholder="Recorded cost"
                  />
                  <Button type="submit" size="sm">
                    Save cost
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          ))
        )}
        <GrowthAiPanel />
      </CardContent>
    </Card>
  );
}

function RecoveryBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lost-lead recovery</CardTitle>
        <CardDescription>{GROWTH_NO_AUTO_MESSAGE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {source.recovery.length === 0 ? (
          <EmptyState title="No recovery items" description="Open requests and sent estimates will appear here when they meet the recorded rules." />
        ) : (
          source.recovery.map((item, index) => (
            <div key={`${item.queue}-${item.requestId}-${item.estimateId}-${index}`} className="rounded-md border border-border/70 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{item.customerName}</p>
                <Badge variant="outline">{RECOVERY_QUEUE_LABELS[item.queue]}</Badge>
              </div>
              <p className="text-muted-foreground">
                {outreachEligibilityLabel(item)}
                {item.value != null ? ` · value ${formatMoney(item.value)}` : ""}
              </p>
              <GrowthAttemptForm action={createGrowthActionAction} className="mt-2">
                <input type="hidden" name="kind" value="RECOVERY" />
                <input type="hidden" name="queue" value={item.queue} />
                {item.customerId ? <input type="hidden" name="customerId" value={item.customerId} /> : null}
                {item.requestId ? <input type="hidden" name="serviceRequestId" value={item.requestId} /> : null}
                {item.estimateId ? <input type="hidden" name="estimateId" value={item.estimateId} /> : null}
                <Button type="submit" size="sm" variant="outline">
                  Queue follow-up request
                </Button>
              </GrowthAttemptForm>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ReactivationBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer reactivation</CardTitle>
        <CardDescription>{GROWTH_NO_SPAM_MESSAGE}</CardDescription>
      </CardHeader>
      <CardContent>
        {source.reactivation.length === 0 ? (
          <EmptyState title="No reactivation candidates" description="Previous customers appear after completed work, elapsed time, no active job/request, and consent checks." />
        ) : (
          <GrowthAttemptForm action={approveReactivationAction} className="space-y-3">
            {source.reactivation.map((row) => (
              <label key={row.customerId} className="flex items-start gap-2 rounded-md border border-border/70 p-3 text-sm">
                <input type="checkbox" name="customerId" value={row.customerId} disabled={!row.anyOutreachEligible} />
                <span>
                  <span className="font-medium">{row.customerName}</span>
                  <span className="block text-muted-foreground">
                    {row.completedJobs} completed jobs ·{" "}
                    {row.completionSource === "JOB_COMPLETED" && row.daysSinceCompleted != null
                      ? `${row.daysSinceCompleted} days since recorded completion`
                      : "completion clock unavailable"}{" "}
                    · {outreachEligibilityLabel(row)}
                  </span>
                </span>
              </label>
            ))}
            <Button type="submit">Owner approve selected</Button>
          </GrowthAttemptForm>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewsBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  const reviews = source.reviews;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review request conversion</CardTitle>
        <CardDescription>Completed job → request → received → response → website selection.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2">
        <p>Completed jobs: {reviews.completedJobs}</p>
        <p>Requests prepared: {reviews.requestsPrepared}</p>
        <p>Requests sent: {reviews.requestsSent}</p>
        <p>Reviews received: {reviews.reviewsReceived}</p>
        <p>Responses: {reviews.responsesRecorded}</p>
        <p>Website selected: {reviews.websiteSelected}</p>
        <p>
          Conversion:{" "}
          {reviews.requestConversion == null ? "Not enough sent requests" : `${(reviews.requestConversion * 100).toFixed(1)}%`}
        </p>
        <Link href="/reviews" className="text-sm text-primary">
          Open Reviews workspace
        </Link>
      </CardContent>
    </Card>
  );
}

function ReferralsBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Referral attribution</CardTitle>
        <CardDescription>Each referred customer is counted once.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {source.referrals.length === 0 ? (
          <EmptyState title="No recorded referrals" description="Referral requests and resulting work appear here when they are attributable." />
        ) : (
          source.referrals.map((row) => (
            <div key={row.referralId} className="rounded-md border border-border/70 p-3 text-sm">
              <p className="font-medium">
                {row.sourceCustomerName} → {row.referredCustomerName ?? "Lead not linked"}
              </p>
              <p className="text-muted-foreground">
                {row.estimates} estimates · {row.jobs} jobs · invoiced {formatMoney(row.invoicedRevenue)} ·
                collected {formatMoney(row.collectedRevenue)}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function LocalBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local / service-area growth</CardTitle>
        <CardDescription>{source.localHonesty}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {source.local.length === 0 ? (
          <EmptyState title="No service-area records" description="Configure service areas in Settings to measure local lead activity." />
        ) : (
          source.local.map((row) => (
            <div key={row.serviceAreaId ?? "missing"} className="rounded-md border border-border/70 p-3 text-sm">
              <p className="font-medium">{row.label}</p>
              <p className="text-muted-foreground">
                {row.requestCount} leads · {row.strength}
                {row.contentOpportunity ? " · content opportunity" : ""}
                {row.hasPublishedLocalPage ? " · published local page" : ""}
                {row.hasLocalPageDraft ? " · draft on file" : ""}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RecommendationsBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evidence-based next actions</CardTitle>
        <CardDescription>Every recommendation is derived from recorded TBBT facts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {source.recommendations.length === 0 ? (
          <EmptyState title="No growth recommendations" description="Recommendations appear when recorded recovery, review, campaign, or referral facts exist." />
        ) : (
          source.recommendations.map((row) => (
            <div key={row.key} className="rounded-md border border-border/70 p-3">
              <p className="font-medium">{row.title}</p>
              <p className="text-sm text-muted-foreground">{row.why}</p>
              <ul className="mt-2 text-sm">
                {row.evidence.map((fact) => (
                  <li key={fact.key}>
                    {fact.label}: {fact.value}
                  </li>
                ))}
              </ul>
              <Link href={row.href} className="text-sm text-primary">
                Open related workspace
              </Link>
            </div>
          ))
        )}
        {source.actionRequests.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Durable action requests</p>
            {source.actionRequests.map((row) => (
              <ActionForm key={row.id} action={setGrowthActionStatusAction} className="flex flex-wrap items-center gap-2 text-sm">
                <input type="hidden" name="actionId" value={row.id} />
                <span>
                  {row.kind} · {row.queue} · {row.status}
                </span>
                <select name="status" defaultValue={row.status} className="h-9 rounded-md border bg-background px-2">
                  <option value="OPEN">Open</option>
                  <option value="APPROVED">Approved</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
                <Button type="submit" size="sm" variant="outline">
                  Update
                </Button>
              </ActionForm>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SocialBody({ source }: { source: GrowthWorkspaceProps["source"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Social content planning</CardTitle>
        <CardDescription>{source.social.message}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>{source.social.channelsMessage}</p>
        <p>{source.social.manualCopy}</p>
        <p>Connected: {source.social.connected ? "yes" : "no"}</p>
        <Link href="/marketing?area=social-posts" className="text-primary">
          Open Marketing social drafts
        </Link>
      </CardContent>
    </Card>
  );
}

function GrowthAiPanel() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ActionForm action={explainGrowthAction} className="space-y-2">
        <p className="text-sm font-medium">Explain recorded performance</p>
        <Button type="submit" size="sm" variant="outline">
          Explain from facts
        </Button>
      </ActionForm>
      <ActionForm action={proposeGrowthAngleAction} className="space-y-2">
        <p className="text-sm font-medium">Propose a campaign angle</p>
        <Button type="submit" size="sm" variant="outline">
          Draft angle
        </Button>
      </ActionForm>
    </div>
  );
}

export function growthAreaLabel(area: GrowthArea) {
  return GROWTH_AREA_LABELS[area];
}
