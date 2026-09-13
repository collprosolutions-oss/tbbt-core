"use client";

import { useActionState, useState } from "react";
import {
  confirmAppointment,
  requestDifferentAppointmentTime,
  type CustomerAppointmentActionState,
} from "@/app/actions/public-appointment";
import {
  AccessArrangementFields,
  type AccessArrangementFieldValues,
} from "@/components/appointments/access-arrangement-fields";
import { Button } from "@/components/ui/button";

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
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmAppointment,
    initialState,
  );
  const [requestState, requestAction, requestPending] = useActionState(
    requestDifferentAppointmentTime,
    initialState,
  );
  const [access, setAccess] = useState<AccessArrangementFieldValues>(
    existingAccess.method ? existingAccess : emptyAccess,
  );

  return (
    <div className="space-y-4">
      {canConfirm ? (
        <form action={confirmAction} className="space-y-3">
          <input type="hidden" name="projectToken" value={projectToken} />
          <input
            type="hidden"
            name="appointmentProposalId"
            value={String(appointmentProposalId)}
          />
          <AccessArrangementFields
            idPrefix="portal"
            values={access}
            onChange={setAccess}
          />
          <Button type="submit" disabled={confirmPending}>
            {confirmPending ? "Confirming…" : "Confirm Appointment"}
          </Button>
          {confirmState.error ? (
            <p className="text-sm text-destructive">{confirmState.error}</p>
          ) : null}
        </form>
      ) : null}

      {canRequestDifferentTime ? (
        <form action={requestAction}>
          <input type="hidden" name="projectToken" value={projectToken} />
          <input
            type="hidden"
            name="appointmentProposalId"
            value={String(appointmentProposalId)}
          />
          <Button type="submit" variant="outline" disabled={requestPending}>
            {requestPending ? "Sending…" : "Request Different Time"}
          </Button>
          {requestState.error ? (
            <p className="mt-2 text-sm text-destructive">{requestState.error}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
