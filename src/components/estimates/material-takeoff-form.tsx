"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  convertEstimateMaterialTakeoff,
  saveEstimateMaterialTakeoff,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import { computeTakeoff } from "@/lib/material-takeoff/engine";
import {
  CONCRETE_BAG_YIELDS_CU_FT,
  DEFAULT_CONCRETE_BAG_SIZE_LB,
  emptyConcreteSlabInputs,
} from "@/lib/material-takeoff/formulas/concrete-slab";
import { emptyFramedWallInputs } from "@/lib/material-takeoff/formulas/framed-wall";
import { emptySheetCoveringInputs } from "@/lib/material-takeoff/formulas/sheet-covering";
import {
  feetAndInchesToFeet,
  parseNonNegativeConstructionNumber,
} from "@/lib/material-takeoff/units";
import {
  TAKEOFF_TYPE_IDS,
  TAKEOFF_TYPE_LABELS,
  extendedCustomerPrice,
  extendedMaterialCost,
  takeoffCustomerSellingTotal,
  takeoffInternalMaterialTotal,
  type TakeoffItem,
  type TakeoffMeasurementSource,
  type TakeoffSnapshot,
  type TakeoffTypeId,
} from "@/lib/material-takeoff/types";

const initialState: EstimateActionState = {};

export function MaterialTakeoffForm({
  estimateId,
  lineItemId,
  snapshot,
  suggestedType,
  suggestedInputs,
  measurementSource,
  skippedMeasurements,
}: {
  estimateId: string;
  lineItemId: string;
  snapshot?: TakeoffSnapshot | null;
  suggestedType?: TakeoffTypeId | null;
  suggestedInputs?: Record<string, unknown> | null;
  measurementSource?: TakeoffMeasurementSource | null;
  skippedMeasurements?: string[];
}) {
  const [saveState, saveAction, savePending] = useActionState(
    saveEstimateMaterialTakeoff,
    initialState,
  );
  const [convertState, convertAction, convertPending] = useActionState(
    convertEstimateMaterialTakeoff,
    initialState,
  );
  const startingType = snapshot?.takeoffType ?? suggestedType ?? "concrete-slab";
  const [takeoffType, setTakeoffType] = useState<TakeoffTypeId>(startingType);
  const [draft, setDraft] = useState<TakeoffSnapshot>(
    snapshot ??
      computeTakeoff({
        takeoffType: startingType,
        inputs: suggestedInputs,
        measurementSource,
        skippedMeasurements,
      }).snapshot,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [customUnit, setCustomUnit] = useState("ea");
  const [customQty, setCustomQty] = useState("1");
  const [customCost, setCustomCost] = useState("");
  const [customPrice, setCustomPrice] = useState("");

  const internalTotal = useMemo(
    () => takeoffInternalMaterialTotal(draft),
    [draft],
  );
  const customerTotal = useMemo(
    () => takeoffCustomerSellingTotal(draft),
    [draft],
  );
  const pending = savePending || convertPending;
  const status = convertState.message || saveState.message;
  const error = localError || convertState.error || saveState.error;

  function calculateFromInputs() {
    const computed = computeTakeoff({
      takeoffType,
      inputs: draft.inputs,
      wastePercent: draft.wastePercent,
      measurementSource: draft.measurementSource ?? measurementSource,
      skippedMeasurements: draft.skippedMeasurements.length
        ? draft.skippedMeasurements
        : skippedMeasurements,
      previous: draft,
    });
    setDraft(computed.snapshot);
    setLocalError(computed.rejected);
  }

  function changeType(next: TakeoffTypeId) {
    setTakeoffType(next);
    setDraft(
      computeTakeoff({
        takeoffType: next,
        inputs: suggestedInputs,
        measurementSource,
        skippedMeasurements,
        previous: draft.takeoffType === next ? draft : null,
      }).snapshot,
    );
  }

  function setInput(key: string, value: unknown) {
    setDraft((current) => ({
      ...current,
      inputs: { ...current.inputs, [key]: value },
    }));
  }

  function patchItem(id: string, patch: Partial<TakeoffItem>) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  }

  function addCustom() {
    const quantity = Number(customQty);
    if (!customLabel.trim() || !Number.isFinite(quantity) || quantity <= 0) return;
    const unitCost = customCost.trim() ? Number(customCost) : null;
    const customerUnitPrice = customPrice.trim() ? Number(customPrice) : null;
    setDraft((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          id: `custom-${globalThis.crypto.randomUUID()}`,
          kind: "custom",
          label: customLabel.trim(),
          unit: customUnit.trim() || "ea",
          optional: true,
          selected: true,
          calculatedQuantity: quantity,
          quantityOverride: quantity,
          unitCost: unitCost != null && Number.isFinite(unitCost) ? unitCost : null,
          customerUnitPrice:
            customerUnitPrice != null && Number.isFinite(customerUnitPrice)
              ? customerUnitPrice
              : null,
          explanation: "Owner-added takeoff item.",
          convertedLineItemId: null,
        },
      ],
    }));
    setCustomLabel("");
    setCustomQty("1");
    setCustomCost("");
    setCustomPrice("");
  }

  function removeItem(id: string) {
    setDraft((current) => ({
      ...current,
      removedItemIds: [...current.removedItemIds, id],
      items: current.items.filter((item) => item.id !== id),
    }));
  }

  const takeoffJson = JSON.stringify(draft);

  return (
    <details
      className="mt-3 rounded-lg border border-border p-3"
      open={Boolean(snapshot)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Material takeoff (owner only)
      </summary>
      <form className="mt-3 space-y-4">
        <input type="hidden" name="estimateId" value={estimateId} />
        <input type="hidden" name="lineItemId" value={lineItemId} />
        <input type="hidden" name="takeoffType" value={takeoffType} />
        <input type="hidden" name="takeoffJson" value={takeoffJson} />

        <p className="text-xs text-muted-foreground">
          Internal working quantities, unit cost, and a separate customer unit
          price. Cost is never treated as the selling price. Nothing here is
          shown on the customer estimate, print/PDF, or portal until you convert
          selected items into normal MATERIAL lines.
        </p>

        {draft.measurementSource ? (
          <p className="text-xs">
            Measurement source: {draft.measurementSource.label}
            {draft.measurementSource.unverified
              ? " — do not treat as final verified quantities."
              : ""}
          </p>
        ) : null}
        {draft.skippedMeasurements.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Skipped incompatible measurements: {draft.skippedMeasurements.join(", ")}
          </p>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor={`takeoff-type-${lineItemId}`}>Takeoff type</Label>
          <select
            id={`takeoff-type-${lineItemId}`}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            value={takeoffType}
            onChange={(event) => changeType(event.target.value as TakeoffTypeId)}
          >
            {TAKEOFF_TYPE_IDS.map((id) => (
              <option key={id} value={id}>
                {TAKEOFF_TYPE_LABELS[id]}
              </option>
            ))}
          </select>
        </div>

        {takeoffType === "concrete-slab" ? (
          <ConcreteInputs draft={draft} setInput={setInput} />
        ) : null}
        {takeoffType === "sheet-covering" ? (
          <SheetInputs draft={draft} setInput={setInput} />
        ) : null}
        {takeoffType === "framed-wall" ? (
          <FramedInputs draft={draft} setInput={setInput} />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor={`waste-${lineItemId}`}>Waste %</Label>
          <Input
            id={`waste-${lineItemId}`}
            inputMode="decimal"
            value={String(draft.wastePercent)}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                wastePercent: Number(event.target.value) || 0,
              }))
            }
          />
        </div>

        {draft.explanation ? (
          <p className="text-xs text-muted-foreground">{draft.explanation}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={calculateFromInputs} disabled={pending}>
            Calculate from measurements
          </Button>
          <Button type="submit" formAction={saveAction} disabled={pending} variant="outline">
            {savePending ? "Saving…" : "Save takeoff"}
          </Button>
          <Button type="submit" formAction={convertAction} disabled={pending}>
            {convertPending ? "Converting…" : "Convert selected to MATERIAL lines"}
          </Button>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}

        {draft.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Use</th>
                  <th className="py-1 pr-2">Item</th>
                  <th className="py-1 pr-2">Calc qty</th>
                  <th className="py-1 pr-2">Owner qty</th>
                  <th className="py-1 pr-2">Unit</th>
                  <th className="py-1 pr-2">Unit cost (internal)</th>
                  <th className="py-1 pr-2">Internal extended</th>
                  <th className="py-1 pr-2">Customer unit price</th>
                  <th className="py-1 pr-2">Customer extended</th>
                  <th className="py-1"> </th>
                </tr>
              </thead>
              <tbody>
                {draft.items.map((item) => (
                  <tr key={item.id} className="border-t border-border align-top">
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(event) =>
                          patchItem(item.id, { selected: event.target.checked })
                        }
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <div>{item.label}</div>
                      <div className="text-muted-foreground">{item.explanation}</div>
                      {item.convertedLineItemId ? (
                        <div className="text-muted-foreground">Converted — repeat will not duplicate</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{item.calculatedQuantity}</td>
                    <td className="py-2 pr-2">
                      <Input
                        inputMode="decimal"
                        value={
                          item.quantityOverride == null
                            ? ""
                            : String(item.quantityOverride)
                        }
                        placeholder={String(item.calculatedQuantity)}
                        onChange={(event) =>
                          patchItem(item.id, {
                            quantityOverride: event.target.value.trim()
                              ? Number(event.target.value)
                              : null,
                          })
                        }
                      />
                    </td>
                    <td className="py-2 pr-2">{item.unit}</td>
                    <td className="py-2 pr-2">
                      <Input
                        inputMode="decimal"
                        value={item.unitCost == null ? "" : String(item.unitCost)}
                        placeholder="Internal cost"
                        onChange={(event) =>
                          patchItem(item.id, {
                            unitCost: event.target.value.trim()
                              ? Number(event.target.value)
                              : null,
                          })
                        }
                      />
                    </td>
                    <td className="py-2 pr-2 tabular-nums">
                      {formatMoney(extendedMaterialCost(item))}
                    </td>
                    <td className="py-2 pr-2">
                      <Input
                        inputMode="decimal"
                        value={
                          item.customerUnitPrice == null
                            ? ""
                            : String(item.customerUnitPrice)
                        }
                        placeholder="Selling price"
                        onChange={(event) =>
                          patchItem(item.id, {
                            customerUnitPrice: event.target.value.trim()
                              ? Number(event.target.value)
                              : null,
                          })
                        }
                      />
                    </td>
                    <td className="py-2 pr-2 tabular-nums">
                      {formatMoney(extendedCustomerPrice(item))}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="text-muted-foreground underline"
                        onClick={() => removeItem(item.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs">
              Internal material cost: {formatMoney(internalTotal)}. Customer
              selling total: {formatMoney(customerTotal)}. Conversion uses
              customer unit price, not internal cost.
            </p>
          </div>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-5">
          <Input
            placeholder="Add item label"
            value={customLabel}
            onChange={(event) => setCustomLabel(event.target.value)}
          />
          <Input
            placeholder="Unit"
            value={customUnit}
            onChange={(event) => setCustomUnit(event.target.value)}
          />
          <Input
            placeholder="Qty"
            inputMode="decimal"
            value={customQty}
            onChange={(event) => setCustomQty(event.target.value)}
          />
          <Input
            placeholder="Unit cost (internal)"
            inputMode="decimal"
            value={customCost}
            onChange={(event) => setCustomCost(event.target.value)}
          />
          <Input
            placeholder="Customer unit price"
            inputMode="decimal"
            value={customPrice}
            onChange={(event) => setCustomPrice(event.target.value)}
          />
        </div>
        <Button type="button" variant="outline" onClick={addCustom}>
          Add takeoff item
        </Button>
      </form>
    </details>
  );
}

function ConcreteInputs({
  draft,
  setInput,
}: {
  draft: TakeoffSnapshot;
  setInput: (key: string, value: unknown) => void;
}) {
  const inputs = emptyConcreteSlabInputs(draft.inputs);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <FeetInchesField
        label="Length"
        feet={inputs.lengthFtPart}
        inches={inputs.lengthInPart}
        onChange={(feet, inches) => setLinear(setInput, "length", feet, inches)}
      />
      <FeetInchesField
        label="Width"
        feet={inputs.widthFtPart}
        inches={inputs.widthInPart}
        onChange={(feet, inches) => setLinear(setInput, "width", feet, inches)}
      />
      <ConstructionNumberField
        label="Thickness (in)"
        value={inputs.thicknessIn}
        onChange={(v) => setInput("thicknessIn", v)}
      />
      <div className="space-y-2">
        <Label>Bag size</Label>
        <select
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          value={String(inputs.bagSizeLb)}
          onChange={(event) => {
            const bagSizeLb = Number(event.target.value) || DEFAULT_CONCRETE_BAG_SIZE_LB;
            setInput("bagSizeLb", bagSizeLb);
            if (bagSizeLb === 40 || bagSizeLb === 60 || bagSizeLb === 80) {
              setInput("bagYieldCuFt", CONCRETE_BAG_YIELDS_CU_FT[bagSizeLb]);
            }
          }}
        >
          <option value="40">40-lb</option>
          <option value="60">60-lb</option>
          <option value="80">80-lb</option>
        </select>
      </div>
      <NumberField
        label="Bag yield (cu ft)"
        value={inputs.bagYieldCuFt}
        onChange={(v) => setInput("bagYieldCuFt", v)}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeWireMesh}
          onChange={(event) => setInput("includeWireMesh", event.target.checked)}
        />
        Welded wire mesh
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeFormLumber}
          onChange={(event) => setInput("includeFormLumber", event.target.checked)}
        />
        Form lumber & stakes
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeAnchors}
          onChange={(event) => setInput("includeAnchors", event.target.checked)}
        />
        Anchor hardware
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeSillGasket}
          onChange={(event) => setInput("includeSillGasket", event.target.checked)}
        />
        Sill gasket
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includePickup}
          onChange={(event) => setInput("includePickup", event.target.checked)}
        />
        Pickup / procurement
      </label>
    </div>
  );
}

function SheetInputs({
  draft,
  setInput,
}: {
  draft: TakeoffSnapshot;
  setInput: (key: string, value: unknown) => void;
}) {
  const inputs = emptySheetCoveringInputs(draft.inputs);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <FeetInchesField
        label="Wall width"
        feet={inputs.wallWidthFtPart}
        inches={inputs.wallWidthInPart}
        onChange={(feet, inches) => setLinear(setInput, "wallWidth", feet, inches)}
      />
      <FeetInchesField
        label="Wall height"
        feet={inputs.wallHeightFtPart}
        inches={inputs.wallHeightInPart}
        onChange={(feet, inches) => setLinear(setInput, "wallHeight", feet, inches)}
      />
      <FeetInchesField
        label="Sheet width"
        feet={inputs.sheetWidthFtPart}
        inches={inputs.sheetWidthInPart}
        onChange={(feet, inches) => setLinear(setInput, "sheetWidth", feet, inches)}
      />
      <FeetInchesField
        label="Sheet height"
        feet={inputs.sheetHeightFtPart}
        inches={inputs.sheetHeightInPart}
        onChange={(feet, inches) => setLinear(setInput, "sheetHeight", feet, inches)}
      />
      <NumberField label="Sliding patio doors" value={inputs.slidingPatioDoors} onChange={(v) => setInput("slidingPatioDoors", v)} />
      <NumberField label="Standard doors" value={inputs.standardDoors} onChange={(v) => setInput("standardDoors", v)} />
      <NumberField label="Windows" value={inputs.windows} onChange={(v) => setInput("windows", v)} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeTrim}
          onChange={(event) => setInput("includeTrim", event.target.checked)}
        />
        Trim / linear material
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeFasteners}
          onChange={(event) => setInput("includeFasteners", event.target.checked)}
        />
        Fastener allowance
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includePickup}
          onChange={(event) => setInput("includePickup", event.target.checked)}
        />
        Pickup / procurement
      </label>
    </div>
  );
}

function FramedInputs({
  draft,
  setInput,
}: {
  draft: TakeoffSnapshot;
  setInput: (key: string, value: unknown) => void;
}) {
  const inputs = emptyFramedWallInputs(draft.inputs);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <FeetInchesField
        label="Wall length"
        feet={inputs.wallLengthFtPart}
        inches={inputs.wallLengthInPart}
        onChange={(feet, inches) => setLinear(setInput, "wallLength", feet, inches)}
      />
      <FeetInchesField
        label="Wall height"
        feet={inputs.wallHeightFtPart}
        inches={inputs.wallHeightInPart}
        onChange={(feet, inches) => setLinear(setInput, "wallHeight", feet, inches)}
      />
      <ConstructionNumberField
        label="Stud spacing (in)"
        value={inputs.studSpacingIn}
        onChange={(v) => setInput("studSpacingIn", v)}
      />
      <NumberField label="Openings" value={inputs.openings} onChange={(v) => setInput("openings", v)} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeSheathing}
          onChange={(event) => setInput("includeSheathing", event.target.checked)}
        />
        Sheathing / sheets
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includeFasteners}
          onChange={(event) => setInput("includeFasteners", event.target.checked)}
        />
        Fastener allowance
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={inputs.includePickup}
          onChange={(event) => setInput("includePickup", event.target.checked)}
        />
        Pickup / procurement
      </label>
    </div>
  );
}

function setLinear(
  setInput: (key: string, value: unknown) => void,
  prefix: string,
  feet: number,
  inches: number,
) {
  setInput(`${prefix}FtPart`, feet);
  setInput(`${prefix}InPart`, inches);
  setInput(`${prefix}Ft`, feetAndInchesToFeet(feet, inches));
}

function FeetInchesField({
  label,
  feet,
  inches,
  onChange,
}: {
  label: string;
  feet: number;
  inches: number;
  onChange: (feet: number, inches: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <ConstructionNumberField
          label="Feet"
          value={feet}
          onChange={(value) => onChange(value, inches)}
        />
        <ConstructionNumberField
          label="Inches"
          value={inches}
          onChange={(value) => onChange(feet, value)}
        />
      </div>
    </div>
  );
}

function ConstructionNumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(value === 0 ? "" : String(value));
  useEffect(() => {
    setText(value === 0 ? "" : String(value));
  }, [value]);

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        inputMode="decimal"
        value={text}
        placeholder="0"
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (!next.trim()) {
            onChange(0);
            return;
          }
          const parsed = parseNonNegativeConstructionNumber(next);
          if (parsed != null) onChange(parsed);
        }}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        inputMode="decimal"
        value={value === 0 ? "" : String(value)}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </div>
  );
}
