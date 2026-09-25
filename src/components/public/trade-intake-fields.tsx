"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fieldIsVisible,
  type IntakeAnswerMap,
  type PublicIntakeSchemaProjection,
} from "@/lib/intake-schema";

export function TradeIntakeFields({
  schema,
  answers,
  onChange,
}: {
  schema: PublicIntakeSchemaProjection;
  answers: IntakeAnswerMap;
  onChange: (next: IntakeAnswerMap) => void;
}) {
  if (schema.fields.length === 0) return null;

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
        const id = `trade-intake-${field.key}`;
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
              {field.help ? <p className="text-sm text-muted-foreground">{field.help}</p> : null}
            </div>
          );
        }
        if (field.type === "MULTI_CHOICE") {
          const selected = Array.isArray(answers[field.key])
            ? (answers[field.key] as string[])
            : [];
          return (
            <fieldset key={field.key} className="space-y-2">
              <legend className="text-sm font-medium">{field.label}</legend>
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
        if (field.type === "COUNTS" || field.type === "NUMBER") {
          return (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={id}>
                {field.label}
                {field.required ? " *" : ""}
              </Label>
              <Input
                id={id}
                inputMode="numeric"
                value={String(answers[field.key] ?? "")}
                onChange={(event) => setField(field.key, event.target.value)}
              />
              {field.help ? <p className="text-sm text-muted-foreground">{field.help}</p> : null}
            </div>
          );
        }
        return (
          <div key={field.key} className="space-y-2">
            <Label htmlFor={id}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            <textarea
              id={id}
              rows={3}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
              value={String(answers[field.key] ?? "")}
              onChange={(event) => setField(field.key, event.target.value)}
            />
            {field.help ? <p className="text-sm text-muted-foreground">{field.help}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
