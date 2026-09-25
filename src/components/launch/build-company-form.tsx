"use client";

import { useActionState, useEffect, useState } from "react";
import {
  applyCompanySetupItemAction,
  proposeCompanySetupAction,
  reviewCompanySetupItemAction,
  type CompanySetupActionState,
} from "@/app/actions/company-setup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import {
  COMPANY_SETUP_FORBIDDEN_MESSAGE,
  COMPANY_SETUP_ITEM_LABELS,
  COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE,
  isCompanySetupItemKind,
} from "@/lib/company-setup";

const initial: CompanySetupActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function BuildCompanyForm({
  proposals,
}: {
  proposals: Array<{
    id: string;
    status: string;
    inputText: string;
    proposalSummary: string;
    items: Array<{ id: string; kind: string; title: string; body: string; status: string }>;
  }>;
}) {
  const [proposeState, proposeAction, proposePending] = useActionState(proposeCompanySetupAction, initial);
  const [reviewState, reviewAction, reviewPending] = useActionState(reviewCompanySetupItemAction, initial);
  const [applyState, applyAction, applyPending] = useActionState(applyCompanySetupItemAction, initial);
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (shouldRotateAiAttemptId(proposeState)) {
      setAttemptId(newAttemptId());
    }
  }, [proposeState.error, proposeState.message, proposeState.proposalId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Describe the business</CardTitle>
          <CardDescription>{COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={proposeAction} className="space-y-3">
            <input type="hidden" name="attemptId" value={attemptId} />
            <Label htmlFor="description">Plain-language description</Label>
            <textarea
              id="description"
              name="description"
              required
              className="min-h-32 w-full rounded-md border bg-background p-2 text-sm"
              placeholder="We are a local handyman company in Reno. We fix doors, drywall, and small electrical. I want a professional but friendly voice."
            />
            <Button type="submit" disabled={proposePending}>
              Propose setup
            </Button>
          </form>
        </CardContent>
      </Card>

      {proposeState.error || reviewState.error || applyState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{proposeState.error || reviewState.error || applyState.error}</AlertDescription>
        </Alert>
      ) : null}
      {proposeState.message || reviewState.message || applyState.message ? (
        <Alert>
          <AlertDescription>{proposeState.message || reviewState.message || applyState.message}</AlertDescription>
        </Alert>
      ) : null}

      {proposals.map((proposal) => (
        <Card key={proposal.id}>
          <CardHeader>
            <CardTitle>Proposal</CardTitle>
            <CardDescription>
              {proposal.status} · {proposal.inputText.slice(0, 160)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{proposal.proposalSummary}</p>
            {proposal.items.map((item) => (
              <div key={item.id} className="rounded-md border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.status === "BLOCKED" ? "destructive" : "outline"}>
                    {isCompanySetupItemKind(item.kind)
                      ? COMPANY_SETUP_ITEM_LABELS[item.kind]
                      : item.kind}
                  </Badge>
                  <Badge>{item.status}</Badge>
                  <strong className="text-sm">{item.title}</strong>
                </div>
                <p className="text-sm">{item.body}</p>
                {item.status === "BLOCKED" ? (
                  <p className="text-sm text-muted-foreground">{COMPANY_SETUP_FORBIDDEN_MESSAGE}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {item.status === "PENDING" ? (
                      <>
                        <form action={reviewAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <input type="hidden" name="decision" value="APPROVED" />
                          <Button type="submit" size="sm" disabled={reviewPending}>
                            Approve
                          </Button>
                        </form>
                        <form action={reviewAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <input type="hidden" name="decision" value="REJECTED" />
                          <Button type="submit" size="sm" variant="outline" disabled={reviewPending}>
                            Reject
                          </Button>
                        </form>
                      </>
                    ) : null}
                    {item.status === "APPROVED" ? (
                      <form action={applyAction}>
                        <input type="hidden" name="itemId" value={item.id} />
                        <Button type="submit" size="sm" disabled={applyPending}>
                          Apply to TBBT records
                        </Button>
                      </form>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
