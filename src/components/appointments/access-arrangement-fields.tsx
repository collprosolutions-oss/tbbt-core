"use client";

import { PROPERTY_ACCESS_METHODS } from "@/lib/property-access";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AccessArrangementFieldValues = {
  method: string;
  instructions: string;
  contactName: string;
  contactInfo: string;
  pickupLocation: string;
  note: string;
};

export function AccessArrangementFields({
  idPrefix,
  values,
  onChange,
}: {
  idPrefix: string;
  values: AccessArrangementFieldValues;
  onChange: (values: AccessArrangementFieldValues) => void;
}) {
  const selected =
    PROPERTY_ACCESS_METHODS.find((method) => method.id === values.method) ?? null;

  function patch(patchValues: Partial<AccessArrangementFieldValues>) {
    onChange({ ...values, ...patchValues });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-accessMethod`}>Access method</Label>
        <select
          id={`${idPrefix}-accessMethod`}
          name="accessMethod"
          value={values.method}
          onChange={(event) => patch({ method: event.target.value })}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          required
        >
          <option value="">Choose how the contractor will get in</option>
          {PROPERTY_ACCESS_METHODS.map((method) => (
            <option key={method.id} value={method.id}>
              {method.label}
            </option>
          ))}
        </select>
      </div>

      {selected?.askWhoWillBeThere ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-accessContactName`}>Who will be there?</Label>
            <Input
              id={`${idPrefix}-accessContactName`}
              name="accessContactName"
              value={values.contactName}
              onChange={(event) => patch({ contactName: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-accessContactInfo`}>Contact information (optional)</Label>
            <Input
              id={`${idPrefix}-accessContactInfo`}
              name="accessContactInfo"
              value={values.contactInfo}
              onChange={(event) => patch({ contactInfo: event.target.value })}
            />
          </div>
        </>
      ) : null}

      {selected?.requirePickupLocation ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-accessPickupLocation`}>
              {selected.pickupLabel ?? "Where should the key be picked up?"}
            </Label>
            <Input
              id={`${idPrefix}-accessPickupLocation`}
              name="accessPickupLocation"
              value={values.pickupLocation}
              onChange={(event) => patch({ pickupLocation: event.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-accessContactName`}>Pickup contact name (optional)</Label>
            <Input
              id={`${idPrefix}-accessContactName`}
              name="accessContactName"
              value={values.contactName}
              onChange={(event) => patch({ contactName: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-accessContactInfo`}>Pickup contact information (optional)</Label>
            <Input
              id={`${idPrefix}-accessContactInfo`}
              name="accessContactInfo"
              value={values.contactInfo}
              onChange={(event) => patch({ contactInfo: event.target.value })}
            />
          </div>
        </>
      ) : null}

      {selected?.requireInstructions ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-accessInstructions`}>
            {selected.instructionsLabel ?? "Access instructions"}
          </Label>
          <textarea
            id={`${idPrefix}-accessInstructions`}
            name="accessInstructions"
            value={values.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            required
            className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
      ) : null}

      {selected &&
      !selected.requireInstructions &&
      !selected.requirePickupLocation &&
      !selected.askWhoWillBeThere ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-accessNote`}>Optional note</Label>
          <textarea
            id={`${idPrefix}-accessNote`}
            name="accessNote"
            value={values.note}
            onChange={(event) => patch({ note: event.target.value })}
            className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
      ) : null}

      {selected?.id === "KEY_PICKUP_REQUIRED" ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-accessInstructions`}>Pickup instructions (optional)</Label>
          <textarea
            id={`${idPrefix}-accessInstructions`}
            name="accessInstructions"
            value={values.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
      ) : null}

      {selected?.askWhoWillBeThere ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-accessInstructions`}>Instructions (optional)</Label>
          <textarea
            id={`${idPrefix}-accessInstructions`}
            name="accessInstructions"
            value={values.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
      ) : null}
    </div>
  );
}
