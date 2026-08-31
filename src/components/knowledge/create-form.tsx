"use client";

import { useActionState, useState } from "react";
import { createKnowledgeEntryAction, type KnowledgeActionState } from "@/app/actions/knowledge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AREA_TO_CATEGORY,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_SOURCE_KIND_LABELS,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_SOURCE_TYPE_LABELS,
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_TRUST_LABELS,
  KNOWLEDGE_TRUST_STATES,
  type KnowledgeArea,
} from "@/lib/knowledge";
import type { KnowledgeSource } from "@/lib/knowledge-data";

const initial: KnowledgeActionState = {};

function sourceOptions(source: KnowledgeSource) {
  return [
    ...source.sources.servicesList.map((row) => ({
      kind: "SERVICE" as const,
      id: row.id,
      label: `Service · ${row.name}`,
    })),
    ...source.sources.approvedEstimatesList.map((row) => ({
      kind: "ESTIMATE" as const,
      id: row.id,
      label: `Estimate · ${row.scope}`,
    })),
    ...source.sources.completedJobsList.map((row) => ({
      kind: "JOB" as const,
      id: row.id,
      label: `Job · ${row.work}`,
    })),
    ...source.sources.expensesList.map((row) => ({
      kind: "EXPENSE" as const,
      id: row.id,
      label: `Expense · ${row.description}${row.vendor ? ` (${row.vendor})` : ""}`,
    })),
    ...source.sources.approvedTimeList.map((row) => ({
      kind: "TIME" as const,
      id: row.id,
      label: `Approved time · ${row.activityType}`,
    })),
    ...source.sources.marketingList.map((row) => ({
      kind: "MARKETING" as const,
      id: row.id,
      label: `Marketing · ${row.title}`,
    })),
    ...source.sources.reviewsList.map((row) => ({
      kind: "REVIEW" as const,
      id: row.id,
      label: `Review · ${row.customerName}`,
    })),
  ];
}

export function KnowledgeCreateForm({
  area,
  source,
}: {
  area: KnowledgeArea;
  source: KnowledgeSource;
}) {
  const [state, formAction, pending] = useActionState(createKnowledgeEntryAction, initial);
  const [sourceType, setSourceType] = useState("OWNER_CREATED");
  const [sourceKind, setSourceKind] = useState("");
  const defaultCategory = area === "overview" ? "JOB_PROCEDURES" : AREA_TO_CATEGORY[area];
  const options = sourceOptions(source).filter((row) => !sourceKind || row.kind === sourceKind);

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="knowledge-category">Category</Label>
        <select
          id="knowledge-category"
          name="category"
          defaultValue={defaultCategory}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {KNOWLEDGE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {KNOWLEDGE_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="knowledge-title">Title</Label>
        <Input id="knowledge-title" name="title" required placeholder="What should the business remember?" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="knowledge-body">Knowledge / Notes</Label>
        <textarea
          id="knowledge-body"
          name="body"
          required
          rows={5}
          placeholder="Owner-recorded operational knowledge. TBBT will not invent this."
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="knowledge-source-type">Source type</Label>
          <select
            id="knowledge-source-type"
            name="sourceType"
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {KNOWLEDGE_SOURCE_TYPES.filter((item) => item !== "SYSTEM_DERIVED").map((item) => (
              <option key={item} value={item}>
                {KNOWLEDGE_SOURCE_TYPE_LABELS[item]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="knowledge-trust">Confidence / trust</Label>
          <select
            id="knowledge-trust"
            name="trustState"
            defaultValue="UNKNOWN"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {KNOWLEDGE_TRUST_STATES.map((state) => (
              <option key={state} value={state}>
                {KNOWLEDGE_TRUST_LABELS[state]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {sourceType === "TBBT_RECORD" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="knowledge-source-kind">Record type</Label>
            <select
              id="knowledge-source-kind"
              name="sourceKind"
              value={sourceKind}
              onChange={(event) => setSourceKind(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Select a record type</option>
              {KNOWLEDGE_SOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KNOWLEDGE_SOURCE_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="knowledge-source-ref">This-business record</Label>
            <select
              id="knowledge-source-ref"
              name="sourceReferenceId"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              defaultValue=""
            >
              <option value="">Select a record</option>
              {options.map((row) => (
                <option key={`${row.kind}:${row.id}`} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      {sourceType === "EXTERNAL_REFERENCE" || sourceType === "OWNER_CREATED" || sourceType === "TBBT_RECORD" ? (
        <div className="space-y-1.5">
          <Label htmlFor="knowledge-source-label">Source label{sourceType === "EXTERNAL_REFERENCE" ? "" : " (optional)"}</Label>
          <Input
            id="knowledge-source-label"
            name="sourceLabel"
            placeholder={
              sourceType === "EXTERNAL_REFERENCE"
                ? "Citation or URL text — TBBT does not research this"
                : "Optional label"
            }
          />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Verified requires a supporting TBBT record or external reference. Owner-typed text is not verified automatically.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save knowledge"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
