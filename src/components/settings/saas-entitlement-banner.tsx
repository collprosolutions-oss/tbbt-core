import Link from "next/link";
import {
  SaasBillingPortalButton,
  SaasSubscribeButton,
} from "@/components/settings/saas-billing-buttons";
import { SAAS_BILLING_SETTINGS_HREF } from "@/lib/saas-billing/config";
import type { SaasEntitlement } from "@/lib/saas-billing/entitlement";
import {
  SAAS_CANCELLATION_SCHEDULED_OWNER_MESSAGE,
  SAAS_CANCELLATION_SCHEDULED_TEAM_MESSAGE,
  SAAS_PAYMENT_PROBLEM_OWNER_MESSAGE,
  SAAS_PAYMENT_PROBLEM_TEAM_MESSAGE,
} from "@/lib/saas-billing/messages";
import { cn } from "@/lib/utils";

function accessThroughLabel(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function SaasEntitlementBanner({
  entitlement,
  role,
}: {
  entitlement: SaasEntitlement;
  role: "OWNER" | "ADMIN" | "MEMBER";
}) {
  const cancellationScheduled =
    entitlement.state === "subscribed_active" && entitlement.cancelAtPeriodEnd;
  if (
    entitlement.state === "legacy_exempt" ||
    (entitlement.state === "subscribed_active" && !cancellationScheduled)
  ) {
    return null;
  }

  const ownerCanManage = role === "OWNER";
  const tone =
    entitlement.state === "subscription_required"
      ? "border-destructive/40 bg-destructive/5"
      : entitlement.state === "payment_problem" || cancellationScheduled
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-primary/30 bg-primary/5";
  const periodLabel = accessThroughLabel(entitlement.currentPeriodEnd);

  return (
    <div className={cn("mb-6 rounded-xl border px-4 py-3", tone)}>
      <p className="text-sm font-medium">{entitlement.label}</p>
      <p className="mt-1 text-sm text-muted-foreground">{entitlement.detail}</p>
      {cancellationScheduled ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {ownerCanManage
            ? SAAS_CANCELLATION_SCHEDULED_OWNER_MESSAGE
            : SAAS_CANCELLATION_SCHEDULED_TEAM_MESSAGE}
          {periodLabel ? ` Access through ${periodLabel}.` : ""}
        </p>
      ) : null}
      {entitlement.state === "payment_problem" ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {ownerCanManage
            ? SAAS_PAYMENT_PROBLEM_OWNER_MESSAGE
            : SAAS_PAYMENT_PROBLEM_TEAM_MESSAGE}
        </p>
      ) : null}
      {entitlement.trialActive && entitlement.trialDaysRemaining != null ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Trial expires {entitlement.trialEndsAt
            ? new Date(entitlement.trialEndsAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "soon"}
          . {entitlement.trialDaysRemaining} day
          {entitlement.trialDaysRemaining === 1 ? "" : "s"} remaining.
        </p>
      ) : null}
      {entitlement.state === "subscription_required" ? (
        <p className="mt-1 text-sm text-muted-foreground">
          A TBBT subscription is required to keep creating or changing business records.
          Existing customers, jobs, estimates, invoices, and other records are retained.
        </p>
      ) : null}
      {ownerCanManage && entitlement.state === "subscription_required" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SaasSubscribeButton />
          <Link href={SAAS_BILLING_SETTINGS_HREF} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Open TBBT Billing
          </Link>
        </div>
      ) : ownerCanManage &&
        (entitlement.state === "payment_problem" || cancellationScheduled) ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SaasBillingPortalButton />
          <Link href={SAAS_BILLING_SETTINGS_HREF} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Open TBBT Billing
          </Link>
        </div>
      ) : ownerCanManage ? (
        <p className="mt-2 text-sm">
          <Link href={SAAS_BILLING_SETTINGS_HREF} className="font-medium text-primary underline-offset-4 hover:underline">
            Open TBBT Billing
          </Link>
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Only the business owner can start or manage the TBBT subscription.
        </p>
      )}
    </div>
  );
}
