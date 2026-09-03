import type { ReactNode } from "react";
import Link from "next/link";
import { ExportCustomersButton } from "@/components/customers/export-customers-button";
import { FounderRegion } from "@/components/founder-design/region";
import { BusinessProfileForm } from "@/components/settings/business-profile-form";
import { WebsitePhotosEditor } from "@/components/settings/website-photos-editor";
import { WebsiteStoryForm } from "@/components/settings/website-story-form";
import { ConnectStripeButton } from "@/components/settings/connect-stripe-button";
import { LaborMinimumSettingsForm } from "@/components/settings/labor-minimum-settings-form";
import { PreferenceSettingsForm } from "@/components/settings/preference-settings-form";
import type { SettingsWorkspaceProps } from "@/components/settings/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import {
  ACCOUNT_DELETION_UNAVAILABLE_MESSAGE,
  DOCUMENT_STORAGE_DEFERRED_MESSAGE,
  EMAIL_DELIVERY_UNCONFIGURED_MESSAGE,
  EMERGENCY_SECURITY_LOCK_DEFERRED_MESSAGE,
  FULL_EXPORT_PLANNED_MESSAGE,
  INTEGRATION_STATUS_LABELS,
  LABOR_MINIMUM_FUTURE_RULE_MESSAGE,
  PAYMENT_PROVIDER_CONNECTED_MESSAGE,
  PAYMENT_PROVIDER_DISCONNECTED_MESSAGE,
  PAYMENT_PROVIDER_PLATFORM_UNCONFIGURED_MESSAGE,
  PAYMENT_PROVIDER_SETUP_REQUIRED_MESSAGE,
  PAYMENT_PROVIDER_STATUS_LABELS,
  PAYROLL_PROVIDER_DISCONNECTED_MESSAGE,
  PROJECTED_BALANCE_UNAVAILABLE_MESSAGE,
  SCHEDULING_DEFAULTS_DEFERRED_MESSAGE,
  SETTINGS_READINESS_LABELS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTIONS,
  SMS_DELIVERY_UNAVAILABLE_MESSAGE,
  type SettingsReadinessStatus,
  type SettingsSection,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

function readinessVariant(status: SettingsReadinessStatus) {
  if (status === "configured") return "success" as const;
  if (status === "needs_setup") return "warning" as const;
  if (status === "not_connected") return "outline" as const;
  return "secondary" as const;
}

function ReadinessBadge({ status }: { status: SettingsReadinessStatus }) {
  return <Badge variant={readinessVariant(status)}>{SETTINGS_READINESS_LABELS[status]}</Badge>;
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function DeferredField({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Badge variant="secondary">Unavailable / deferred</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function SettingsNav({ section }: { section: SettingsSection }) {
  return (
    <nav className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
      {SETTINGS_SECTIONS.map((item) => {
        const href = item === "overview" ? "/settings" : `/settings?section=${item}`;
        const active = item === section;
        return (
          <Link
            key={item}
            href={href}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {SETTINGS_SECTION_LABELS[item]}
          </Link>
        );
      })}
    </nav>
  );
}

function OverviewSection({
  readiness,
}: {
  readiness: SettingsWorkspaceProps["readiness"];
}) {
  return (
    <div className="space-y-4">
      <SectionCard
        title="Business setup"
        description={`${readiness.requiredReady} of ${readiness.requiredTotal} required areas are configured. This percentage is only those required checks — not an AI score.`}
      >
        <p className="text-3xl font-semibold tabular-nums">{readiness.readyPercent}%</p>
        <p className="text-sm text-muted-foreground">
          Required areas: business identity, active team membership, and the existing security model.
        </p>
      </SectionCard>
      <div className="grid gap-3 sm:grid-cols-2">
        {readiness.items.map((item) => (
          <Link
            key={item.id}
            href={item.section === "overview" ? "/settings" : `/settings?section=${item.section}`}
            className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{item.label}</p>
              <ReadinessBadge status={item.status} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function SectionBody(props: SettingsWorkspaceProps) {
  const {
    section,
    snapshot,
    readiness,
    integrations,
    canEditConsequential,
    canEditPreferences,
    websitePhotos,
  } = props;

  if (section === "overview") {
    return <OverviewSection readiness={readiness} />;
  }

  if (section === "website-photos") {
    return (
      <SectionCard
        title="Edit Website Photos"
        description="Owner and admin only. Replace, reposition, or reset Home, Services, and About marketing photos. This is not a page builder."
      >
        {websitePhotos ? (
          <WebsitePhotosEditor
            businessId={snapshot.business.id}
            slots={websitePhotos.slots}
            storageConfigured={websitePhotos.storageConfigured}
            canEdit={canEditPreferences}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Website photo slots are not available.</p>
        )}
      </SectionCard>
    );
  }

  if (section === "website-story") {
    return (
      <SectionCard
        title="Website Story"
        description="Owner and admin only. Raw background stays private until you approve public About copy."
      >
        {canEditPreferences ? (
          <WebsiteStoryForm
            businessId={snapshot.business.id}
            rawOwnerStory={snapshot.websiteStory.rawOwnerStory}
            approvedPublicAboutCopy={snapshot.websiteStory.approvedPublicAboutCopy}
            canEdit={canEditPreferences}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Members cannot manage Website Story or public About copy.
          </p>
        )}
      </SectionCard>
    );
  }

  if (section === "profile") {
    return (
      <div className="space-y-4">
        <SectionCard
          title="Business identity"
          description="Uses the existing Business record. Tenant scope comes from the signed-in workspace, never a browser-submitted business id."
        >
          <BusinessProfileForm name={snapshot.business.name} canEdit={canEditConsequential} />
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Trade / type</dt>
              <dd className="font-medium">{snapshot.business.tradeLabel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Workspace slug</dt>
              <dd className="font-medium">{snapshot.business.slug}</dd>
            </div>
          </dl>
          {snapshot.business.logoSrc ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Brand / logo already on file for this slug.</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={snapshot.business.logoSrc} alt="" className="h-16 w-auto" />
            </div>
          ) : (
            <DeferredField
              label="Brand / logo"
              detail="No logoUrl field exists on Business. A logo appears here only when the existing slug map already has one."
            />
          )}
          <DeferredField label="Phone" detail="Not stored on the Business record yet." />
          <DeferredField label="Email" detail="Not stored on the Business record yet." />
          <DeferredField label="Website" detail="Not stored on the Business record yet." />
          <DeferredField label="Business address" detail="Not stored on the Business record yet." />
          <DeferredField label="Service area" detail="Not stored as a business-level field yet." />
        </SectionCard>
      </div>
    );
  }

  if (section === "team") {
    return (
      <SectionCard
        title="Team & Permissions"
        description="Existing User / Membership / Role records for this workspace only. Team onboarding is unchanged."
      >
        <div className="space-y-2">
          {snapshot.team.map((member) => (
            <div key={member.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <div>
                <p className="font-medium">{member.name}</p>
                <p className="text-sm text-muted-foreground">{member.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={member.active ? "success" : "outline"}>{member.active ? "Active" : "Inactive"}</Badge>
                <Badge variant="secondary">{member.role}</Badge>
              </div>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          OWNER has full Settings authority. ADMIN receives only explicitly delegated operational settings.
          MEMBER has no Settings access. Custom roles are not available.
        </p>
        <Button asChild variant="outline">
          <Link href="/team">Open Team management</Link>
        </Button>
      </SectionCard>
    );
  }

  if (section === "pricing") {
    return (
      <SectionCard
        title="Labor Minimum Service Fee"
        description="Business-wide pricing rule. Service-specific prices stay on Services. Changing this rule does not rewrite sent or approved work."
      >
        <LaborMinimumSettingsForm
          enabled={snapshot.business.laborMinimumEnabled}
          amount={snapshot.business.laborMinimumAmount}
          canEdit={canEditConsequential}
        />
        <p className="text-sm text-muted-foreground">{LABOR_MINIMUM_FUTURE_RULE_MESSAGE}</p>
        <Button asChild variant="outline">
          <Link href="/services">Open Services catalog</Link>
        </Button>
      </SectionCard>
    );
  }

  if (section === "scheduling") {
    return (
      <SectionCard title="Scheduling defaults" description={SCHEDULING_DEFAULTS_DEFERRED_MESSAGE}>
        <DeferredField label="Default job duration" detail="Jobs already store their own scheduledDurationMinutes. A business-wide default is not persisted yet." />
        <DeferredField label="Scheduling buffer" detail="Not in the current scheduling schema." />
        <DeferredField label="Business working hours" detail="Not in the current scheduling schema." />
        <Button asChild variant="outline">
          <Link href="/jobs">Open Schedule / Jobs</Link>
        </Button>
      </SectionCard>
    );
  }

  if (section === "estimates-payments") {
    return (
      <div className="space-y-4">
        <SectionCard
          title="Estimate lifecycle"
          description="DRAFT → SENT → APPROVED → JOB. Sent and approved versions stay immutable."
        >
          <p className="text-sm text-muted-foreground">
            No estimate setting in this build rewrites a SENT estimate, an approved EstimateVersion, a Job, or an Invoice.
          </p>
          <Button asChild variant="outline">
            <Link href="/estimates">Open Estimates</Link>
          </Button>
        </SectionCard>
        <SectionCard
          title="Payment methods"
          description="Cash, check, Zelle / bank transfer, and other offline payments stay available for owner Mark Paid."
        >
          <ul className="space-y-2 text-sm">
            {snapshot.paymentMethods.map((method) => (
              <li key={method.value} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                <span>{method.label}</span>
                <Badge variant="outline">Recorded manually</Badge>
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard
          title="Payment provider"
          description={
            snapshot.payment.status === "connected"
              ? PAYMENT_PROVIDER_CONNECTED_MESSAGE
              : snapshot.payment.status === "setup_required"
                ? PAYMENT_PROVIDER_SETUP_REQUIRED_MESSAGE
                : PAYMENT_PROVIDER_DISCONNECTED_MESSAGE
          }
        >
          <div className="space-y-3">
            <p className="text-sm font-medium">Stripe</p>
            <p className="text-sm">
              Status: {PAYMENT_PROVIDER_STATUS_LABELS[snapshot.payment.status]}
            </p>
            {!snapshot.payment.platformConfigured ? (
              <p className="text-sm text-muted-foreground">
                {PAYMENT_PROVIDER_PLATFORM_UNCONFIGURED_MESSAGE}
              </p>
            ) : null}
            {canEditPreferences ? (
              <ConnectStripeButton
                label={
                  snapshot.payment.status === "not_connected"
                    ? "Connect Stripe"
                    : "Continue Setup"
                }
                disabled={!snapshot.payment.platformConfigured}
              />
            ) : null}
          </div>
        </SectionCard>
      </div>
    );
  }

  if (section === "payroll") {
    return (
      <SectionCard
        title="Payroll readiness"
        description="Approved Time Cards → Payroll Review → Funding Check → Owner Authorization → Provider Direct Deposit → Payroll Records."
      >
        <p className="text-sm font-medium">Payroll provider: Not Connected</p>
        <p className="text-sm text-muted-foreground">{PAYROLL_PROVIDER_DISCONNECTED_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">
          Owner remains the final payroll authorization authority. Settings does not calculate taxes, store bank credentials, or move money.
        </p>
        <Button asChild variant="outline">
          <Link href="/payroll">Open Payroll</Link>
        </Button>
      </SectionCard>
    );
  }

  if (section === "banking") {
    return (
      <SectionCard
        title="Banking & projected balance"
        description="TBBT Core ↔ Integration Layer ↔ Provider Adapters. No vendor is hardcoded here."
      >
        <dl className="grid gap-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt>Bank connection</dt>
            <dd><Badge variant="outline">Not Connected</Badge></dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt>Last Verified Bank Balance</dt>
            <dd className="font-medium">Unavailable</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt>Known TBBT inflows</dt>
            <dd className="tabular-nums">{formatMoney(snapshot.bank.knownInflows)}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt>Known TBBT outflows</dt>
            <dd className="tabular-nums">{formatMoney(snapshot.bank.knownOutflows)}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt>TBBT Projected Operating Balance</dt>
            <dd className="font-medium">Unavailable</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">{PROJECTED_BALANCE_UNAVAILABLE_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">{snapshot.bank.unavailableReason}</p>
      </SectionCard>
    );
  }

  if (section === "vendors") {
    return (
      <SectionCard
        title="Vendors & purchasing"
        description="Settings foundation only. This is not a vendor-management module and is separate from recorded Expenses."
      >
        {snapshot.distinctVendors.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {snapshot.distinctVendors.map((vendor) => (
              <li key={vendor} className="rounded-lg border p-3">{vendor}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No vendor names have been recorded on expenses yet.</p>
        )}
        <DeferredField
          label="Purchasing accounts / supplier integrations"
          detail="Not implemented. Recorded expenses stay on the Expenses workspace."
        />
        <Button asChild variant="outline">
          <Link href="/expenses">Open Expenses</Link>
        </Button>
      </SectionCard>
    );
  }

  if (section === "communications") {
    return (
      <SectionCard title="Customer communication preferences">
        <p className="text-sm text-muted-foreground">{SMS_DELIVERY_UNAVAILABLE_MESSAGE}</p>
        {!snapshot.emailDeliveryConfigured ? (
          <p className="text-sm text-muted-foreground">{EMAIL_DELIVERY_UNCONFIGURED_MESSAGE}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Platform email delivery is configured for existing estimate and team messages. Settings does not send test customer messages or start outreach.
          </p>
        )}
        <PreferenceSettingsForm
          values={snapshot.preferences}
          canEdit={canEditPreferences}
          disclaimer="These flags record owner intent only. They do not send SMS, email, or review requests."
          fields={[
            { key: "estimateCommunicationEnabled", label: "Estimate communication", help: "Owner intends to communicate about estimates." },
            { key: "scheduleNotificationEnabled", label: "Schedule notifications", help: "Owner intends to notify about schedule changes." },
            { key: "invoiceCommunicationEnabled", label: "Invoice communication", help: "Owner intends to communicate about invoices." },
            { key: "reviewRequestPreferenceEnabled", label: "Review requests", help: "Owner may request reviews from the Reviews workspace. Settings never sends them." },
            { key: "marketingCommunicationEnabled", label: "Marketing communication", help: "Owner may prepare marketing content. Settings never publishes it." },
          ]}
        />
      </SectionCard>
    );
  }

  if (section === "marketing") {
    return (
      <SectionCard title="Reviews / marketing connections">
        <div className="space-y-2">
          {[
            { label: "Google Business Profile", status: "Not Connected" },
            { label: "Facebook", status: "Not Connected" },
            { label: "Instagram", status: "Not Connected" },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <span>{row.label}</span>
              <Badge variant="outline">{row.status}</Badge>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{snapshot.marketingDisconnectedMessage}</p>
        <p className="text-sm text-muted-foreground">{snapshot.reviewDisconnectedMessage}</p>
        <p className="text-sm text-muted-foreground">
          Settings does not publish content, post review responses, or request reviews automatically. Owner approval remains required for public actions.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/marketing">Open Marketing</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/reviews">Open Reviews</Link>
          </Button>
        </div>
      </SectionCard>
    );
  }

  if (section === "notifications") {
    return (
      <SectionCard title="Notification preferences">
        <PreferenceSettingsForm
          values={snapshot.preferences}
          canEdit={canEditPreferences}
          disclaimer="These are owner/admin preferences only. TBBT does not run a notification delivery engine in this build and does not poll for events."
          fields={[
            { key: "notifyEstimateEvents", label: "Estimate events", help: "Record that estimate activity should be reviewed." },
            { key: "notifyScheduleEvents", label: "Schedule events", help: "Record that schedule activity should be reviewed." },
            { key: "notifyInvoiceEvents", label: "Invoice events", help: "Record that invoice activity should be reviewed." },
            { key: "notifyPayrollEvents", label: "Payroll events", help: "Record that payroll activity should be reviewed." },
            { key: "notifyTeamEvents", label: "Team events", help: "Record that team activity should be reviewed." },
          ]}
        />
      </SectionCard>
    );
  }

  if (section === "documents") {
    return (
      <SectionCard title="Documents / policies" description={DOCUMENT_STORAGE_DEFERRED_MESSAGE}>
        <DeferredField
          label="Business document library"
          detail="No document storage model exists. Settings will not invent a second knowledge system."
        />
      </SectionCard>
    );
  }

  if (section === "integrations") {
    return (
      <SectionCard title="Integrations" description="Provider-neutral connection cards. Status comes from actual configuration only. Secrets are never shown.">
        <div className="space-y-2">
          {integrations.map((card) => (
            <div key={card.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">{card.category}</p>
                  <p className="font-medium">{card.label}</p>
                </div>
                <Badge variant={card.status === "connected" ? "success" : "outline"}>
                  {INTEGRATION_STATUS_LABELS[card.status]}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{card.detail}</p>
            </div>
          ))}
        </div>
      </SectionCard>
    );
  }

  if (section === "security") {
    const activeCount = snapshot.team.filter((member) => member.active).length;
    return (
      <SectionCard title="Security & Privacy" description="Owner-controlled. ADMIN may view this explanation; there are no security mutations in this build.">
        <ul className="space-y-2 text-sm">
          <li>Tenant isolation: every Settings read and write uses the signed-in workspace business, never a browser businessId.</li>
          <li>Role / access model: OWNER, ADMIN, MEMBER. MEMBER cannot open Settings or receive private configuration.</li>
          <li>Active team members: {activeCount}.</li>
          <li>Sensitive settings (pricing, identity, security) stay owner-confirmed or owner-only.</li>
        </ul>
        <DeferredField label="Emergency Security Lock" detail={EMERGENCY_SECURITY_LOCK_DEFERRED_MESSAGE} />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Data / Export" description="Historical business records remain preserved. Only working downloads are offered.">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <div>
            <p className="font-medium">Customers CSV</p>
            <p className="text-sm text-muted-foreground">Reuses the existing customers export for this workspace.</p>
          </div>
          <ExportCustomersButton rows={snapshot.customers} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <div>
            <p className="font-medium">Reports CSV</p>
            <p className="text-sm text-muted-foreground">Existing report exports stay on Reports.</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/reports">Open Reports</Link>
          </Button>
        </div>
        {[
          "Estimates / jobs / invoices PDF pack",
          "Expenses / payroll CSV pack",
          "Documents / policies",
          "Photo originals",
          "Full ZIP export",
        ].map((label) => (
          <div key={label} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <p className="text-sm">{label}</p>
            <Badge variant="secondary">Not Yet Available / Planned</Badge>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{FULL_EXPORT_PLANNED_MESSAGE}</p>
      <p className="text-sm text-muted-foreground">{ACCOUNT_DELETION_UNAVAILABLE_MESSAGE}</p>
    </SectionCard>
  );
}

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  const { section, readiness } = props;
  const attention = readiness.items.filter((item) => item.status === "needs_setup" || item.status === "not_connected");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
      <FounderRegion id="nav" className="tbbt-founder-box min-w-0">
        <div className="rounded-xl border bg-card p-3">
          <p className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Settings
          </p>
          <SettingsNav section={section} />
        </div>
      </FounderRegion>

      <FounderRegion id="main" className="min-w-0 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{SETTINGS_SECTION_LABELS[section]}</h2>
          <p className="text-sm text-muted-foreground">
            Current setting for this business. Changes apply going forward unless a record already stored its own values.
          </p>
        </div>
        <SectionBody {...props} />
      </FounderRegion>

      <FounderRegion id="rail" className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Readiness</CardTitle>
            <CardDescription>
              {readiness.requiredReady}/{readiness.requiredTotal} required · {readiness.readyPercent}%
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {attention.length === 0 ? (
              <p className="text-sm text-muted-foreground">Required areas are configured. Optional connections can stay Not Connected.</p>
            ) : (
              attention.map((item) => (
                <Link
                  key={item.id}
                  href={`/settings?section=${item.section}`}
                  className="flex items-start justify-between gap-2 rounded-lg border p-2 text-sm hover:bg-accent/40"
                >
                  <span>{item.label}</span>
                  <ReadinessBadge status={item.status} />
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </FounderRegion>
    </div>
  );
}
