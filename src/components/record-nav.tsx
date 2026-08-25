import Link from "next/link";
import { Button } from "@/components/ui/button";

export function RecordNav({
  customerId,
  backHref,
  backLabel,
}: {
  customerId?: string | null;
  backHref: string;
  backLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {customerId ? (
        <Button asChild size="sm" variant="outline">
          <Link href={`/customers/${customerId}`}>Open Customer</Link>
        </Button>
      ) : null}
      <Button asChild size="sm" variant="outline">
        <Link href={backHref}>{backLabel}</Link>
      </Button>
    </div>
  );
}
