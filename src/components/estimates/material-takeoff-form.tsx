"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  applyEstimateTakeoffRecommendedLabor,
  convertEstimateMaterialTakeoff,
  saveEstimateBusinessEstimatingDefaults,
  saveEstimateMaterialTakeoff,
  type EstimateActionState,
} from "@/app/actions/estimate";
import {
  applyBusinessEstimatingDefaults,
  BUSINESS_DEFAULT_SOURCE_LABEL,
  businessDefaultFieldSources,
  startingTakeoffDraftWithDefaults,
  type BusinessEstimatingDefaultPayload,
} from "@/lib/estimating-defaults";
import { ResetTakeoffAndGeneratedMaterialsForm } from "@/components/estimates/draft-estimate-recovery-forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import { applyMaterialMarkup, computeTakeoff } from "@/lib/material-takeoff/engine";
import {
  CONCRETE_PRODUCTION_LABOR_COVERS,
  recommendTakeoffLabor,
} from "@/lib/material-takeoff/labor-pricing";
import {
  CONCRETE_BAG_YIELDS_CU_FT,
  DEFAULT_CONCRETE_BAG_SIZE_LB,
  emptyConcreteSlabInputs,
} from "@/lib/material-takeoff/formulas/concrete-slab";
import { emptyGenericCustomInputs } from "@/lib/material-takeoff/formulas/generic-custom";
import { emptyFramedWallInputs } from "@/lib/material-takeoff/formulas/framed-wall";
import { emptySheetCoveringInputs } from "@/lib/material-takeoff/formulas/sheet-covering";
import {
  feetAndInchesToFeet,
  isIncompleteNumericDraft,
  parsePositiveNumber,
  parseTakeoffNumericInput,
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

type TakeoffFormProps = {
  estimateId: string;
  lineItemId?: string;
  snapshot?: TakeoffSnapshot | null;
  suggestedType?: TakeoffTypeId | null;
  suggestedInputs?: Record<string, unknown> | null;
  measurementSource?: TakeoffMeasurementSource | null;
  skippedMeasurements?: string[];
  workspaceTitle?: string | null;
  workspaceId?: string | null;
  businessDefaults?: BusinessEstimatingDefaultPayload | null;
};

type EstimatingTakeoffContextValue = {
  estimateId: string;
  lineItemId?: string;
  workspaceTitle?: string | null;
  workspaceId?: string | null;
  fieldId: string;
  takeoffType: TakeoffTypeId;
  changeType: (next: TakeoffTypeId) => void;
  draft: TakeoffSnapshot;
  setDraft: Dispatch<SetStateAction<TakeoffSnapshot>>;
  setInput: (key: string | Record<string, unknown>, value?: unknown) => void;
  patchItem: (id: string, patch: Partial<TakeoffItem>) => void;
  removeItem: (id: string) => void;
  addCustom: () => void;
  applyMarkupToSelected: () => void;
  calculateFromInputs: () => void;
  takeoffJson: string;
  pending: boolean;
  savePending: boolean;
  convertPending: boolean;
  laborPending: boolean;
  saveAction: (payload: FormData) => void;
  convertAction: (payload: FormData) => void;
  laborAction: (payload: FormData) => void;
  defaultsAction: (payload: FormData) => void;
  defaultsPending: boolean;
  defaultsError: string | null | undefined;
  defaultsStatus: string | null | undefined;
  defaultSources: ReturnType<typeof businessDefaultFieldSources>;
  laborError: string | null | undefined;
  laborStatus: string | null | undefined;
  materialError: string | null | undefined;
  materialStatus: string | null | undefined;
  markupStatus: string | null;
  laborRecommendation: ReturnType<typeof recommendTakeoffLabor>;
  internalTotal: ReturnType<typeof takeoffInternalMaterialTotal>;
  customerTotal: ReturnType<typeof takeoffCustomerSellingTotal>;
  showConcreteLabor: boolean;
  showGenericLabor: boolean;
  customLabel: string;
  setCustomLabel: Dispatch<SetStateAction<string>>;
  customUnit: string;
  setCustomUnit: Dispatch<SetStateAction<string>>;
  customQty: string;
  setCustomQty: Dispatch<SetStateAction<string>>;
  customCost: string;
  setCustomCost: Dispatch<SetStateAction<string>>;
  customPrice: string;
  setCustomPrice: Dispatch<SetStateAction<string>>;
};

const EstimatingTakeoffContext = createContext<EstimatingTakeoffContextValue | null>(
  null,
);

function useEstimatingTakeoff() {
  const context = useContext(EstimatingTakeoffContext);
  if (!context) {
    throw new Error("Labor and material calculators need EstimatingTakeoffProvider.");
  }
  return context;
}

export function EstimatingTakeoffProvider({
  children,
  estimateId,
  lineItemId,
  snapshot,
  suggestedType,
  suggestedInputs,
  measurementSource,
  skippedMeasurements,
  workspaceTitle,
  workspaceId,
  businessDefaults,
}: TakeoffFormProps & { children: ReactNode }) {
  const [saveState, saveAction, savePending] = useActionState(
    saveEstimateMaterialTakeoff,
    initialState,
  );
  const [convertState, convertAction, convertPending] = useActionState(
    convertEstimateMaterialTakeoff,
    initialState,
  );
  const [laborState, laborAction, laborPending] = useActionState(
    applyEstimateTakeoffRecommendedLabor,
    initialState,
  );
  const [defaultsState, defaultsAction, defaultsPending] = useActionState(
    saveEstimateBusinessEstimatingDefaults,
    initialState,
  );
  const startingType = snapshot?.takeoffType ?? suggestedType ?? "generic-custom";
  const [takeoffType, setTakeoffType] = useState<TakeoffTypeId>(startingType);
  const [draft, setDraft] = useState<TakeoffSnapshot>(() =>
    startingTakeoffDraftWithDefaults({
      snapshot,
      takeoffType: startingType,
      suggestedInputs,
      measurementSource,
      skippedMeasurements,
      businessDefaults,
    }),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [markupStatus, setMarkupStatus] = useState<string | null>(null);
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
  const laborRecommendation = useMemo(
    () => recommendTakeoffLabor(draft),
    [draft],
  );
  const defaultSources = useMemo(
    () => businessDefaultFieldSources(draft, businessDefaults ?? null),
    [businessDefaults, draft],
  );
  const pending = savePending || convertPending || laborPending || defaultsPending;
  const fieldId = lineItemId || "workspace";
  const showConcreteLabor = takeoffType === "concrete-slab";
  const showGenericLabor = takeoffType === "generic-custom";

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
    const next = applyBusinessEstimatingDefaults(
      computed.snapshot,
      businessDefaults ?? null,
      { mode: "overlay" },
    );
    setDraft({
      ...next,
      laborAdjustment: draft.laborAdjustment,
    });
    setLocalError(computed.rejected);
  }

  function changeType(next: TakeoffTypeId) {
    setTakeoffType(next);
    const computed = computeTakeoff({
      takeoffType: next,
      inputs: suggestedInputs,
      measurementSource,
      skippedMeasurements,
      previous: draft.takeoffType === next ? draft : null,
    }).snapshot;
    const defaultsMatch =
      !businessDefaults?.material.takeoffType ||
      businessDefaults.material.takeoffType === next;
    setDraft(
      defaultsMatch
        ? applyBusinessEstimatingDefaults(computed, businessDefaults ?? null, {
            mode: "seed",
          })
        : computed,
    );
  }

  function setInput(key: string | Record<string, unknown>, value?: unknown) {
    setDraft((current) => ({
      ...current,
      inputs:
        typeof key === "string"
          ? { ...current.inputs, [key]: value }
          : { ...current.inputs, ...key },
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
    if (
      isIncompleteNumericDraft(customQty) ||
      isIncompleteNumericDraft(customCost) ||
      isIncompleteNumericDraft(customPrice)
    ) {
      return;
    }
    const quantity = parsePositiveNumber(customQty);
    if (!customLabel.trim() || quantity == null) return;
    const unitCost = customCost.trim()
      ? parseTakeoffNumericInput(customCost).value
      : null;
    const customerUnitPrice = customPrice.trim()
      ? parseTakeoffNumericInput(customPrice).value
      : null;
    if (customCost.trim() && unitCost == null) return;
    if (customPrice.trim() && customerUnitPrice == null) return;
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
          unitCost,
          customerUnitPrice,
          explanation: "Owner-added takeoff item.",
          convertedLineItemId: null,
          persistAs: "project",
        },
      ],
    }));
    setCustomLabel("");
    setCustomQty("1");
    setCustomCost("");
    setCustomPrice("");
  }

  function applyMarkupToSelected() {
    const result = applyMaterialMarkup(draft, draft.markupPercent ?? 0);
    setDraft(result.snapshot);
    if (result.applied === 0) {
      setMarkupStatus(
        result.skipped > 0
          ? "No customer prices changed. Selected items need an internal unit cost greater than 0."
          : "Select items with an internal unit cost, then apply markup.",
      );
      return;
    }
    const skippedNote =
      result.skipped > 0
        ? ` Skipped ${result.skipped} without an internal unit cost.`
        : "";
    setMarkupStatus(
      `Applied markup to ${result.applied} selected item${result.applied === 1 ? "" : "s"}.${skippedNote}`,
    );
  }

  function removeItem(id: string) {
    setDraft((current) => ({
      ...current,
      removedItemIds: [...current.removedItemIds, id],
      items: current.items.filter((item) => item.id !== id),
    }));
  }

  const takeoffJson = JSON.stringify(draft);
  const value: EstimatingTakeoffContextValue = {
    estimateId,
    lineItemId,
    workspaceTitle,
    workspaceId,
    fieldId,
    takeoffType,
    changeType,
    draft,
    setDraft,
    setInput,
    patchItem,
    removeItem,
    addCustom,
    applyMarkupToSelected,
    calculateFromInputs,
    takeoffJson,
    pending,
    savePending,
    convertPending,
    laborPending,
    saveAction,
    convertAction,
    laborAction,
    defaultsAction,
    defaultsPending,
    defaultsError: defaultsState.error,
    defaultsStatus: defaultsState.message,
    defaultSources,
    laborError: laborState.error,
    laborStatus: laborState.message,
    materialError: localError || convertState.error || saveState.error,
    materialStatus: convertState.message || saveState.message,
    markupStatus,
    laborRecommendation,
    internalTotal,
    customerTotal,
    showConcreteLabor,
    showGenericLabor,
    customLabel,
    setCustomLabel,
    customUnit,
    setCustomUnit,
    customQty,
    setCustomQty,
    customCost,
    setCustomCost,
    customPrice,
    setCustomPrice,
  };

  return (
    <EstimatingTakeoffContext.Provider value={value}>
      {children}
    </EstimatingTakeoffContext.Provider>
  );
}

function TakeoffHiddenFields() {
  const { estimateId, lineItemId, takeoffType, takeoffJson, workspaceTitle, workspaceId } =
    useEstimatingTakeoff();
  return (
    <>
      <input type="hidden" name="estimateId" value={estimateId} />
      {lineItemId ? (
        <input type="hidden" name="lineItemId" value={lineItemId} />
      ) : null}
      <input type="hidden" name="takeoffType" value={takeoffType} />
      <input type="hidden" name="takeoffJson" value={takeoffJson} />
      {workspaceTitle ? (
        <input type="hidden" name="workspaceTitle" value={workspaceTitle} />
      ) : null}
      {workspaceId ? (
        <input type="hidden" name="workspaceId" value={workspaceId} />
      ) : null}
    </>
  );
}

function BusinessDefaultBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {BUSINESS_DEFAULT_SOURCE_LABEL}
    </span>
  );
}

function SaveAsBusinessDefaultControl() {
  const { pending, defaultsAction, defaultsPending, defaultsError, defaultsStatus } =
    useEstimatingTakeoff();
  return (
    <div className="space-y-1 rounded-lg border border-dashed border-border/80 bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">
        Save as business default stores reusable pricing for future estimates
        using this calculator — labor rate, bag yield, waste, markup, standard
        material prices, and owner-added materials marked “Save with this
        calculator as business default”. It does not save this job’s
        dimensions, labor add-ons, or rounded totals.
      </p>
      <Button
        type="submit"
        formAction={defaultsAction}
        variant="outline"
        disabled={pending}
      >
        {defaultsPending ? "Saving default…" : "Save as business default"}
      </Button>
      {defaultsError ? (
        <Alert variant="destructive">
          <AlertDescription>{defaultsError}</AlertDescription>
        </Alert>
      ) : null}
      {defaultsStatus ? (
        <p className="text-xs text-muted-foreground">{defaultsStatus}</p>
      ) : null}
    </div>
  );
}

export function LaborTakeoffPanel() {
  const {
    fieldId,
    takeoffType,
    draft,
    setDraft,
    setInput,
    pending,
    laborPending,
    laborAction,
    laborError,
    laborStatus,
    laborRecommendation,
    showConcreteLabor,
    showGenericLabor,
    defaultSources,
  } = useEstimatingTakeoff();

  return (
    <form className="space-y-4">
      <TakeoffHiddenFields />
      <p className="text-sm font-medium">Labor Takeoff / Labor Calculator</p>
      <p className="text-xs text-muted-foreground">
        Permanent labor calculator for this trade. It follows the takeoff type
        selected in Materials ({TAKEOFF_TYPE_LABELS[takeoffType]}).
      </p>
      {showConcreteLabor ? (
        <>
          <p className="text-xs text-muted-foreground">
            The $36 / 60-lb bag production rate (configurable) is the starting
            model for a normal complete slab. It already covers{" "}
            {CONCRETE_PRODUCTION_LABOR_COVERS.join(", ")}. Those tasks are not
            stacked on top of the bag production labor.
          </p>
          <TakeoffDecimalField
            id={`labor-rate-${fieldId}`}
            label={
              laborRecommendation.rateLabel || "Labor production rate / 60-lb bag"
            }
            value={laborRecommendation.rate}
            fromBusinessDefault={defaultSources.laborRate}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                laborRate: value ?? 0,
              }))
            }
          />
          <TakeoffDecimalField
            id={`labor-adjustment-${fieldId}`}
            label="Labor adjustments / add-ons"
            value={draft.laborAdjustment ?? 0}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                laborAdjustment: value ?? 0,
              }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Use add-ons only for work outside the normal production assumption
            (unusual excavation/prep, demolition, difficult access, thickened
            edges/footings, specialty finish, unusual reinforcement).
          </p>
        </>
      ) : null}
      {showGenericLabor ? (
        <>
          <p className="text-xs text-muted-foreground">
            No specialized labor formula is registered for this work. Enter
            quantity, rate, and any extras. Do not invent trade production math
            here.
          </p>
          <GenericCustomInputs draft={draft} setInput={setInput} />
          <TakeoffDecimalField
            id={`labor-rate-${fieldId}`}
            label={laborRecommendation.rateLabel || "Labor rate"}
            value={draft.laborRate}
            fromBusinessDefault={defaultSources.laborRate}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                laborRate: value ?? 0,
              }))
            }
          />
          <TakeoffDecimalField
            id={`labor-adjustment-${fieldId}`}
            label="Labor adjustments / add-ons"
            value={draft.laborAdjustment ?? 0}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                laborAdjustment: value ?? 0,
              }))
            }
          />
        </>
      ) : null}
      {!showConcreteLabor && !showGenericLabor ? (
        <p className="text-xs text-muted-foreground">
          {laborRecommendation.unavailableReason ||
            "Enter labor on the original request line. A specialized labor calculator is not registered for this takeoff type yet."}
        </p>
      ) : null}
      <dl className="grid gap-1 text-sm">
        {laborRecommendation.productionQuantityLabel ? (
          <div className="flex justify-between gap-3">
            <dt>Calculated production quantity</dt>
            <dd className="tabular-nums">
              {laborRecommendation.productionQuantityLabel}
            </dd>
          </div>
        ) : null}
        {showConcreteLabor || showGenericLabor ? (
          <div className="flex justify-between gap-3">
            <dt>
              {showConcreteLabor
                ? "Labor production rate"
                : laborRecommendation.rateLabel || "Labor rate"}
            </dt>
            <dd className="tabular-nums">
              {laborRecommendation.rate > 0
                ? `${formatMoney(laborRecommendation.rate)}${
                    showConcreteLabor ? " / 60-lb bag" : ""
                  }`
                : "—"}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt>Base recommended labor</dt>
          <dd className="tabular-nums">
            {laborRecommendation.available || laborRecommendation.baseLabor > 0
              ? formatMoney(laborRecommendation.baseLabor)
              : "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Applicable labor adjustments/add-ons</dt>
          <dd className="tabular-nums">
            {formatMoney(laborRecommendation.laborAdjustment)}
          </dd>
        </div>
        <div className="flex justify-between gap-3 font-medium">
          <dt>Recommended Labor Total</dt>
          <dd className="tabular-nums">
            {laborRecommendation.available
              ? formatMoney(laborRecommendation.recommendedLabor)
              : "—"}
          </dd>
        </div>
      </dl>
      {laborRecommendation.unavailableReason ? (
        <p className="text-xs text-muted-foreground">
          {laborRecommendation.unavailableReason}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Apply updates the original request labor/work line only. It never
          silently overwrites labor later, never copies material totals into
          LABOR, and does not convert MATERIAL lines.
        </p>
      )}
      <Button
        type="submit"
        formAction={laborAction}
        variant="outline"
        disabled={pending || !laborRecommendation.available}
      >
        {laborPending ? "Applying…" : "Apply recommended labor to estimate"}
      </Button>
      {laborError ? (
        <Alert variant="destructive">
          <AlertDescription>{laborError}</AlertDescription>
        </Alert>
      ) : null}
      {laborStatus ? (
        <p className="text-xs text-muted-foreground">{laborStatus}</p>
      ) : null}
      <SaveAsBusinessDefaultControl />
    </form>
  );
}

export function MaterialTakeoffPanel({
  showReset = false,
}: {
  showReset?: boolean;
}) {
  const {
    estimateId,
    lineItemId,
    fieldId,
    takeoffType,
    changeType,
    draft,
    setDraft,
    setInput,
    patchItem,
    removeItem,
    addCustom,
    applyMarkupToSelected,
    calculateFromInputs,
    pending,
    savePending,
    convertPending,
    saveAction,
    convertAction,
    materialError,
    materialStatus,
    markupStatus,
    internalTotal,
    customerTotal,
    defaultSources,
    customLabel,
    setCustomLabel,
    customUnit,
    setCustomUnit,
    customQty,
    setCustomQty,
    customCost,
    setCustomCost,
    customPrice,
    setCustomPrice,
  } = useEstimatingTakeoff();

  return (
    <div className="space-y-4">
      <form className="space-y-4">
        <TakeoffHiddenFields />
        <p className="text-sm font-medium">Material Takeoff / Material Calculator</p>
        <p className="text-xs text-muted-foreground">
          Permanent material calculator for this trade. Calculate quantities,
          review costs and markup, then convert selected items into the customer
          material list. Cost is never treated as the selling price.
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
          <Label htmlFor={`takeoff-type-${fieldId}`}>Takeoff type</Label>
          <select
            id={`takeoff-type-${fieldId}`}
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
          <ConcreteInputs
            draft={draft}
            setInput={setInput}
            defaultSources={defaultSources}
          />
        ) : null}
        {takeoffType === "sheet-covering" ? (
          <SheetInputs draft={draft} setInput={setInput} />
        ) : null}
        {takeoffType === "framed-wall" ? (
          <FramedInputs draft={draft} setInput={setInput} />
        ) : null}

        <TakeoffDecimalField
          id={`waste-${fieldId}`}
          label="Waste %"
          value={draft.wastePercent}
          fromBusinessDefault={defaultSources.wastePercent}
          onChange={(value) =>
            setDraft((current) => ({
              ...current,
              wastePercent: value ?? 0,
            }))
          }
        />

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
        <SaveAsBusinessDefaultControl />

        {materialError ? (
          <Alert variant="destructive">
            <AlertDescription>{materialError}</AlertDescription>
          </Alert>
        ) : null}
        {materialStatus ? (
          <p className="text-xs text-muted-foreground">{materialStatus}</p>
        ) : null}

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
                      {item.kind === "custom" ? (
                        <label className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <span>Reuse</span>
                          <select
                            className="h-7 max-w-[16rem] rounded-md border border-input bg-transparent px-1.5 text-[11px]"
                            value={item.persistAs === "business-default" ? "business-default" : "project"}
                            onChange={(event) =>
                              patchItem(item.id, {
                                persistAs:
                                  event.target.value === "business-default"
                                    ? "business-default"
                                    : "project",
                              })
                            }
                          >
                            <option value="project">Project only</option>
                            <option value="business-default">
                              Save with this calculator as business default
                            </option>
                          </select>
                        </label>
                      ) : null}
                      {item.convertedLineItemId ? (
                        <div className="text-muted-foreground">
                          Converted — repeat will not duplicate
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{item.calculatedQuantity}</td>
                    <td className="py-2 pr-2">
                      <TakeoffDecimalField
                        value={item.quantityOverride}
                        placeholder={String(item.calculatedQuantity)}
                        nullable
                        onChange={(value) =>
                          patchItem(item.id, { quantityOverride: value })
                        }
                      />
                    </td>
                    <td className="py-2 pr-2">{item.unit}</td>
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
          </div>
        ) : null}

        <details open className="rounded-lg border border-border/70 bg-muted/20 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced material pricing (owner only)
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Internal cost, markup, and customer unit price stay on this
              workspace. Customers never see these figures — only the material
              description, quantity, and one Final Customer Materials Total.
            </p>
            <div className="space-y-2">
              <TakeoffDecimalField
                id={`markup-${fieldId}`}
                label="Material Markup %"
                value={draft.markupPercent}
                fromBusinessDefault={defaultSources.markupPercent}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    markupPercent: value ?? 0,
                  }))
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={applyMarkupToSelected}
                disabled={pending}
              >
                Apply markup to selected items
              </Button>
              <p className="text-xs text-muted-foreground">
                Sets customer unit price from internal cost for selected items that
                already have a unit cost. Does not change cost, quantity, or waste,
                and does not convert MATERIAL lines. Unselect pickup/procurement
                first if you do not want it marked up.
              </p>
              {markupStatus ? (
                <p className="text-xs text-muted-foreground">{markupStatus}</p>
              ) : null}
            </div>
            {draft.items.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2">Item</th>
                      <th className="py-1 pr-2">Unit cost (internal)</th>
                      <th className="py-1 pr-2">Internal extended</th>
                      <th className="py-1 pr-2">Customer unit price</th>
                      <th className="py-1 pr-2">Customer extended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.items.map((item) => (
                      <tr key={`adv-${item.id}`} className="border-t border-border align-top">
                        <td className="py-2 pr-2">{item.label}</td>
                        <td className="py-2 pr-2">
                          <TakeoffDecimalField
                            value={item.unitCost}
                            placeholder="Internal cost"
                            nullable
                            fromBusinessDefault={defaultSources.itemIds.includes(item.id)}
                            onChange={(value) =>
                              patchItem(item.id, { unitCost: value })
                            }
                          />
                        </td>
                        <td className="py-2 pr-2 tabular-nums">
                          {formatMoney(extendedMaterialCost(item))}
                        </td>
                        <td className="py-2 pr-2">
                          <TakeoffDecimalField
                            value={item.customerUnitPrice}
                            placeholder="Selling price"
                            nullable
                            fromBusinessDefault={defaultSources.itemIds.includes(item.id)}
                            onChange={(value) =>
                              patchItem(item.id, { customerUnitPrice: value })
                            }
                          />
                        </td>
                        <td className="py-2 pr-2 tabular-nums">
                          {formatMoney(extendedCustomerPrice(item))}
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
          </div>
        </details>

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
        <p className="text-xs text-muted-foreground">
          New owner-added materials start as Project only. Mark “Save with this
          calculator as business default” only for reusable items such as Poly
          Plastic or Vegetable Oil, then click Save as business default.
        </p>
      </form>
      {showReset ? (
        <div className="mt-6 border-t border-dashed border-border pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Advanced / recovery
          </p>
          {lineItemId ? (
            <ResetTakeoffAndGeneratedMaterialsForm
              estimateId={estimateId}
              lineItemId={lineItemId}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Calculate or apply from this workspace to restore the original
              request labor/work line. Reset stays available after that line exists.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MaterialTakeoffForm(props: TakeoffFormProps) {
  return (
    <EstimatingTakeoffProvider {...props}>
      <div className="space-y-8">
        <LaborTakeoffPanel />
        <MaterialTakeoffPanel showReset />
      </div>
    </EstimatingTakeoffProvider>
  );
}

function GenericCustomInputs({
  draft,
  setInput,
}: {
  draft: TakeoffSnapshot;
  setInput: (key: string | Record<string, unknown>, value?: unknown) => void;
}) {
  const inputs = emptyGenericCustomInputs(draft.inputs);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TakeoffDecimalField
        label="Labor quantity"
        value={inputs.laborQuantity}
        emptyZero
        onChange={(v) => setInput("laborQuantity", v ?? 1)}
      />
      <div className="space-y-2">
        <Label>Labor unit</Label>
        <Input
          value={inputs.laborUnit}
          onChange={(event) => setInput("laborUnit", event.target.value)}
        />
      </div>
    </div>
  );
}

function ConcreteInputs({
  draft,
  setInput,
  defaultSources,
}: {
  draft: TakeoffSnapshot;
  setInput: (key: string | Record<string, unknown>, value?: unknown) => void;
  defaultSources: ReturnType<typeof businessDefaultFieldSources>;
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
      <TakeoffDecimalField
        label="Thickness (in)"
        value={inputs.thicknessIn}
        fractions
        emptyZero
        onChange={(v) => setInput("thicknessIn", v ?? 0)}
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
      <TakeoffDecimalField
        label="Bag yield (cu ft)"
        value={inputs.bagYieldCuFt}
        emptyZero
        fromBusinessDefault={defaultSources.reusableInputKeys.includes("bagYieldCuFt")}
        onChange={(v) => setInput("bagYieldCuFt", v ?? 0)}
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
  setInput: (key: string | Record<string, unknown>, value?: unknown) => void;
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
      <TakeoffDecimalField
        label="Sliding patio doors"
        value={inputs.slidingPatioDoors}
        integer
        emptyZero
        onChange={(v) => setInput("slidingPatioDoors", v ?? 0)}
      />
      <TakeoffDecimalField
        label="Standard doors"
        value={inputs.standardDoors}
        integer
        emptyZero
        onChange={(v) => setInput("standardDoors", v ?? 0)}
      />
      <TakeoffDecimalField
        label="Windows"
        value={inputs.windows}
        integer
        emptyZero
        onChange={(v) => setInput("windows", v ?? 0)}
      />
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
  setInput: (key: string | Record<string, unknown>, value?: unknown) => void;
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
      <TakeoffDecimalField
        label="Stud spacing (in)"
        value={inputs.studSpacingIn}
        fractions
        emptyZero
        onChange={(v) => setInput("studSpacingIn", v ?? 0)}
      />
      <TakeoffDecimalField
        label="Openings"
        value={inputs.openings}
        integer
        emptyZero
        onChange={(v) => setInput("openings", v ?? 0)}
      />
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
  setInput: (key: string | Record<string, unknown>, value?: unknown) => void,
  prefix: string,
  feet: number,
  inches: number,
) {
  setInput({
    [`${prefix}FtPart`]: feet,
    [`${prefix}InPart`]: inches,
    [`${prefix}Ft`]: feetAndInchesToFeet(feet, inches),
  });
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
        <TakeoffDecimalField
          label="Feet"
          value={feet}
          fractions
          emptyZero
          onChange={(value) => onChange(value ?? 0, inches)}
        />
        <TakeoffDecimalField
          label="Inches"
          value={inches}
          fractions
          emptyZero
          onChange={(value) => onChange(feet, value ?? 0)}
        />
      </div>
    </div>
  );
}

function TakeoffDecimalField({
  id,
  label,
  value,
  onChange,
  placeholder,
  fractions = false,
  integer = false,
  nullable = false,
  emptyZero = false,
  fromBusinessDefault = false,
}: {
  id?: string;
  label?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  fractions?: boolean;
  integer?: boolean;
  nullable?: boolean;
  emptyZero?: boolean;
  fromBusinessDefault?: boolean;
}) {
  const [text, setText] = useState(() => formatTakeoffNumericDraft(value, emptyZero));

  useEffect(() => {
    setText((current) => {
      if (isIncompleteNumericDraft(current)) return current;
      if (current.trim() === "" && (value === null || (emptyZero && value === 0))) {
        return current;
      }
      const parsed = parseTakeoffNumericInput(
        current,
        integer ? "integer" : fractions ? "construction" : "decimal",
      );
      if (parsed.status === "ok" && parsed.value != null && value != null && Math.abs(parsed.value - value) < 1e-9) {
        return current;
      }
      return formatTakeoffNumericDraft(value, emptyZero);
    });
  }, [emptyZero, fractions, integer, value]);

  const input = (
    <Input
      id={id}
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseTakeoffNumericInput(
          next,
          integer ? "integer" : fractions ? "construction" : "decimal",
        );
        if (parsed.status === "incomplete") return;
        if (parsed.status === "empty") {
          onChange(nullable ? null : 0);
          return;
        }
        if (parsed.status === "ok" && parsed.value != null) onChange(parsed.value);
      }}
    />
  );

  if (!label) {
    return (
      <div className="space-y-1">
        {input}
        {fromBusinessDefault ? (
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {BUSINESS_DEFAULT_SOURCE_LABEL}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
        <BusinessDefaultBadge show={fromBusinessDefault} />
      </Label>
      {input}
    </div>
  );
}

function formatTakeoffNumericDraft(value: number | null, emptyZero = false): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (emptyZero && value === 0) return "";
  return String(value);
}
