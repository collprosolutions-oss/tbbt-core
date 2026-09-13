"use client";

import { useActionState, useState } from "react";
import {
  submitCustomerAppointmentAction,
  type CustomerAppointmentActionState,
} from "@/app/actions/public-appointment";
import {
  AccessArrangementFields,
  type AccessArrangementFieldValues,
} from "@/components/appointments/access-arrangement-fields";
import { Button } from "@/components/ui/button";
import {
  APPOINTMENT_ACTION_CONFIRM,
  APPOINTMENT_ACTION_FIELD,
  APPOINTMENT_ACTION_REQUEST_DIFFERENT_TIME,
  APPOINTMENT_CHANGE_REQUEST_NOTE_FIELD,
} from "@/lib/appointment-change-request";

const initialState: CustomerAppointmentActionState = {};

const emptyAccess: AccessArrangementFieldValues = {
  method: "",
  instructions: "",
  contactName: "",
  contactInfo: "",
  pickupLocation: "",
  note: "",
};

export function PortalAppointmentActions({
  projectToken,
  appointmentProposalId,
  canConfirm,
  canRequestDifferentTime,
  existingAccess,
}: {
  projectToken: string;
  appointmentProposalId: number;
  canConfirm: boolean;
  canRequestDifferentTime: boolean;
  existingAccess: AccessArrangementFieldValues;
}) {
  const [state, formAction, pending] = useActionState(
    submitCustomerAppointmentAction,
    initialState,
  );
  const [access, setAccess] = useState<AccessArrangementFieldValues>(
    existingAccess.method ? existingAccess : emptyAccess,
  );

  return (
    <div className="space-y-6">
      {canRequestDifferentTime ? (
        <form action={formAction} className="space-y-3" id="request-different-time">
          <input type="hidden" name="projectToken" value={projectToken} />
          <input
            type="hidden"
            name="appointmentProposalId"
            value={String(appointmentProposalId)}
          />
          <input
            type="hidden"
            name={APPOINTMENT_ACTION_FIELD}
            value={APPOINTMENT_ACTION_REQUEST_DIFFERENT_TIME}
          />
          <div className="space-y-2">
            <label
              htmlFor="appointmentChangeRequestNote"
              className="text-sm font-medium"
            >
              When would work better? (optional)
            </label>
            <textarea
              id="appointmentChangeRequestNote"
              name={APPOINTMENT_CHANGE_REQUEST_NOTE_FIELD}
              maxLength={500}
              className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
            />
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Sending…" : "Request Different Time"}
          </Button>
          {state.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
        </form>
      ) : null}

      {canConfirm ? (
        <form action={formAction} className="space-y-3" id="confirm-appointment">
          <input type="hidden" name="projectToken" value={projectToken} />
          <input
            type="hidden"
            name="appointmentProposalId"
            value={String(appointmentProposalId)}
          />
          <input
            type="hidden"
            name={APPOINTMENT_ACTION_FIELD}
            value={APPOINTMENT_ACTION_CONFIRM}
          />
          <AccessArrangementFields
            idPrefix="portal"
            values={access}
            onChange={setAccess}
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Confirming…" : "Confirm Appointment"}
          </Button>
          {state.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
