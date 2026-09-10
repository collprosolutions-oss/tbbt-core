import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { PaymentsGoLiveExplanation } from "@/lib/payments/go-live";

export function OwnerPaymentsGoLiveBanner({
  explanation,
  showSettingsLink = true,
}: {
  explanation: PaymentsGoLiveExplanation;
  showSettingsLink?: boolean;
}) {
  if (!explanation.showOwnerBanner) {
    return null;
  }

  return (
    <Alert>
      <AlertTitle>{explanation.headline}</AlertTitle>
      <AlertDescription>
        <p>{explanation.detail}</p>
        {showSettingsLink ? (
          <div className="pt-2">
            <Button asChild size="sm" variant="outline">
              <Link href={explanation.settingsHref}>Open Estimates & Payments</Link>
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
