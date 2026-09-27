/**
 * Typed, allowlisted conditional questions for intake forms.
 *
 * OWNER drafts extra questions and show/hide/require rules against the
 * current platform schema. Drafts stay off public hire forms until OWNER
 * reviews and publishes an immutable TenantIntakeSnapshot. Archived
 * Cleaning public V1/V2, Handyman V1, and frozen ServiceRequest snapshots
 * keep using the existing intake engine unchanged.
 *
 * No JavaScript expressions, eval, Function, or cross-tenant reads.
 */

import {
  currentIntakeSchema,
  fieldIsVisible,
  publicIntakeSchemaProjection,
  validateIntakeAnswers,
  type IntakeAnswerMap,
  type IntakeFieldDefinition,
  type IntakeSchema,
  type PublicIntakeSchemaProjection,
} from "@/lib/intake-schema";
import { DEFAULT_TRADE, isConfiguredTrade, tradeLabel, type TradeCode } from "@/lib/trades";

export const INTAKE_CONDITION_DOCUMENT_VERSION = 1 as const;
export const INTAKE_CONDITION_STATUS_DRAFT = "DRAFT" as const;
export const INTAKE_CONDITION_STATUS_PUBLISHED = "PUBLISHED" as const;
export type IntakeConditionStatus =
  | typeof INTAKE_CONDITION_STATUS_DRAFT
  | typeof INTAKE_CONDITION_STATUS_PUBLISHED;

export const INTAKE_CONDITION_OPS = [
  "EQUALS",
  "NOT_EQUALS",
  "IN",
  "NOT_IN",
  "INCLUDES",
  "IS_YES",
  "IS_NO",
  "IS_ANSWERED",
  "IS_BLANK",
] as const;
export type IntakeConditionOp = (typeof INTAKE_CONDITION_OPS)[number];

export const INTAKE_CONDITION_ACTIONS = ["SHOW", "HIDE", "REQUIRE"] as const;
export type IntakeConditionAction = (typeof INTAKE_CONDITION_ACTIONS)[number];

export const INTAKE_DRAFT_QUESTION_TYPES = [
  "TEXT",
  "NUMBER",
  "YES_NO",
  "CHOICE",
  "MULTI_CHOICE",
  "COUNTS",
  "NOTES",
] as const;
export type IntakeDraftQuestionType = (typeof INTAKE_DRAFT_QUESTION_TYPES)[number];

export const INTAKE_CONDITION_OP_LABELS: Record<IntakeConditionOp, string> = {
  EQUALS: "equals",
  NOT_EQUALS: "does not equal",
  IN: "is one of",
  NOT_IN: "is not one of",
  INCLUDES: "includes",
  IS_YES: "is yes",
  IS_NO: "is no",
  IS_ANSWERED: "is answered",
  IS_BLANK: "is blank",
};

export const INTAKE_CONDITION_ACTION_LABELS: Record<IntakeConditionAction, string> = {
  SHOW: "Show",
  HIDE: "Hide",
  REQUIRE: "Require",
};

export const INTAKE_CONDITION_PUBLISH_DESCRIPTION =
  "Drafts are not live. OWNER review + publish creates a new immutable tenant intake snapshot. New public requests freeze that version. Historical Cleaning V1/V2, Handyman V1, and existing requests keep resolving exactly as recorded.";

export const INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED =
  "Confirm you reviewed this draft before publishing a new immutable tenant intake snapshot.";

export const INTAKE_CONDITION_DRAFT_STATUS_REQUIRED =
  "Draft documents must stay DRAFT. Published snapshots are stored separately.";

/** @deprecated Use INTAKE_CONDITION_PUBLISH_DESCRIPTION. Kept so older draft checks stay readable. */
export const INTAKE_CONDITION_PUBLISH_NEXT_REQUIREMENT = INTAKE_CONDITION_PUBLISH_DESCRIPTION;

export const MAX_INTAKE_DRAFT_QUESTIONS = 20;
export const MAX_INTAKE_DRAFT_RULES = 40;
export const MAX_INTAKE_DRAFT_OPTIONS = 20;
export const MAX_INTAKE_CONDITION_DOCUMENT_CHARS = 64_000;

const QUESTION_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const RESERVED_KEYS = new Set(["eval", "constructor", "prototype", "__proto__", "this"]);

export class IntakeConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeConditionError";
  }
}

export type IntakeConditionOption = {
  value: string;
  label: string;
};

export type IntakeDraftQuestion = {
  key: string;
  type: IntakeDraftQuestionType;
  label: string;
  help?: string;
  required?: boolean;
  options?: IntakeConditionOption[];
};

export type IntakeConditionPredicate = {
  field: string;
  op: IntakeConditionOp;
  value?: string;
  values?: string[];
};

export type IntakeConditionRule = {
  id: string;
  questionKey: string;
  when: IntakeConditionPredicate;
  action: IntakeConditionAction;
};

export type IntakeConditionDocument = {
  version: typeof INTAKE_CONDITION_DOCUMENT_VERSION;
  status: IntakeConditionStatus;
  tradeCode: TradeCode;
  baseSchemaKey: string;
  baseSchemaVersion: number;
  questions: IntakeDraftQuestion[];
  rules: IntakeConditionRule[];
};

export type IntakeConditionPublishedView = {
  snapshotId: string;
  versionNumber: number;
  publishedAt: string;
  summary: string;
} | null;

export type IntakeConditionValidation =
  | { ok: true; document: IntakeConditionDocument }
  | { ok: false; errors: string[] };

export type IntakeConditionWorkspaceView = {
  selectedTrade: TradeCode;
  trades: Array<{ code: TradeCode; label: string }>;
  baseSchema: PublicIntakeSchemaProjection;
  document: IntakeConditionDocument;
  savedAt: string | null;
  status: typeof INTAKE_CONDITION_STATUS_DRAFT;
  published: IntakeConditionPublishedView;
  publishNextRequirement: string;
  publishReviewRequired: string;
};

export function isIntakeConditionOp(value: unknown): value is IntakeConditionOp {
  return (INTAKE_CONDITION_OPS as readonly string[]).includes(String(value));
}

export function isIntakeConditionAction(value: unknown): value is IntakeConditionAction {
  return (INTAKE_CONDITION_ACTIONS as readonly string[]).includes(String(value));
}

export function isIntakeDraftQuestionType(value: unknown): value is IntakeDraftQuestionType {
  return (INTAKE_DRAFT_QUESTION_TYPES as readonly string[]).includes(String(value));
}

export function conditionNeedsValue(op: IntakeConditionOp) {
  return op === "EQUALS" || op === "NOT_EQUALS" || op === "INCLUDES";
}

export function conditionNeedsValues(op: IntakeConditionOp) {
  return op === "IN" || op === "NOT_IN";
}

export function emptyIntakeConditionDocument(
  tradeCode: string,
  schema: IntakeSchema = currentIntakeSchema(tradeCode),
): IntakeConditionDocument {
  const code = isConfiguredTrade(tradeCode) ? tradeCode : DEFAULT_TRADE;
  const base = schema.tradeCode === code ? schema : currentIntakeSchema(code);
  return {
    version: INTAKE_CONDITION_DOCUMENT_VERSION,
    status: INTAKE_CONDITION_STATUS_DRAFT,
    tradeCode: code,
    baseSchemaKey: base.key,
    baseSchemaVersion: base.version,
    questions: [],
    rules: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmed(value: unknown, max = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function asStringList(value: unknown, maxItems = MAX_INTAKE_DRAFT_OPTIONS) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asTrimmed(item, 80))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function intakeConditionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof IntakeConditionError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") {
    return "You do not have permission to do that.";
  }
  if (error instanceof Error && error.message.startsWith("Record is not in the authorized")) {
    return "You do not have permission to do that.";
  }
  return fallback;
}

export function assertDraftOnlyStatus(status: string) {
  if (status !== INTAKE_CONDITION_STATUS_DRAFT) {
    throw new IntakeConditionError(INTAKE_CONDITION_PUBLISH_NEXT_REQUIREMENT);
  }
}

function platformFields(schema: IntakeSchema) {
  return schema.fields;
}

function platformFieldMap(schema: IntakeSchema) {
  return new Map(platformFields(schema).map((field) => [field.key, field]));
}

export function parseIntakeConditionDocument(
  raw: unknown,
  options: { allowPublished?: boolean } = {},
): IntakeConditionValidation {
  const errors: string[] = [];
  const record = typeof raw === "string" ? safeJson(raw) : asRecord(raw);
  if (!record) {
    return { ok: false, errors: ["The draft is not valid JSON."] };
  }
  if (record.version !== INTAKE_CONDITION_DOCUMENT_VERSION) {
    errors.push("Only intake condition document version 1 is allowed.");
  }
  const allowedStatuses: IntakeConditionStatus[] = options.allowPublished
    ? [INTAKE_CONDITION_STATUS_DRAFT, INTAKE_CONDITION_STATUS_PUBLISHED]
    : [INTAKE_CONDITION_STATUS_DRAFT];
  if (record.status != null && !allowedStatuses.includes(record.status as IntakeConditionStatus)) {
    errors.push(INTAKE_CONDITION_DRAFT_STATUS_REQUIRED);
  }
  const tradeCode = isConfiguredTrade(String(record.tradeCode ?? ""))
    ? (record.tradeCode as TradeCode)
    : null;
  if (!tradeCode) {
    errors.push("Choose a configured trade for this draft.");
  }
  const questionsRaw = Array.isArray(record.questions) ? record.questions : null;
  const rulesRaw = Array.isArray(record.rules) ? record.rules : null;
  if (!questionsRaw) errors.push("Questions must be a list.");
  if (!rulesRaw) errors.push("Rules must be a list.");
  if (errors.length > 0) return { ok: false, errors };

  const questions: IntakeDraftQuestion[] = [];
  const seenKeys = new Set<string>();
  for (const item of questionsRaw ?? []) {
    const row = asRecord(item);
    if (!row) {
      errors.push("Each question must be an object.");
      continue;
    }
    const key = asTrimmed(row.key, 48).toLowerCase();
    if (!QUESTION_KEY.test(key) || RESERVED_KEYS.has(key)) {
      errors.push(`Question key “${key || "(empty)"}” must be a short lowercase slug.`);
      continue;
    }
    if (seenKeys.has(key)) {
      errors.push(`Question key “${key}” is used more than once.`);
      continue;
    }
    if (!isIntakeDraftQuestionType(row.type)) {
      errors.push(`Question “${key}” uses a type that is not allowlisted.`);
      continue;
    }
    const label = asTrimmed(row.label, 120);
    if (!label) {
      errors.push(`Question “${key}” needs a label.`);
      continue;
    }
    const help = asTrimmed(row.help, 240) || undefined;
    const options = Array.isArray(row.options)
      ? row.options
          .map((option) => {
            const parsed = asRecord(option);
            if (!parsed) return null;
            const value = asTrimmed(parsed.value, 48);
            const optionLabel = asTrimmed(parsed.label, 80);
            if (!value || !optionLabel || !/^[A-Z0-9_]{1,48}$/.test(value)) return null;
            return { value, label: optionLabel };
          })
          .filter((option): option is IntakeConditionOption => option != null)
          .slice(0, MAX_INTAKE_DRAFT_OPTIONS)
      : [];
    if ((row.type === "CHOICE" || row.type === "MULTI_CHOICE") && options.length < 2) {
      errors.push(`Question “${key}” needs at least two allowlisted options.`);
    }
    seenKeys.add(key);
    questions.push({
      key,
      type: row.type,
      label,
      help,
      required: row.required === true,
      options: options.length > 0 ? options : undefined,
    });
  }

  const rules: IntakeConditionRule[] = [];
  const seenRuleIds = new Set<string>();
  for (const item of rulesRaw ?? []) {
    const row = asRecord(item);
    if (!row) {
      errors.push("Each rule must be an object.");
      continue;
    }
    const id = asTrimmed(row.id, 64);
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      errors.push("Every rule needs a short id.");
      continue;
    }
    if (seenRuleIds.has(id)) {
      errors.push(`Rule id “${id}” is used more than once.`);
      continue;
    }
    const questionKey = asTrimmed(row.questionKey, 48).toLowerCase();
    const when = asRecord(row.when);
    const op = when ? when.op : null;
    if (!isIntakeConditionOp(op)) {
      errors.push(`Rule “${id}” uses an operator that is not allowlisted.`);
      continue;
    }
    if (!isIntakeConditionAction(row.action)) {
      errors.push(`Rule “${id}” uses an action that is not allowlisted.`);
      continue;
    }
    const field = asTrimmed(when?.field, 48);
    if (!field) {
      errors.push(`Rule “${id}” must name a platform field.`);
      continue;
    }
    const value = asTrimmed(when?.value, 80) || undefined;
    const values = asStringList(when?.values);
    if (conditionNeedsValue(op) && !value) {
      errors.push(`Rule “${id}” needs a comparison value.`);
    }
    if (conditionNeedsValues(op) && values.length === 0) {
      errors.push(`Rule “${id}” needs an allowlisted list of values.`);
    }
    seenRuleIds.add(id);
    rules.push({
      id,
      questionKey,
      when: { field, op, value, values: values.length > 0 ? values : undefined },
      action: row.action,
    });
  }

  if (questions.length > MAX_INTAKE_DRAFT_QUESTIONS) {
    errors.push(`At most ${MAX_INTAKE_DRAFT_QUESTIONS} extra questions can be drafted.`);
  }
  if (rules.length > MAX_INTAKE_DRAFT_RULES) {
    errors.push(`At most ${MAX_INTAKE_DRAFT_RULES} rules can be drafted.`);
  }

  const document: IntakeConditionDocument = {
    version: INTAKE_CONDITION_DOCUMENT_VERSION,
    status:
      record.status === INTAKE_CONDITION_STATUS_PUBLISHED && options.allowPublished
        ? INTAKE_CONDITION_STATUS_PUBLISHED
        : INTAKE_CONDITION_STATUS_DRAFT,
    tradeCode: tradeCode ?? DEFAULT_TRADE,
    baseSchemaKey: asTrimmed(record.baseSchemaKey, 80),
    baseSchemaVersion:
      typeof record.baseSchemaVersion === "number" && Number.isInteger(record.baseSchemaVersion)
        ? record.baseSchemaVersion
        : 0,
    questions,
    rules,
  };
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, document };
}

function safeJson(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_INTAKE_CONDITION_DOCUMENT_CHARS) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function validateIntakeConditionDocument(
  raw: unknown,
  schema: IntakeSchema,
  options: { allowPublished?: boolean } = {},
): IntakeConditionValidation {
  const parsed = parseIntakeConditionDocument(raw, options);
  if (!parsed.ok) return parsed;
  const errors: string[] = [];
  const document = parsed.document;
  if (document.tradeCode !== schema.tradeCode) {
    errors.push(`This draft is for ${tradeLabel(document.tradeCode)}, not ${tradeLabel(schema.tradeCode)}.`);
  }
  if (document.baseSchemaKey && document.baseSchemaKey !== schema.key) {
    errors.push("This draft must stay on the current platform intake schema key.");
  }
  if (document.baseSchemaVersion && document.baseSchemaVersion !== schema.version) {
    errors.push(
      `This draft must stay on ${schema.key} version ${schema.version}. Archived schemas stay frozen.`,
    );
  }
  const platform = platformFieldMap(schema);
  const drafted = new Set(document.questions.map((question) => question.key));
  for (const question of document.questions) {
    if (platform.has(question.key)) {
      errors.push(
        `Question “${question.key}” collides with a platform field and would reinterpret the existing intake engine.`,
      );
    }
  }
  for (const rule of document.rules) {
    if (!drafted.has(rule.questionKey)) {
      errors.push(`Rule “${rule.id}” must target a drafted question, not a platform field.`);
    }
    if (!platform.has(rule.when.field)) {
      errors.push(
        `Rule “${rule.id}” may only read allowlisted platform fields (not drafted questions or arbitrary keys).`,
      );
    }
    if (drafted.has(rule.when.field)) {
      errors.push(`Rule “${rule.id}” cannot read another drafted question.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    document: {
      ...document,
      baseSchemaKey: schema.key,
      baseSchemaVersion: schema.version,
      tradeCode: schema.tradeCode,
    },
  };
}

function answerIsBlank(value: unknown) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function answerAsStrings(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value == null || value === "") return [];
  return [String(value)];
}

function answerIsYes(value: unknown) {
  return value === true || value === "yes" || value === "true" || value === "on" || value === "1";
}

function answerIsNo(value: unknown) {
  if (answerIsBlank(value)) return false;
  return value === false || value === "no" || value === "false" || value === "0";
}

export function predicateMatches(when: IntakeConditionPredicate, answers: IntakeAnswerMap) {
  if (!isIntakeConditionOp(when.op)) return false;
  const actual = answers[when.field];
  switch (when.op) {
    case "EQUALS":
      return String(actual ?? "").toLowerCase() === String(when.value ?? "").toLowerCase();
    case "NOT_EQUALS":
      return String(actual ?? "").toLowerCase() !== String(when.value ?? "").toLowerCase();
    case "IN":
      return (when.values ?? []).some(
        (value) => String(actual ?? "").toLowerCase() === value.toLowerCase(),
      );
    case "NOT_IN":
      return !(when.values ?? []).some(
        (value) => String(actual ?? "").toLowerCase() === value.toLowerCase(),
      );
    case "INCLUDES":
      return answerAsStrings(actual).some(
        (value) => value.toLowerCase() === String(when.value ?? "").toLowerCase(),
      );
    case "IS_YES":
      return answerIsYes(actual);
    case "IS_NO":
      return answerIsNo(actual);
    case "IS_ANSWERED":
      return !answerIsBlank(actual);
    case "IS_BLANK":
      return answerIsBlank(actual);
    default:
      return false;
  }
}

export type DraftedQuestionState = {
  key: string;
  visible: boolean;
  required: boolean;
};

export function evaluateDraftedQuestion(
  question: IntakeDraftQuestion,
  rules: IntakeConditionRule[],
  answers: IntakeAnswerMap,
): DraftedQuestionState {
  const matching = rules.filter(
    (rule) => rule.questionKey === question.key && predicateMatches(rule.when, answers),
  );
  const hasShowRules = rules.some(
    (rule) => rule.questionKey === question.key && rule.action === "SHOW",
  );
  const hidden = matching.some((rule) => rule.action === "HIDE");
  const shown = matching.some((rule) => rule.action === "SHOW");
  const visible = hidden ? false : hasShowRules ? shown : true;
  const required =
    visible && (question.required === true || matching.some((rule) => rule.action === "REQUIRE"));
  return { key: question.key, visible, required };
}

export function evaluateIntakeConditionDocument(
  document: IntakeConditionDocument,
  answers: IntakeAnswerMap,
) {
  return Object.fromEntries(
    document.questions.map((question) => [
      question.key,
      evaluateDraftedQuestion(question, document.rules, answers),
    ]),
  ) as Record<string, DraftedQuestionState>;
}

function draftedFieldDefinition(
  question: IntakeDraftQuestion,
  state: DraftedQuestionState,
): IntakeFieldDefinition {
  return {
    key: question.key,
    type: question.type,
    label: question.label,
    help: question.help,
    required: state.required,
    options: question.options,
    render: "trade",
  };
}

export function previewIntakeConditionForm(
  schema: IntakeSchema,
  document: IntakeConditionDocument,
  answers: IntakeAnswerMap,
): {
  platform: PublicIntakeSchemaProjection;
  visibleQuestions: Array<IntakeDraftQuestion & { required: boolean }>;
  hiddenKeys: string[];
  states: Record<string, DraftedQuestionState>;
} {
  const states = evaluateIntakeConditionDocument(document, answers);
  const visibleQuestions = document.questions
    .filter((question) => states[question.key]?.visible)
    .map((question) => ({
      ...question,
      required: states[question.key]?.required === true,
    }));
  return {
    platform: publicIntakeSchemaProjection(schema),
    visibleQuestions,
    hiddenKeys: document.questions
      .filter((question) => !states[question.key]?.visible)
      .map((question) => question.key),
    states,
  };
}

export function validatePreviewIntakeAnswers(
  schema: IntakeSchema,
  document: IntakeConditionDocument,
  answers: IntakeAnswerMap,
): { ok: true; answers: IntakeAnswerMap } | { ok: false; error: string } {
  const platform = validateIntakeAnswers(schema, answers);
  if (!platform.ok) return platform;
  const cleaned: IntakeAnswerMap = { ...platform.answers };
  const states = evaluateIntakeConditionDocument(document, answers);
  for (const question of document.questions) {
    const state = states[question.key];
    if (!state?.visible) continue;
    const field = draftedFieldDefinition(question, state);
    if (!fieldIsVisible(field, answers) && field.visibleWhen) continue;
    const raw = answers[question.key];
    if (state.required) {
      const missing = raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);
      if (missing) {
        return { ok: false, error: `Please answer: ${question.label}.` };
      }
    }
    if (raw == null || raw === "") continue;
    if (question.type === "COUNTS" || question.type === "NUMBER") {
      const text = String(raw).trim();
      if (!/^\d{1,2}$/.test(text)) {
        return { ok: false, error: `Enter a whole number for ${question.label}.` };
      }
      cleaned[question.key] = Number(text);
      continue;
    }
    if (question.type === "YES_NO") {
      cleaned[question.key] = answerIsYes(raw) ? "yes" : "no";
      continue;
    }
    if (question.type === "CHOICE") {
      const value = String(raw);
      if (question.options && !question.options.some((option) => option.value === value)) {
        return { ok: false, error: `Choose a valid option for ${question.label}.` };
      }
      cleaned[question.key] = value;
      continue;
    }
    if (question.type === "MULTI_CHOICE") {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const allowed = new Set((question.options ?? []).map((option) => option.value));
      cleaned[question.key] = values.filter((value) => allowed.has(value));
      continue;
    }
    if (typeof raw === "string") {
      if (raw.length > 2000) {
        return { ok: false, error: `Please shorten ${question.label}.` };
      }
      cleaned[question.key] = raw.trim();
    }
  }
  return { ok: true, answers: cleaned };
}

export function serializeIntakeConditionDocument(document: IntakeConditionDocument) {
  return JSON.stringify({
    version: INTAKE_CONDITION_DOCUMENT_VERSION,
    status:
      document.status === INTAKE_CONDITION_STATUS_PUBLISHED
        ? INTAKE_CONDITION_STATUS_PUBLISHED
        : INTAKE_CONDITION_STATUS_DRAFT,
    tradeCode: document.tradeCode,
    baseSchemaKey: document.baseSchemaKey,
    baseSchemaVersion: document.baseSchemaVersion,
    questions: document.questions,
    rules: document.rules,
  });
}

export function extraQuestionsAsFields(
  document: IntakeConditionDocument,
): IntakeFieldDefinition[] {
  return document.questions.map((question) => ({
    key: question.key,
    type: question.type,
    label: question.label,
    help: question.help,
    required: question.required === true,
    options: question.options,
    render: "trade" as const,
  }));
}
