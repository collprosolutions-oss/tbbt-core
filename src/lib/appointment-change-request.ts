import { parseAppointmentChangeRequestNote } from "@/lib/appointment-confirmation";

export const APPOINTMENT_ACTION_FIELD = "appointmentAction";
export const APPOINTMENT_ACTION_CONFIRM = "confirm";
export const APPOINTMENT_ACTION_REQUEST_DIFFERENT_TIME = "request-different-time";
export const APPOINTMENT_CHANGE_REQUEST_NOTE_FIELD = "appointmentChangeRequestNote";

const ACCESS_FORM_FIELDS = [
  "accessMethod",
  "accessInstructions",
  "accessContactName",
  "accessContactInfo",
  "accessPickupLocation",
  "accessNote",
] as const;

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function readAppointmentChangeRequestNoteFromFormData(formData: FormData) {
  const dedicated =
    readFormString(formData, APPOINTMENT_CHANGE_REQUEST_NOTE_FIELD) ||
    readFormString(formData, "changeRequestNote");
  return parseAppointmentChangeRequestNote(dedicated);
}

/**
 * Request Different Time is identified by an explicit intent field so a
 * shared/mis-bound Server Action cannot treat the note as Confirm + access.
 * Access field names are never used to decide this.
 */
export function isAppointmentChangeRequestSubmission(formData: FormData) {
  const intent = readFormString(formData, APPOINTMENT_ACTION_FIELD);
  if (intent === APPOINTMENT_ACTION_REQUEST_DIFFERENT_TIME) {
    return true;
  }
  if (intent === APPOINTMENT_ACTION_CONFIRM) {
    return false;
  }
  return Boolean(readAppointmentChangeRequestNoteFromFormData(formData));
}

export function customerDifferentTimeRequestWriteData(note: string | null) {
  return {
    appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED" as const,
    appointmentConfirmedAt: null,
    appointmentConfirmationSource: null,
    appointmentConfirmedByMembershipId: null,
    appointmentChangeRequestNote: note,
  };
}

export function customerDifferentTimeRequestWriteKeys() {
  return Object.keys(customerDifferentTimeRequestWriteData(null));
}

export function customerDifferentTimeRequestTouchesAccess(
  data: Record<string, unknown>,
) {
  return Object.keys(data).some(
    (key) =>
      key.startsWith("propertyAccess") ||
      ACCESS_FORM_FIELDS.includes(key as (typeof ACCESS_FORM_FIELDS)[number]),
  );
}
