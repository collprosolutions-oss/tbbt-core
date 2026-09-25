"use client";

import { useActionState, useMemo, useState } from "react";
import {
  applyCommunicationTemplateAction,
  communicationAssistAction,
  composeCommunicationAction,
  type CommunicationsActionState,
} from "@/app/actions/communications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COMMUNICATION_COMPOSE_TEMPLATES,
  type CommunicationComposeTemplate,
} from "@/lib/communications/types";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";

const TEMPLATE_LABELS: Record<CommunicationComposeTemplate, string> = {
  estimate_follow_up: "Estimate follow-up",
  appointment_reminder: "Appointment reminder",
  job_update: "Job update",
  invoice_reminder: "Invoice reminder",
  review_request: "Review request",
  general: "General customer message",
};

function newAttemptId() {
  return crypto.randomUUID();
}

export function ComposeCommunicationForm({
  customers,
  selectedCustomerId,
  emailReason,
  smsReason,
  emailPermitted,
  smsPermitted,
}: {
  customers: Array<{ id: string; name: string }>;
  selectedCustomerId: string | null;
  emailReason: string | null;
  smsReason: string | null;
  emailPermitted: boolean;
  smsPermitted: boolean;
}) {
  const [sendAttemptId, setSendAttemptId] = useState(newAttemptId);
  const [aiAttemptId, setAiAttemptId] = useState(newAttemptId);
  const [sendState, sendAction] = useActionState(composeCommunicationAction, {});
  const [templateState, templateAction] = useActionState(applyCommunicationTemplateAction, {});
  const [aiState, aiAction] = useActionState(communicationAssistAction, {});
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");

  const suggestion = aiState.text ?? templateState.text ?? "";
  const filled = useMemo(() => {
    if (!suggestion) return { subject: "", body: "" };
    const [first, ...rest] = suggestion.split("\n\n");
    if (rest.length === 0) return { subject, body: suggestion };
    return { subject: first, body: rest.join("\n\n") };
  }, [suggestion, subject]);

  return (
    <div className="space-y-4">
      <form action={templateAction} className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="compose-customer">Customer</Label>
          <select
            id="compose-customer"
            name="customerId"
            defaultValue={selectedCustomerId ?? ""}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            required
          >
            <option value="">Select a customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="compose-template">Template</Label>
          <select
            id="compose-template"
            name="template"
            defaultValue="general"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {COMMUNICATION_COMPOSE_TEMPLATES.map((template) => (
              <option key={template} value={template}>
                {TEMPLATE_LABELS[template]}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <Button type="submit" size="sm" variant="outline">
            Fill template
          </Button>
        </div>
      </form>

      <form
        action={async (formData) => {
          formData.set("body", body || filled.body);
          formData.set("subject", subject || filled.subject);
          formData.set("attemptId", sendAttemptId);
          await sendAction(formData);
          if (shouldRotateAiAttemptId(sendState)) {
            setSendAttemptId(newAttemptId());
          }
        }}
        className="space-y-3"
      >
        <input type="hidden" name="customerId" value={selectedCustomerId ?? ""} />
        <input type="hidden" name="template" value="general" />
        <div className="space-y-1">
          <Label htmlFor="compose-channel">Channel</Label>
          <select
            id="compose-channel"
            name="channel"
            defaultValue="EMAIL"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="EMAIL">Email</option>
            <option value="SMS">SMS</option>
            <option value="MANUAL">Manual note</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          Email {emailPermitted ? "is available" : `unavailable: ${emailReason}`}. SMS{" "}
          {smsPermitted ? "is available" : `unavailable: ${smsReason}`}.
        </p>
        <div className="space-y-1">
          <Label htmlFor="compose-subject">Subject</Label>
          <Input
            id="compose-subject"
            value={subject || filled.subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="compose-body">Message</Label>
          <textarea
            id="compose-body"
            value={body || filled.body}
            onChange={(event) => setBody(event.target.value)}
            rows={6}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
        <Button type="submit" size="sm">
          Send or record
        </Button>
        {sendState.error ? <p className="text-sm text-destructive">{sendState.error}</p> : null}
        {sendState.message ? <p className="text-sm text-muted-foreground">{sendState.message}</p> : null}
      </form>

      <form
        action={async (formData) => {
          formData.set("attemptId", aiAttemptId);
          formData.set("original", body || filled.body);
          await aiAction(formData);
          if (shouldRotateAiAttemptId(aiState)) {
            setAiAttemptId(newAttemptId());
          }
        }}
        className="space-y-2 rounded-md border border-border/70 p-3"
      >
        <input type="hidden" name="customerId" value={selectedCustomerId ?? ""} />
        <p className="text-sm font-medium">AI assist (suggestion only)</p>
        <select
          name="aiAction"
          defaultValue="draft"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="draft">Draft message</option>
          <option value="rewrite">Rewrite tone</option>
          <option value="summarize">Summarize conversation</option>
          <option value="follow_up">Suggest follow-up</option>
        </select>
        <input type="hidden" name="context" value={body || filled.body} />
        <Button type="submit" size="sm" variant="outline">
          Generate suggestion
        </Button>
        {aiState.text ? (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap text-sm">{aiState.text}</p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setBody(aiState.text ?? "");
              }}
            >
              Apply suggestion
            </Button>
          </div>
        ) : null}
        {aiState.message ? <p className="text-xs text-muted-foreground">{aiState.message}</p> : null}
        {aiState.error ? <p className="text-sm text-destructive">{aiState.error}</p> : null}
      </form>
    </div>
  );
}
