"use client";

import { useActionState } from "react";
import {
  requestPortalJobCustomerIssue,
  type PortalJobCustomerIssueActionState,
} from "@/app/actions/portal-job-customer-issue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  JOB_CUSTOMER_ISSUE_CATEGORIES,
  JOB_CUSTOMER_ISSUE_CATEGORY_LABELS,
  JOB_CUSTOMER_ISSUE_PORTAL_WORKFLOW_MESSAGE,
  JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT,
  JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT_LABELS,
  MAX_PORTAL_JOB_CUSTOMER_ISSUE_DESCRIPTION_LENGTH,
} from "@/lib/job-customer-issue";

const initialState: PortalJobCustomerIssueActionState = {};

export function ReportJobIssueForm({
  projectToken,
  attachableDocuments,
}: {
  projectToken: string;
  attachableDocuments: Array<{ id: string; originalFilename: string }>;
}) {
  const [state, formAction, pending] = useActionState(
    requestPortalJobCustomerIssue,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectToken" value={projectToken} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="portal-issue-category">What kind of issue is this?</Label>
        <select
          id="portal-issue-category"
          name="category"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="QUALITY_CONCERN"
        >
          {JOB_CUSTOMER_ISSUE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {JOB_CUSTOMER_ISSUE_CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="portal-issue-description">What should we review?</Label>
        <textarea
          id="portal-issue-description"
          name="description"
          required
          rows={4}
          maxLength={MAX_PORTAL_JOB_CUSTOMER_ISSUE_DESCRIPTION_LENGTH}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Describe the concern in a few sentences."
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="portal-issue-preferred-contact">Preferred contact</Label>
        <select
          id="portal-issue-preferred-contact"
          name="preferredContact"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="PHONE"
        >
          {JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT.map((value) => (
            <option key={value} value={value}>
              {JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      {attachableDocuments.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            Attach a private document already on this project
          </legend>
          {attachableDocuments.map((document) => (
            <label key={document.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="storedAssetIds" value={document.id} />
              <span>{document.originalFilename}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="text-xs text-muted-foreground">{JOB_CUSTOMER_ISSUE_PORTAL_WORKFLOW_MESSAGE}</p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Sending…" : "Send issue report"}
      </Button>
    </form>
  );
}
