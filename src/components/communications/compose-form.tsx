"use client";

import { useActionState, useState } from "react";
import {
  communicationAssistAction,
  composeCommunicationAction,
  type CommunicationsActionState,
} from "@/app/actions/communications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  buildComposeFormFields,
  nextCommunicationAttemptId,
  shouldRotateCommunicationAiAttemptId,
  shouldRotateCommunicationSendAttemptId,
} from "@/lib/communications/compose-flow";
import { renderCommunicationTemplate } from "@/lib/communications/templates";
import {
  COMMUNICATION_COMPOSE_TEMPLATES,
  type CommunicationComposeTemplate,
} from "@/lib/communications/types";

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
  businessName,
}: {
  customers: Array<{
    id: string;
    name: string;
    emailPermitted: boolean;
    smsPermitted: boolean;
    emailReason: string | null;
    smsReason: string | null;
  }>;
  selectedCustomerId: string | null;
  businessName: string;
}) {
  const [customerId, setCustomerId] = useState(selectedCustomerId ?? "");
  const [template, setTemplate] = useState<CommunicationComposeTemplate>("general");
  const [channel, setChannel] = useState("EMAIL");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendAttemptId, setSendAttemptId] = useState(newAttemptId);
  const [aiAttemptId, setAiAttemptId] = useState(newAttemptId);

  const [sendState, sendAction] = useActionState(async (prev: CommunicationsActionState, formData: FormData) => {
    const result = await composeCommunicationAction(prev, formData);
    setSendAttemptId((current) =>
      nextCommunicationAttemptId(current, result, shouldRotateCommunicationSendAttemptId, newAttemptId),
    );
    return result;
  }, {});
  const [aiState, aiAction] = useActionState(async (prev: CommunicationsActionState, formData: FormData) => {
    const result = await communicationAssistAction(prev, formData);
    setAiAttemptId((current) =>
      nextCommunicationAttemptId(current, result, shouldRotateCommunicationAiAttemptId, newAttemptId),
    );
    return result;
  }, {});

  const selected = customers.find((row) => row.id === customerId) ?? null;

  function applyTemplate() {
    if (!selected) return;
    const rendered = renderCommunicationTemplate(template, {
      businessName,
      customerName: selected.name,
    });
    setSubject(rendered.subject);
    setBody(rendered.body);
  }

  return (
    <div className="space-y-4">
      <form
        action={async (formData) => {
          const fields = buildComposeFormFields({
            customerId,
            template,
            channel,
            subject,
            body,
            attemptId: sendAttemptId,
            relatedType: String(formData.get("relatedType") ?? ""),
            relatedId: String(formData.get("relatedId") ?? ""),
          });
          formData.set("customerId", fields.customerId);
          formData.set("template", fields.template);
          formData.set("channel", fields.channel);
          formData.set("subject", fields.subject);
          formData.set("body", fields.body);
          formData.set("attemptId", fields.attemptId);
          await sendAction(formData);
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="compose-customer">Customer</Label>
            <select
              id="compose-customer"
              name="customerId"
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
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
              value={template}
              onChange={(event) => setTemplate(event.target.value as CommunicationComposeTemplate)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              {COMMUNICATION_COMPOSE_TEMPLATES.map((item) => (
                <option key={item} value={item}>
                  {TEMPLATE_LABELS[item]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={applyTemplate}>
          Fill template
        </Button>
        <div className="space-y-1">
          <Label htmlFor="compose-channel">Channel</Label>
          <select
            id="compose-channel"
            name="channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="EMAIL">Email</option>
            <option value="SMS">SMS</option>
            <option value="MANUAL">Manual note</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          Email {selected?.emailPermitted ? "is available" : `unavailable: ${selected?.emailReason ?? "choose a customer"}`}.
          SMS {selected?.smsPermitted ? "is available" : `unavailable: ${selected?.smsReason ?? "choose a customer"}`}.
          Server re-evaluates eligibility at send time.
        </p>
        <div className="space-y-1">
          <Label htmlFor="compose-subject">Subject</Label>
          <Input
            id="compose-subject"
            name="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="compose-body">Message</Label>
          <textarea
            id="compose-body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={6}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
        <input type="hidden" name="attemptId" value={sendAttemptId} />
        <Button type="submit" size="sm">
          Send or record
        </Button>
        {sendState.error ? <p className="text-sm text-destructive">{sendState.error}</p> : null}
        {sendState.message ? <p className="text-sm text-muted-foreground">{sendState.message}</p> : null}
      </form>

      <form
        action={async (formData) => {
          formData.set("customerId", customerId);
          formData.set("attemptId", aiAttemptId);
          formData.set("original", body);
          formData.set("context", body);
          await aiAction(formData);
        }}
        className="space-y-2 rounded-md border border-border/70 p-3"
      >
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
        <input type="hidden" name="customerId" value={customerId} />
        <input type="hidden" name="attemptId" value={aiAttemptId} />
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
