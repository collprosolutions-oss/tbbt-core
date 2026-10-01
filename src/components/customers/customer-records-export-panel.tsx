import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CUSTOMER_RECORDS_EXPORT_CONTRACT,
  CUSTOMER_RECORDS_EXPORT_OMISSIONS,
  customerRecordsExportFileTruncationMessage,
  customerRecordsExportPageTruncationMessage,
  customerRecordsExportRelatedTruncationMessage,
  type CustomerRecordsExportDocument,
} from "@/lib/customer-records-export";

function downloadHref(document: CustomerRecordsExportDocument): string {
  const params = new URLSearchParams();
  if (document.provenance.page.customerId) {
    params.set("customerId", document.provenance.page.customerId);
  } else if (document.provenance.page.cursor) {
    params.set("cursor", document.provenance.page.cursor);
  }
  const query = params.toString();
  return `/customers/records-export/download${query ? `?${query}` : ""}`;
}

export function CustomerRecordsExportPanel({
  document,
}: {
  document: CustomerRecordsExportDocument;
}) {
  const nextHref = document.provenance.page.nextCursor
    ? `/customers/records-export?cursor=${encodeURIComponent(document.provenance.page.nextCursor)}`
    : null;
  const relatedTruncated = document.customers.some(
    (packet) =>
      packet.requests.truncated ||
      packet.estimates.truncated ||
      packet.jobs.truncated ||
      packet.invoices.truncated ||
      packet.payments.truncated,
  );
  const filesTruncated = document.customers.some((packet) => packet.files.truncated);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Customer records packet</CardTitle>
          <CardDescription>
            Versioned {CUSTOMER_RECORDS_EXPORT_CONTRACT} snapshot of recorded customers and their
            same-business requests, estimates, jobs, invoices, and payments. This is not the
            Settings business ZIP, not live synchronization, and not a shared database.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Workspace: {document.business.name} ({document.business.slug})
          </p>
          <p>
            Customers on this page: {document.provenance.page.count} of{" "}
            {document.provenance.page.limit}
          </p>
          {document.provenance.page.truncated ? (
            <p className="text-muted-foreground">
              {customerRecordsExportPageTruncationMessage(document.provenance.page.limit)}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {document.provenance.page.customerId
                ? "This download is one same-business customer."
                : "Every same-business customer fits on this page."}
            </p>
          )}
          {relatedTruncated ? (
            <p className="text-muted-foreground">
              {customerRecordsExportRelatedTruncationMessage(
                "Related requests, estimates, jobs, invoices, or payments",
                document.limits.relatedRecordLimit,
              )}
            </p>
          ) : null}
          {filesTruncated ? (
            <p className="text-muted-foreground">
              {customerRecordsExportFileTruncationMessage(document.limits.fileReferenceLimit)}
            </p>
          ) : (
            <p className="text-muted-foreground">
              Private files are listed as references only. Bytes and storage credentials are
              omitted.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customers on this page</CardTitle>
          <CardDescription>
            Counts are the records included in this page, after same-business checks and collection
            limits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {document.customers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This workspace has no customer records to export.
            </p>
          ) : (
            <ul className="divide-y">
              {document.customers.map((packet) => (
                <li
                  key={packet.customer.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="text-sm">
                    <p className="font-medium">{packet.customer.name}</p>
                    <p className="text-muted-foreground">
                      {packet.requests.count} requests · {packet.estimates.count} estimates ·{" "}
                      {packet.jobs.count} jobs · {packet.invoices.count} invoices ·{" "}
                      {packet.payments.count} payments · {packet.files.count} file refs
                    </p>
                  </div>
                  <Link
                    href={`/customers/${packet.customer.id}`}
                    className="text-sm underline underline-offset-4"
                  >
                    Open customer
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OWNER download</CardTitle>
          <CardDescription>
            Only the current OWNER can download this workspace packet. Secrets, portal tokens, and
            another business’s records are never included.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {CUSTOMER_RECORDS_EXPORT_OMISSIONS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <a href={downloadHref(document)}>Download JSON</a>
            </Button>
            {nextHref ? (
              <Button asChild size="sm" variant="outline">
                <Link href={nextHref}>Next page</Link>
              </Button>
            ) : null}
            <Button asChild size="sm" variant="outline">
              <Link href="/customers">Back to customers</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings?section=data-export">Settings export</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
