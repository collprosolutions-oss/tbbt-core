"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import {
  saveIntakeConditionDraftAction,
  validateIntakeConditionDraftAction,
  type IntakeConditionActionState,
} from "@/app/actions/intake-conditionals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  INTAKE_CONDITION_ACTIONS,
  INTAKE_CONDITION_ACTION_LABELS,
  INTAKE_CONDITION_OPS,
  INTAKE_CONDITION_OP_LABELS,
  INTAKE_DRAFT_QUESTION_TYPES,
  conditionNeedsValue,
  conditionNeedsValues,
  evaluateIntakeConditionDocument,
  previewIntakeConditionForm,
  serializeIntakeConditionDocument,
  validateIntakeConditionDocument,
  validatePreviewIntakeAnswers,
  type IntakeConditionDocument,
  type IntakeConditionRule,
  type IntakeConditionWorkspaceView,
  type IntakeDraftQuestion,
} from "@/lib/intake-conditionals";
import {
  fieldIsVisible,
  intakeSchemaFromPublicProjection,
  type IntakeAnswerMap,
  type PublicIntakeSchemaProjection,
} from "@/lib/intake-schema";
import { cn } from "@/lib/utils";

const emptyAction: IntakeConditionActionState = {};

function newRuleId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rule_${Date.now().toString(36)}`;
}

function optionsText(question: IntakeDraftQuestion) {
  return (question.options ?? []).map((option) => `${option.value} | ${option.label}`).join("\n");
}

function parseOptionsText(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split("|");
      const label = rest.join("|").trim() || value.trim();
      return { value: value.trim().toUpperCase().replace(/\s+/g, "_"), label };
    });
}

function PreviewFields({
  schema,
  answers,
  onChange,
}: {
  schema: PublicIntakeSchemaProjection;
  answers: IntakeAnswerMap;
  onChange: (next: IntakeAnswerMap) => void;
}) {
  function setField(key: string, value: unknown) {
    onChange({ ...answers, [key]: value });
  }

  return (
    <div className="space-y-4">
      {schema.fields.map((field) => {
        if (
          !fieldIsVisible(
            {
              key: field.key,
              type: field.type,
              label: field.label,
              visibleWhen: field.visibleWhen ?? undefined,
            },
            answers,
          )
        ) {
          return null;
        }
        const id = `preview-${field.key}`;
        if (field.type === "YES_NO") {
          return (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={id}>
                {field.label}
                {field.required ? " *" : ""}
              </Label>
              <select
                id={id}
                className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={String(answers[field.key] ?? "")}
                onChange={(event) => setField(field.key, event.target.value)}
              >
                <option value="">Select…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
          );
        }
        if (field.type === "CHOICE" || field.type === "FREQUENCY") {
          return (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={id}>
                {field.label}
                {field.required ? " *" : ""}
              </Label>
              <select
                id={id}
                className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={String(answers[field.key] ?? "")}
                onChange={(event) => setField(field.key, event.target.value)}
              >
                <option value="">Select…</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        if (field.type === "MULTI_CHOICE") {
          const selected = Array.isArray(answers[field.key])
            ? (answers[field.key] as string[])
            : [];
          return (
            <fieldset key={field.key} className="space-y-2">
              <legend className="text-sm font-medium">
                {field.label}
                {field.required ? " *" : ""}
              </legend>
              {field.options.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(option.value)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((value) => value !== option.value);
                      setField(field.key, next);
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          );
        }
        return (
          <div key={field.key} className="space-y-2">
            <Label htmlFor={id}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            {field.type === "COUNTS" || field.type === "NUMBER" ? (
              <Input
                id={id}
                inputMode="numeric"
                value={String(answers[field.key] ?? "")}
                onChange={(event) => setField(field.key, event.target.value)}
              />
            ) : (
              <textarea
                id={id}
                rows={3}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
                value={String(answers[field.key] ?? "")}
                onChange={(event) => setField(field.key, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function IntakeConditionWorkspace({ workspace }: { workspace: IntakeConditionWorkspaceView }) {
  const [document, setDocument] = useState<IntakeConditionDocument>(workspace.document);
  const [answers, setAnswers] = useState<IntakeAnswerMap>({});
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [saveState, saveAction, savePending] = useActionState(
    saveIntakeConditionDraftAction,
    emptyAction,
  );
  const [validateState, validateAction, validatePending] = useActionState(
    validateIntakeConditionDraftAction,
    emptyAction,
  );

  const schema = useMemo(
    () => intakeSchemaFromPublicProjection(workspace.baseSchema),
    [workspace.baseSchema],
  );
  const preview = previewIntakeConditionForm(schema, document, answers);
  const draftedProjection: PublicIntakeSchemaProjection = {
    key: `${workspace.baseSchema.key}.draft`,
    version: 1,
    tradeCode: workspace.baseSchema.tradeCode,
    title: "Drafted questions",
    fields: preview.visibleQuestions.map((question) => ({
      key: question.key,
      type: question.type,
      label: question.label,
      required: question.required,
      help: question.help ?? null,
      options: question.options ?? [],
      visibleWhen: null,
    })),
  };
  const documentJson = serializeIntakeConditionDocument({
    ...document,
    tradeCode: workspace.selectedTrade,
    baseSchemaKey: workspace.baseSchema.key,
    baseSchemaVersion: workspace.baseSchema.version,
  });

  function updateQuestion(index: number, patch: Partial<IntakeDraftQuestion>) {
    setDocument((current) => ({
      ...current,
      questions: current.questions.map((question, questionIndex) =>
        questionIndex === index ? { ...question, ...patch } : question,
      ),
    }));
  }

  function updateRule(index: number, patch: Partial<IntakeConditionRule>) {
    setDocument((current) => ({
      ...current,
      rules: current.rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule,
      ),
    }));
  }

  function runLocalValidate() {
    const result = validateIntakeConditionDocument(
      {
        ...document,
        tradeCode: workspace.selectedTrade,
        baseSchemaKey: workspace.baseSchema.key,
        baseSchemaVersion: workspace.baseSchema.version,
      },
      schema,
    );
    setLocalErrors(result.ok ? [] : result.errors);
    return result.ok;
  }

  function runPreviewValidate() {
    const result = validatePreviewIntakeAnswers(schema, document, answers);
    setPreviewMessage(result.ok ? "Preview answers are valid for this draft." : result.error);
  }

  const states = evaluateIntakeConditionDocument(document, answers);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Draft-only intake conditions</CardTitle>
            <Badge variant="warning">Draft only</Badge>
          </div>
          <CardDescription>{workspace.publishNextRequirement}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          {workspace.trades.length > 1 ? (
            <div className="space-y-1">
              <Label>Trade</Label>
              <div className="flex flex-wrap gap-2">
                {workspace.trades.map((trade) => (
                  <Button key={trade.code} asChild variant={trade.code === workspace.selectedTrade ? "default" : "outline"} size="sm">
                    <Link href={`/intake-conditionals?trade=${encodeURIComponent(trade.code)}`}>
                      {trade.label}
                    </Link>
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Trade: {workspace.trades[0]?.label ?? workspace.selectedTrade}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Base schema {workspace.baseSchema.key} v{workspace.baseSchema.version}
            {workspace.savedAt ? ` · last saved ${new Date(workspace.savedAt).toLocaleString()}` : " · not saved yet"}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Extra questions</CardTitle>
              <CardDescription>
                Allowlisted types only. Keys cannot collide with platform fields.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {document.questions.map((question, index) => (
                <div key={`${question.key}-${index}`} className="space-y-3 rounded-lg border border-border/70 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Key</Label>
                      <Input
                        value={question.key}
                        onChange={(event) =>
                          updateQuestion(index, {
                            key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Type</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                        value={question.type}
                        onChange={(event) =>
                          updateQuestion(index, {
                            type: event.target.value as IntakeDraftQuestion["type"],
                          })
                        }
                      >
                        {INTAKE_DRAFT_QUESTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Label</Label>
                    <Input
                      value={question.label}
                      onChange={(event) => updateQuestion(index, { label: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Help</Label>
                    <Input
                      value={question.help ?? ""}
                      onChange={(event) => updateQuestion(index, { help: event.target.value })}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={question.required === true}
                      onChange={(event) => updateQuestion(index, { required: event.target.checked })}
                    />
                    Required when visible
                  </label>
                  {question.type === "CHOICE" || question.type === "MULTI_CHOICE" ? (
                    <div className="space-y-1">
                      <Label>Options (VALUE | Label)</Label>
                      <textarea
                        rows={4}
                        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
                        value={optionsText(question)}
                        onChange={(event) =>
                          updateQuestion(index, { options: parseOptionsText(event.target.value) })
                        }
                      />
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDocument((current) => ({
                        ...current,
                        questions: current.questions.filter((_, questionIndex) => questionIndex !== index),
                        rules: current.rules.filter((rule) => rule.questionKey !== question.key),
                      }))
                    }
                  >
                    Remove question
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDocument((current) => ({
                    ...current,
                    questions: [
                      ...current.questions,
                      {
                        key: `question_${current.questions.length + 1}`,
                        type: "TEXT",
                        label: "",
                        required: false,
                      },
                    ],
                  }))
                }
              >
                Add question
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Allowlisted rules</CardTitle>
              <CardDescription>
                Conditions may only read platform fields. Rules may only show, hide, or require a drafted question.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {document.rules.map((rule, index) => (
                <div key={rule.id} className="space-y-3 rounded-lg border border-border/70 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>When platform field</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                        value={rule.when.field}
                        onChange={(event) =>
                          updateRule(index, { when: { ...rule.when, field: event.target.value } })
                        }
                      >
                        <option value="">Select…</option>
                        {workspace.baseSchema.fields.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label>Operator</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                        value={rule.when.op}
                        onChange={(event) =>
                          updateRule(index, {
                            when: {
                              ...rule.when,
                              op: event.target.value as IntakeConditionRule["when"]["op"],
                            },
                          })
                        }
                      >
                        {INTAKE_CONDITION_OPS.map((op) => (
                          <option key={op} value={op}>
                            {INTAKE_CONDITION_OP_LABELS[op]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {conditionNeedsValue(rule.when.op) ? (
                    <div className="space-y-1">
                      <Label>Value</Label>
                      <Input
                        value={rule.when.value ?? ""}
                        onChange={(event) =>
                          updateRule(index, { when: { ...rule.when, value: event.target.value } })
                        }
                      />
                    </div>
                  ) : null}
                  {conditionNeedsValues(rule.when.op) ? (
                    <div className="space-y-1">
                      <Label>Values (comma-separated)</Label>
                      <Input
                        value={(rule.when.values ?? []).join(", ")}
                        onChange={(event) =>
                          updateRule(index, {
                            when: {
                              ...rule.when,
                              values: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            },
                          })
                        }
                      />
                    </div>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Then</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                        value={rule.action}
                        onChange={(event) =>
                          updateRule(index, {
                            action: event.target.value as IntakeConditionRule["action"],
                          })
                        }
                      >
                        {INTAKE_CONDITION_ACTIONS.map((action) => (
                          <option key={action} value={action}>
                            {INTAKE_CONDITION_ACTION_LABELS[action]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label>Drafted question</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                        value={rule.questionKey}
                        onChange={(event) => updateRule(index, { questionKey: event.target.value })}
                      >
                        <option value="">Select…</option>
                        {document.questions.map((question) => (
                          <option key={question.key} value={question.key}>
                            {question.label || question.key}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDocument((current) => ({
                        ...current,
                        rules: current.rules.filter((_, ruleIndex) => ruleIndex !== index),
                      }))
                    }
                  >
                    Remove rule
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDocument((current) => ({
                    ...current,
                    rules: [
                      ...current.rules,
                      {
                        id: newRuleId(),
                        questionKey: current.questions[0]?.key ?? "",
                        when: { field: workspace.baseSchema.fields[0]?.key ?? "", op: "EQUALS", value: "" },
                        action: "SHOW",
                      },
                    ],
                  }))
                }
              >
                Add rule
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Validate and save</CardTitle>
              <CardDescription>Saving keeps this as a draft. There is no public publish action.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={runLocalValidate}>
                  Validate draft
                </Button>
                <form action={validateAction}>
                  <input type="hidden" name="tradeCode" value={workspace.selectedTrade} />
                  <input type="hidden" name="documentJson" value={documentJson} />
                  <Button type="submit" variant="outline" disabled={validatePending}>
                    {validatePending ? "Checking…" : "Validate on server"}
                  </Button>
                </form>
                <form action={saveAction}>
                  <input type="hidden" name="tradeCode" value={workspace.selectedTrade} />
                  <input type="hidden" name="documentJson" value={documentJson} />
                  <Button type="submit" disabled={savePending}>
                    {savePending ? "Saving…" : "Save draft"}
                  </Button>
                </form>
              </div>
              {localErrors.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
                  {localErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              ) : null}
              {validateState.error ? <p className="text-sm text-destructive">{validateState.error}</p> : null}
              {validateState.message ? <p className="text-sm text-muted-foreground">{validateState.message}</p> : null}
              {saveState.error ? <p className="text-sm text-destructive">{saveState.error}</p> : null}
              {saveState.message ? <p className="text-sm text-muted-foreground">{saveState.message}</p> : null}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Interactive preview</CardTitle>
            <CardDescription>
              Platform questions stay on the existing intake engine. Drafted questions appear only when allowlisted rules match.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Platform questions</h3>
              <PreviewFields schema={workspace.baseSchema} answers={answers} onChange={setAnswers} />
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Drafted questions</h3>
              {preview.visibleQuestions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No drafted questions are visible for the current answers.
                </p>
              ) : (
                <PreviewFields schema={draftedProjection} answers={answers} onChange={setAnswers} />
              )}
              {preview.hiddenKeys.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Hidden by rules: {preview.hiddenKeys.join(", ")}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Button type="button" variant="outline" size="sm" onClick={runPreviewValidate}>
                Check preview answers
              </Button>
              {previewMessage ? (
                <p className={cn("text-sm", previewMessage.startsWith("Preview") ? "text-muted-foreground" : "text-destructive")}>
                  {previewMessage}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {Object.values(states).filter((state) => state.visible).length} visible drafted
                question{Object.values(states).filter((state) => state.visible).length === 1 ? "" : "s"}.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
