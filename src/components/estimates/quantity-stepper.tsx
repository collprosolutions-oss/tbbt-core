"use client";

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseTypedCount, stepCount } from "@/lib/estimate-calculators/count-input";

export function QuantityStepper({
  id,
  name,
  label,
  value,
  onChange,
  min = 0,
}: {
  id: string;
  name: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 shrink-0 touch-manipulation sm:size-8"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange(stepCount(value, -1, min))}
        >
          <Minus />
        </Button>
        <Input
          id={id}
          name={name}
          inputMode="numeric"
          pattern="[0-9]*"
          step="1"
          min={min}
          className="h-10 min-w-0 flex-1 text-center tabular-nums sm:h-8"
          value={String(value)}
          onChange={(event) => onChange(parseTypedCount(event.target.value, min))}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 shrink-0 touch-manipulation sm:size-8"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(stepCount(value, 1, min))}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}
