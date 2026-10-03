import { Badge } from "@/components/ui/badge";
import { websiteDomainApexATargetsLabel } from "@/lib/website-engine/domain-dns-targets";
import type { WebsiteDomainVerification } from "@/lib/website-engine/domain-verification";

function statusVariant(state: WebsiteDomainVerification["state"]) {
  if (state === "VERIFIED") return "success" as const;
  if (state === "PENDING" || state === "UNVERIFIED") return "warning" as const;
  if (state === "FAILED") return "destructive" as const;
  return "outline" as const;
}

export function WebsiteDomainVerificationCard({
  verification,
}: {
  verification: WebsiteDomainVerification;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">Custom domain verification</p>
          <p className="text-xs text-muted-foreground">
            Read-only OWNER check of the newest binding. Every CNAME and A
            record must point at TBBT — a Vercel CNAME, project vercel-dns
            target, or apex A at {websiteDomainApexATargetsLabel()}. This does not
            change DNS, publish the website, or mark a typed website URL as
            connected. Public routing still uses the stored host status.
          </p>
        </div>
        <Badge variant={statusVariant(verification.state)}>{verification.label}</Badge>
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Configured host
          </dt>
          <dd>{verification.hostname ?? "None"}</dd>
        </div>
        {verification.enteredWebsiteHostname &&
        verification.enteredWebsiteHostname !== verification.hostname ? (
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Website URL host
            </dt>
            <dd className="text-muted-foreground">
              {verification.enteredWebsiteHostname} is contact text only.
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Current state
          </dt>
          <dd>{verification.detail}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Published site
          </dt>
          <dd className="text-muted-foreground">
            {verification.publishedSite
              ? "This business has a published website snapshot."
              : "No published website snapshot is on file."}
          </dd>
        </div>
      </dl>
    </div>
  );
}
