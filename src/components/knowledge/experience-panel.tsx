"use client";

import { useActionState } from "react";
import {
  reviewExperienceCandidateAction,
  scanExperienceCandidatesAction,
  type ExperienceActionState,
} from "@/app/actions/experience-intelligence";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EXPERIENCE_CANDIDATE_NOT_POLICY_MESSAGE } from "@/lib/experience-intelligence";
import type { KnowledgeSource } from "@/lib/knowledge-data";

const initial: ExperienceActionState = {};

export function ExperienceLearningPanel({ source }: { source: KnowledgeSource }) {
  const [scanState, scanAction, scanPending] = useActionState(scanExperienceCandidatesAction, initial);
  const [reviewState, reviewAction, reviewPending] = useActionState(reviewExperienceCandidateAction, initial);

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Experience Intelligence</CardTitle>
        <CardDescription>{EXPERIENCE_CANDIDATE_NOT_POLICY_MESSAGE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={scanAction}>
          <Button type="submit" size="sm" variant="outline" disabled={scanPending}>
            Scan recorded work
          </Button>
        </form>
        {source.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open candidate learnings.</p>
        ) : (
          source.candidates.map((candidate) => (
            <div key={candidate.id} className="rounded-md border p-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{candidate.kind}</Badge>
                <Badge>{candidate.status}</Badge>
              </div>
              <p className="font-medium">{candidate.title}</p>
              <p className="text-sm text-muted-foreground">{candidate.body}</p>
              <div className="flex flex-wrap gap-2">
                <form action={reviewAction}>
                  <input type="hidden" name="candidateId" value={candidate.id} />
                  <input type="hidden" name="status" value="APPROVED" />
                  <Button type="submit" size="sm" disabled={reviewPending}>
                    Approve into knowledge
                  </Button>
                </form>
                <form action={reviewAction}>
                  <input type="hidden" name="candidateId" value={candidate.id} />
                  <input type="hidden" name="status" value="REJECTED" />
                  <Button type="submit" size="sm" variant="outline" disabled={reviewPending}>
                    Reject
                  </Button>
                </form>
              </div>
            </div>
          ))
        )}
        {scanState.error || reviewState.error ? (
          <p className="text-xs text-destructive">{scanState.error || reviewState.error}</p>
        ) : null}
        {scanState.message || reviewState.message ? (
          <p className="text-xs text-muted-foreground">{scanState.message || reviewState.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
