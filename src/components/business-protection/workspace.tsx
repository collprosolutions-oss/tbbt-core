"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import {
  acknowledgeAgreementLegalReviewAction,
  agreementAssistAction,
  completeAgreementAction,
  createAgreementAction,
  createVaultRecordAction,
  generateAgreementDraftAction,
  markAgreementOwnerReviewedAction,
  markAgreementReadyAction,
  markAgreementSentAction,
  saveAgreementAnswersAction,
  saveAgreementDraftContentAction,
  updateVaultRecordAction,
  type ProtectionActionState,
} from "@/app/actions/business-protection";
import { VaultUploadButton } from "@/components/business-protection/upload-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE,
  EXPIRY_STATE_LABELS,
  NO_FAKE_ESIGN_MESSAGE,
  PROTECTION_AREA_LABELS,
  PROTECTION_AREAS,
  VAULT_CATEGORIES,
  VAULT_CATEGORY_LABELS,
} from "@/lib/business-protection";
import {
  AGREEMENT_QUESTION_SETS,
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_LABELS,
  isHighRiskAgreement,
  type AgreementType,
} from "@/lib/business-protection-agreements";
import { selectedAgreementRisk, type ProtectionWorkspace } from "@/lib/business-protection-data";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const initial: ProtectionActionState = {};

function hrefWith(source: ProtectionWorkspace, patch: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  const next = {
    area: source.query.area === "dashboard" ? "" : source.query.area,
    q: source.query.q,
    selected: source.query.selected,
    ...patch,
  };
  if (next.area) params.set("area", next.area);
  if (next.q) params.set("q", next.q);
  if (next.selected) params.set("selected", next.selected);
  const query = params.toString();
  return query ? `/business-protection?${query}` : "/business-protection";
}

function ExpiryBadge({ state }: { state: keyof typeof EXPIRY_STATE_LABELS }) {
  const variant =
    state === "EXPIRED" ? "destructive" : state === "EXPIRING_SOON" || state === "MISSING_DATE" ? "warning" : "outline";
  return <Badge variant={variant}>{EXPIRY_STATE_LABELS[state]}</Badge>;
}

function FormMessage({ state }: { state: ProtectionActionState }) {
  if (state.error) return <p className="text-sm text-destructive">{state.error}</p>;
  if (state.message) return <p className="text-sm text-muted-foreground">{state.message}</p>;
  return null;
}

export function BusinessProtectionWorkspace({
  source,
  canFinalize,
}: {
  source: ProtectionWorkspace;
  canFinalize: boolean;
}) {
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-3">
        {PROTECTION_AREAS.map((area) => {
          const active = source.area === area;
          return (
            <Link
              key={area}
              href={hrefWith(source, { area: area === "dashboard" ? "" : area, selected: undefined })}
              className={cn(
                "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {PROTECTION_AREA_LABELS[area]}
            </Link>
          );
        })}
      </nav>

      {source.area === "dashboard" ? <DashboardPanel source={source} /> : null}
      {source.area === "vault" ? <VaultPanel source={source} /> : null}
      {source.area === "agreements" ? (
        <AgreementPanel source={source} canFinalize={canFinalize} />
      ) : null}
    </div>
  );
}

function DashboardPanel({ source }: { source: ProtectionWorkspace }) {
  const d = source.dashboard;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FactCard label="Insurance records" value={String(d.insuranceOnFile)} hint="On file — not verified with a carrier" />
          <FactCard label="Licenses / certifications" value={String(d.licensesCertsOnFile)} hint="Stored records only" />
          <FactCard label="Agreements awaiting action" value={String(d.agreementsAwaitingAction)} hint="Draft, review, ready, or sent" />
          <FactCard label="Expiring soon" value={String(d.expiringSoon)} hint="Within 30 UTC days" />
          <FactCard label="Expired" value={String(d.expired)} hint="Past the recorded date" />
          <FactCard label="Missing important dates" value={String(d.missingDates)} hint="Dated categories without an expiration" />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Continuity checklist</CardTitle>
            <CardDescription>{d.disclaimer}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.completeness.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{item.label}</span>
                <Badge variant={item.met ? "success" : "outline"}>{item.met ? `${item.count} on file` : "Missing"}</Badge>
              </div>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">{d.authorityDisclaimer}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent protection activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {source.audit.length === 0 ? <p className="text-muted-foreground">No vault or agreement changes yet.</p> : null}
          {source.audit.map((row) => (
            <div key={row.id} className="rounded-md border border-border/60 px-2 py-1.5">
              <div className="font-medium">{row.action.replaceAll("_", " ")}</div>
              <div className="text-xs text-muted-foreground">{row.changedAt.slice(0, 10)}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function FactCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}

function VaultPanel({ source }: { source: ProtectionWorkspace }) {
  const [createState, createAction, createPending] = useActionState(createVaultRecordAction, initial);
  const [editState, editAction, editPending] = useActionState(updateVaultRecordAction, initial);
  const selected = source.selectedRecord;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <Card>
        <CardHeader>
          <CardTitle>Business Vault</CardTitle>
          <CardDescription>{source.vaultPrivateMessage}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form method="get" action="/business-protection" className="flex gap-2">
            <input type="hidden" name="area" value="vault" />
            <Input name="q" defaultValue={source.query.q} placeholder="Search vault" />
            <Button type="submit" variant="outline">
              Search
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href={hrefWith(source, { q: undefined, selected: source.query.selected })}>Reset</Link>
            </Button>
          </form>
          <div className="space-y-2">
            {source.records.length === 0 ? <p className="text-sm text-muted-foreground">No vault records yet.</p> : null}
            {source.records.map((row) => (
              <Link
                key={row.id}
                href={hrefWith(source, { selected: row.id })}
                className={cn(
                  "block rounded-md border px-3 py-2 text-sm",
                  selected?.id === row.id ? "border-primary bg-primary/5" : "border-border/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{row.title}</span>
                  <ExpiryBadge state={row.expiryState} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.categoryLabel}
                  {row.expiresOn ? ` · expires ${row.expiresOn}` : ""}
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{selected ? "Edit record" : "Add vault record"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={selected ? editAction : createAction} className="space-y-3">
              {selected ? <input type="hidden" name="recordId" value={selected.id} /> : null}
              <Field id="title" label="Title" defaultValue={selected?.title} required />
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <select
                  id="category"
                  name="category"
                  defaultValue={selected?.category ?? "OTHER"}
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
                >
                  {VAULT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {VAULT_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </div>
              <Field id="issuer" label="Issuer" defaultValue={selected?.issuer ?? ""} />
              <Field id="counterparty" label="Counterparty" defaultValue={selected?.counterparty ?? ""} />
              <Field id="effectiveOn" label="Effective date" type="date" defaultValue={selected?.effectiveOn ?? ""} />
              <Field id="expiresOn" label="Expiration / renewal date" type="date" defaultValue={selected?.expiresOn ?? ""} />
              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes</Label>
                <textarea
                  id="notes"
                  name="notes"
                  defaultValue={selected?.notes ?? ""}
                  className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm"
                />
              </div>
              {selected ? (
                <div className="space-y-1.5">
                  <Label htmlFor="recordStatus">Status</Label>
                  <select
                    id="recordStatus"
                    name="recordStatus"
                    defaultValue={selected.recordStatus}
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="ARCHIVED">Archived</option>
                  </select>
                </div>
              ) : null}
              <VaultUploadButton defaultAssetId={selected?.storedAssetId ?? undefined} />
              {selected?.fileHref ? (
                <a className="text-sm underline" href={selected.fileHref}>
                  Open private file
                </a>
              ) : null}
              <Button type="submit" disabled={createPending || editPending}>
                {selected ? "Save record" : "Add to vault"}
              </Button>
              <FormMessage state={selected ? editState : createState} />
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  defaultValue,
  type = "text",
  required,
}: {
  id: string;
  label: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type={type} defaultValue={defaultValue} required={required} />
    </div>
  );
}

function AgreementPanel({
  source,
  canFinalize,
}: {
  source: ProtectionWorkspace;
  canFinalize: boolean;
}) {
  const [createState, createAction, createPending] = useActionState(createAgreementAction, initial);
  const selected = source.selectedAgreement;
  const current =
    selected?.versions.find((row) => row.id === selected.currentDraftVersionId) ??
    selected?.versions[selected.versions.length - 1];
  const risk = selectedAgreementRisk(selected);
  const type = (selected?.agreementType ?? "CUSTOMER_AGREEMENT") as AgreementType;
  const questions = AGREEMENT_QUESTION_SETS[type];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Agreements</CardTitle>
          <CardDescription>{AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form action={createAction} className="space-y-2">
            <Label htmlFor="agreementType">Start a guided agreement</Label>
            <select
              id="agreementType"
              name="agreementType"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
              defaultValue="CUSTOMER_AGREEMENT"
            >
              {AGREEMENT_TYPES.map((item) => (
                <option key={item} value={item}>
                  {AGREEMENT_TYPE_LABELS[item]}
                </option>
              ))}
            </select>
            <Input name="title" placeholder="Title (optional)" />
            <Button type="submit" disabled={createPending}>
              Start Agreement Coach
            </Button>
            <FormMessage state={createState} />
          </form>
          <div className="space-y-2">
            {source.agreements.map((row) => (
              <Link
                key={row.id}
                href={hrefWith(source, { selected: row.id })}
                className={cn(
                  "block rounded-md border px-3 py-2 text-sm",
                  selected?.id === row.id ? "border-primary bg-primary/5" : "border-border/70",
                )}
              >
                <div className="font-medium">{row.title}</div>
                <div className="text-xs text-muted-foreground">
                  {row.typeLabel} · {row.lifecycleLabel}
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {selected && current ? (
        <AgreementDetail
          selected={selected}
          current={current}
          questions={questions}
          risk={risk}
          canFinalize={canFinalize}
          esignMessage={source.esign.message}
        />
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Choose an agreement or start a new guided draft. {AGREEMENT_NOT_ENFORCEABLE_MESSAGE}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AgreementDetail({
  selected,
  current,
  questions,
  risk,
  canFinalize,
  esignMessage,
}: {
  selected: NonNullable<ProtectionWorkspace["selectedAgreement"]>;
  current: NonNullable<ProtectionWorkspace["selectedAgreement"]>["versions"][number];
  questions: (typeof AGREEMENT_QUESTION_SETS)[AgreementType];
  risk: ReturnType<typeof selectedAgreementRisk>;
  canFinalize: boolean;
  esignMessage: string;
}) {
  const [answerState, answerAction, answerPending] = useActionState(saveAgreementAnswersAction, initial);
  const [draftState, draftAction, draftPending] = useActionState(generateAgreementDraftAction, initial);
  const [contentState, contentAction, contentPending] = useActionState(saveAgreementDraftContentAction, initial);
  const [reviewState, reviewAction, reviewPending] = useActionState(markAgreementOwnerReviewedAction, initial);
  const [legalState, legalAction, legalPending] = useActionState(acknowledgeAgreementLegalReviewAction, initial);
  const [readyState, readyAction, readyPending] = useActionState(markAgreementReadyAction, initial);
  const [sentState, sentAction, sentPending] = useActionState(markAgreementSentAction, initial);
  const [completeState, completeAction, completePending] = useActionState(completeAgreementAction, initial);
  const [aiState, aiAction, aiPending] = useActionState(agreementAssistAction, initial);
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());
  const highRisk = isHighRiskAgreement(selected.agreementType as AgreementType);
  const locked = Boolean(current.lockedAt) || current.representationStatus === "SIGNED_FINAL";
  const answersJson = useMemo(() => JSON.stringify(current.answers), [current.answers]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{selected.title}</CardTitle>
          <CardDescription>
            {selected.typeLabel} · {selected.lifecycleLabel} · version {current.versionNumber} ({current.representationStatus})
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE}</p>
          {highRisk ? <p className="text-sm">{AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE}</p> : null}

          <form action={answerAction} className="space-y-3">
            <input type="hidden" name="agreementId" value={selected.id} />
            <Field id="title" label="Title" defaultValue={selected.title} />
            {questions.map((question) => (
              <div key={question.id} className="space-y-1.5">
                <Label htmlFor={`answer_${question.id}`}>
                  {question.label}
                  {question.required ? " *" : ""}
                </Label>
                {question.kind === "textarea" ? (
                  <textarea
                    id={`answer_${question.id}`}
                    name={`answer_${question.id}`}
                    defaultValue={current.answers[question.id] ?? ""}
                    disabled={locked}
                    className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm"
                  />
                ) : (
                  <Input
                    id={`answer_${question.id}`}
                    name={`answer_${question.id}`}
                    type={question.kind === "date" ? "date" : "text"}
                    defaultValue={current.answers[question.id] ?? ""}
                    disabled={locked}
                  />
                )}
              </div>
            ))}
            <Button type="submit" disabled={answerPending || locked}>
              Save answers
            </Button>
            <FormMessage state={answerState} />
          </form>

          <form action={draftAction}>
            <input type="hidden" name="agreementId" value={selected.id} />
            <Button type="submit" variant="outline" disabled={draftPending || locked}>
              Build draft from answers
            </Button>
            <FormMessage state={draftState} />
          </form>

          <form action={contentAction} className="space-y-2">
            <input type="hidden" name="agreementId" value={selected.id} />
            <Label htmlFor="draftContent">Draft content</Label>
            <textarea
              id="draftContent"
              name="draftContent"
              defaultValue={current.draftContent}
              disabled={locked}
              className="min-h-48 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 font-mono text-xs"
            />
            <Button type="submit" disabled={contentPending || locked}>
              Save draft edits
            </Button>
            <FormMessage state={contentState} />
          </form>

          {risk ? (
            <div className="space-y-1 rounded-md border border-border/70 p-3 text-sm">
              <div className="font-medium">Risk / missing-term review</div>
              {risk.findings.map((finding) => (
                <p key={`${finding.topic}-${finding.message}`} className="text-muted-foreground">
                  {finding.message}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <form action={reviewAction}>
              <input type="hidden" name="agreementId" value={selected.id} />
              <Button type="submit" variant="outline" disabled={reviewPending || locked}>
                Record owner review
              </Button>
            </form>
            {highRisk ? (
              <form action={legalAction}>
                <input type="hidden" name="agreementId" value={selected.id} />
                <input type="hidden" name="acknowledged" value="1" />
                <Button type="submit" variant="outline" disabled={legalPending || !canFinalize || locked}>
                  Acknowledge attorney-review recommendation
                </Button>
              </form>
            ) : (
              <form action={readyAction}>
                <input type="hidden" name="agreementId" value={selected.id} />
                <Button type="submit" variant="outline" disabled={readyPending || locked}>
                  Mark ready
                </Button>
              </form>
            )}
            <form action={sentAction}>
              <input type="hidden" name="agreementId" value={selected.id} />
              <Button type="submit" variant="outline" disabled={sentPending}>
                Record sent (locks this version)
              </Button>
            </form>
          </div>
          <FormMessage state={reviewState} />
          <FormMessage state={legalState} />
          <FormMessage state={readyState} />
          <FormMessage state={sentState} />

          <div className="space-y-2 rounded-md border border-dashed border-border p-3">
            <p className="text-sm">{esignMessage}</p>
            <p className="text-xs text-muted-foreground">{NO_FAKE_ESIGN_MESSAGE}</p>
            {canFinalize ? (
              <form action={completeAction} className="space-y-2">
                <input type="hidden" name="agreementId" value={selected.id} />
                <Label htmlFor="mode">Completion method</Label>
                <select
                  id="mode"
                  name="mode"
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
                  defaultValue="EXTERNAL_SIGNATURE"
                >
                  <option value="EXTERNAL_SIGNATURE">External / manual signature</option>
                  <option value="MANUAL_UPLOAD">Upload signed PDF</option>
                </select>
                <VaultUploadButton />
                <Input name="notes" placeholder="Completion notes" />
                <Button type="submit" disabled={completePending}>
                  Mark signed / complete
                </Button>
                <FormMessage state={completeState} />
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">Only the owner can finalize a sensitive agreement.</p>
            )}
            {selected.completedAt ? (
              <p className="text-xs">
                Marked complete {formatDateTime(new Date(selected.completedAt))}
                {selected.completedByMembershipId ? " by the owner who recorded completion." : "."}
              </p>
            ) : null}
          </div>

          <form
            action={aiAction}
            className="space-y-2 rounded-md border border-border/70 p-3"
            onSubmit={() => setAttemptId(crypto.randomUUID())}
          >
            <input type="hidden" name="agreementId" value={selected.id} />
            <input type="hidden" name="agreementType" value={selected.agreementType} />
            <input type="hidden" name="answersJson" value={answersJson} />
            <input type="hidden" name="attemptId" value={attemptId} />
            <input type="hidden" name="text" value={current.draftContent} />
            <div className="text-sm font-medium">AI assistance (does not authorize or sign)</div>
            <select
              name="aiAction"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
              defaultValue="SUMMARIZE"
            >
              <option value="EXPLAIN">Explain terms in plain language</option>
              <option value="SUMMARIZE">Summarize this draft</option>
              <option value="MISSING">Identify missing topics</option>
              <option value="REWRITE">Rewrite owner-provided language</option>
            </select>
            <Button type="submit" variant="outline" disabled={aiPending}>
              Ask for help
            </Button>
            <FormMessage state={aiState} />
            {aiState.aiText ? <p className="whitespace-pre-wrap text-sm">{aiState.aiText}</p> : null}
          </form>

          <div className="text-xs text-muted-foreground">
            Versions:{" "}
            {selected.versions
              .map((row) => `v${row.versionNumber} ${row.representationStatus}${row.lockedAt ? " locked" : ""}`)
              .join(" · ")}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
