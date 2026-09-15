import Link from "next/link";
import { SaasSubscribeButton } from "@/components/settings/saas-billing-buttons";
import { SAAS_BILLING_SETTINGS_HREF } from "@/lib/saas-billing/config";
import type { SaasEntitlement } from "@/lib/saas-billing/entitlement";
import { cn } from "@/lib/utils";

export function SaasEntitlementBanner({
  entitlement,
  role,
}: {
  entitlement: SaasEntitlement;
  role: "OWNER" | "ADMIN" | "MEMBER";
}) {
  if (entitlement.state === "legacy_exempt" || entitlement.state === "subscribed_active") {
    return null;
  }

  const ownerCanSubscribe = role === "OWNER";
  const tone =
    entitlement.state === "subscription_required"
      ? "border-destructive/40 bg-destructive/5"
      : entitlement.state === "payment_problem"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-primary/30 bg-primary/5";

  return (
    <div className={cn("mb-6 rounded-xl border px-4 py-3", tone)}>
      <p className="text-sm font-medium">{entitlement.label}</p>
      <p className="mt-1 text-sm text-muted-foreground">{entitlement.detail}</p>
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
          The free trial has ended and a subscription is required to keep creating or changing
          business records. Existing customers, jobs, estimates, invoices, and other records are
          retained.
        </p>
      ) : null}
      {ownerCanSubscribe && entitlement.state === "subscription_required" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SaasSubscribeButton />
          <Link href={SAAS_BILLING_SETTINGS_HREF} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Open TBBT Billing
          </Link>
        </div>
      ) : ownerCanSubscribe ? (
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
