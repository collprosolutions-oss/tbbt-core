import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  JOB_PROPERTY_EXPORT_CONTRACT,
  JOB_PROPERTY_EXPORT_OMISSIONS,
  type JobPropertyExportDocument,
} from "@/lib/job-property-export";

export function JobPropertyExportPanel({
  document,
}: {
  document: JobPropertyExportDocument;
}) {
  const downloadHref = `/jobs/${document.job.id}/handoff-export/download`;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Completed job/property packet</CardTitle>
          <CardDescription>
            Versioned {JOB_PROPERTY_EXPORT_CONTRACT} snapshot of recorded TBBT facts. This is
            not live synchronization, not a shared database, and it does not write into HQ
            Watchfolio or REIOS.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Job: {document.job.id}</p>
          <p>Property: {document.property.id}</p>
          <p>
            Address: {[document.property.addressLine1, document.property.city, document.property.region]
              .filter(Boolean)
              .join(", ") || "Not recorded"}
          </p>
          <p>Customer contact: {document.customer.included ? "included by OWNER authorization" : "redacted"}</p>
          <p>
            Photos:{" "}
            {document.photos.included
              ? `${document.photos.count} included by OWNER authorization`
              : `${document.photos.count} recorded, redacted`}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OWNER authorization</CardTitle>
          <CardDescription>
            Private customer data and photos stay redacted unless you expressly authorize them
            for this download. Access codes and photo binaries are never included.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={downloadHref} method="get" className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="includePrivateCustomer" value="1" className="mt-1" />
              <span>Include private customer name, email, and phone in this download.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="includePhotos" value="1" className="mt-1" />
              <span>Include recorded job photo metadata and URLs in this download. Binaries stay omitted.</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm">
                Download JSON
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/jobs/handoff-export">Choose another completed job</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/jobs/${document.job.id}`}>Back to work order</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Remaining limits</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {JOB_PROPERTY_EXPORT_OMISSIONS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
