import type { Prisma, PrismaClient } from "@prisma/client";
import { parseAppointmentChangeRequestNote } from "@/lib/appointment-confirmation";
import {
  propertyAccessMethodById,
  type AccessArrangement,
} from "@/lib/property-access";

export const APPOINTMENT_ACTION_FIELD = "appointmentAction";
export const APPOINTMENT_ACTION_CONFIRM = "confirm";
export const APPOINTMENT_ACTION_REQUEST_DIFFERENT_TIME = "request-different-time";
export const APPOINTMENT_CHANGE_REQUEST_NOTE_FIELD = "appointmentChangeRequestNote";

/** Exact founder E2E note that the pre-fix write mixed into access fields. */
export const FOUNDER_TEST_CHANGE_REQUEST_NOTE = "make it 9am instead";

export const PROPERTY_ACCESS_COLUMN_KEYS = [
  "propertyAccessMethod",
  "propertyAccessInstructions",
  "propertyAccessContactName",
  "propertyAccessContactInfo",
  "propertyAccessPickupLocation",
  "propertyAccessNote",
] as const;

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

export function accessTextIsMisfiledChangeRequest(
  value: string | null | undefined,
  changeRequestNote?: string | null,
) {
  const text = value?.trim() ?? "";
  if (!text) return false;
  if (text === FOUNDER_TEST_CHANGE_REQUEST_NOTE) return true;
  const note = changeRequestNote?.trim();
  return Boolean(note && text === note);
}

export function snapshotPropertyAccess(job: {
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessContactName: string | null;
  propertyAccessContactInfo: string | null;
  propertyAccessPickupLocation: string | null;
  propertyAccessNote: string | null;
}) {
  return {
    propertyAccessMethod: job.propertyAccessMethod,
    propertyAccessInstructions: job.propertyAccessInstructions,
    propertyAccessContactName: job.propertyAccessContactName,
    propertyAccessContactInfo: job.propertyAccessContactInfo,
    propertyAccessPickupLocation: job.propertyAccessPickupLocation,
    propertyAccessNote: job.propertyAccessNote,
  };
}

export function propertyAccessSnapshotsEqual(
  left: ReturnType<typeof snapshotPropertyAccess>,
  right: ReturnType<typeof snapshotPropertyAccess>,
) {
  return PROPERTY_ACCESS_COLUMN_KEYS.every((key) => left[key] === right[key]);
}

/**
 * Confirm/reconfirm must not persist a scheduling-request note as access.
 * If the only "instructions" were that note, keep a complete method that
 * does not require instructions so Customer Confirmed stays valid.
 */
export function withoutMisfiledChangeRequestAccess(
  access: AccessArrangement,
  job: {
    appointmentChangeRequestNote?: string | null;
  },
): AccessArrangement {
  let instructions = access.instructions;
  let note = access.note;
  let method = access.method;
  if (accessTextIsMisfiledChangeRequest(instructions, job.appointmentChangeRequestNote)) {
    instructions = null;
  }
  if (accessTextIsMisfiledChangeRequest(note, job.appointmentChangeRequestNote)) {
    note = null;
  }
  const methodDef = propertyAccessMethodById(method);
  if (methodDef?.requireInstructions && !instructions) {
    method = "CUSTOMER_PRESENT";
  }
  return {
    ...access,
    method,
    instructions,
    note,
  };
}

type AppointmentClient = PrismaClient | Prisma.TransactionClient;

/**
 * Preview shares Production. The pre-fix write left the founder test note
 * in property-access columns. Clear that exact text from access fields only.
 */
export async function repairMisfiledChangeRequestAccessFields(db: AppointmentClient) {
  await db.$executeRaw`
    UPDATE "Job"
    SET
      "propertyAccessMethod" = CASE
        WHEN "propertyAccessInstructions" = ${FOUNDER_TEST_CHANGE_REQUEST_NOTE}
          AND "propertyAccessMethod" IN ('ACCESS_CODE', 'KEY_AT_PROPERTY', 'OTHER')
        THEN 'CUSTOMER_PRESENT'
        ELSE "propertyAccessMethod"
      END,
      "propertyAccessInstructions" = CASE
        WHEN "propertyAccessInstructions" = ${FOUNDER_TEST_CHANGE_REQUEST_NOTE} THEN NULL
        ELSE "propertyAccessInstructions"
      END,
      "propertyAccessNote" = CASE
        WHEN "propertyAccessNote" = ${FOUNDER_TEST_CHANGE_REQUEST_NOTE} THEN NULL
        ELSE "propertyAccessNote"
      END
    WHERE "propertyAccessInstructions" = ${FOUNDER_TEST_CHANGE_REQUEST_NOTE}
       OR "propertyAccessNote" = ${FOUNDER_TEST_CHANGE_REQUEST_NOTE}
  `;
}
