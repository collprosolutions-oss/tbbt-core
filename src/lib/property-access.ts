/**
 * Data-driven property access methods for appointment confirmation.
 * Not trade-specific. Required extra fields are declared here so portal
 * and owner forms stay aligned, and so KEY_PICKUP_REQUIRED keeps a
 * structured pickup location for later scheduling (not a routing engine).
 */

export const PROPERTY_ACCESS_METHODS = [
  {
    id: "CUSTOMER_PRESENT",
    label: "I will be there to let you in",
    ownerLabel: "Customer will be present",
    requireInstructions: false,
    requirePickupLocation: false,
    askWhoWillBeThere: false,
  },
  {
    id: "OTHER_PERSON_PRESENT",
    label: "Someone else will be there to let you in",
    ownerLabel: "Someone else will be present",
    requireInstructions: false,
    requirePickupLocation: false,
    askWhoWillBeThere: true,
  },
  {
    id: "KEY_AT_PROPERTY",
    label: "I will leave a key at the property",
    ownerLabel: "Key at property",
    instructionsLabel: "Where will the key be located?",
    requireInstructions: true,
    requirePickupLocation: false,
    askWhoWillBeThere: false,
  },
  {
    id: "ACCESS_CODE",
    label: "Use a door, gate, lockbox, or other access code",
    ownerLabel: "Access code",
    instructionsLabel: "Access instructions",
    requireInstructions: true,
    requirePickupLocation: false,
    askWhoWillBeThere: false,
  },
  {
    id: "CONTRACTOR_HAS_KEY",
    label: "The contractor already has the key",
    ownerLabel: "Contractor already has the key",
    requireInstructions: false,
    requirePickupLocation: false,
    askWhoWillBeThere: false,
  },
  {
    id: "KEY_PICKUP_REQUIRED",
    label: "The contractor needs to pick up the key before the appointment",
    ownerLabel: "Key pickup required",
    pickupLabel: "Where should the key be picked up?",
    requireInstructions: false,
    requirePickupLocation: true,
    askWhoWillBeThere: false,
  },
  {
    id: "EXTERIOR_NO_ENTRY",
    label: "No interior access is required",
    ownerLabel: "No interior access is required",
    requireInstructions: false,
    requirePickupLocation: false,
    askWhoWillBeThere: false,
  },
  {
    id: "OTHER",
    label: "Other access arrangement",
    ownerLabel: "Other access arrangement",
    instructionsLabel: "Access instructions",
    requireInstructions: true,
    requirePickupLocation: false,
    askWhoWillBeThere: false,
  },
] as const;

export type PropertyAccessMethodId = (typeof PROPERTY_ACCESS_METHODS)[number]["id"];

export type AccessArrangement = {
  method: PropertyAccessMethodId;
  instructions: string | null;
  contactName: string | null;
  contactInfo: string | null;
  pickupLocation: string | null;
  note: string | null;
};

export type AccessArrangementInput = {
  method: string;
  instructions?: string;
  contactName?: string;
  contactInfo?: string;
  pickupLocation?: string;
  note?: string;
};

const MAX_INSTRUCTIONS = 500;
const MAX_NAME = 120;
const MAX_CONTACT = 120;
const MAX_PICKUP = 240;
const MAX_NOTE = 500;

function trimToNull(value: string | null | undefined, max: number) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function propertyAccessMethodById(id: string | null | undefined) {
  return PROPERTY_ACCESS_METHODS.find((method) => method.id === id) ?? null;
}

export function isPropertyAccessMethodId(
  value: string | null | undefined,
): value is PropertyAccessMethodId {
  return Boolean(propertyAccessMethodById(value ?? ""));
}

export function validateAccessArrangement(
  input: AccessArrangementInput,
): { ok: true; value: AccessArrangement } | { ok: false; error: string } {
  const method = propertyAccessMethodById(input.method);
  if (!method) {
    return { error: "Choose how the contractor will access the property.", ok: false };
  }

  const instructions = trimToNull(input.instructions, MAX_INSTRUCTIONS);
  const contactName = trimToNull(input.contactName, MAX_NAME);
  const contactInfo = trimToNull(input.contactInfo, MAX_CONTACT);
  const pickupLocation = trimToNull(input.pickupLocation, MAX_PICKUP);
  const note = trimToNull(input.note, MAX_NOTE);

  if (method.requireInstructions && !instructions) {
    return {
      ok: false,
      error: method.instructionsLabel
        ? `${method.instructionsLabel} is required.`
        : "Access instructions are required.",
    };
  }
  if (method.requirePickupLocation && !pickupLocation) {
    return {
      ok: false,
      error: method.pickupLabel
        ? `${method.pickupLabel}`
        : "Enter where the key should be picked up.",
    };
  }

  return {
    ok: true,
    value: {
      method: method.id,
      instructions,
      contactName,
      contactInfo,
      pickupLocation,
      note,
    },
  };
}

export function accessArrangementFromJob(job: {
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessContactName: string | null;
  propertyAccessContactInfo: string | null;
  propertyAccessPickupLocation: string | null;
  propertyAccessNote: string | null;
}): AccessArrangement | null {
  if (!isPropertyAccessMethodId(job.propertyAccessMethod)) {
    return null;
  }
  return {
    method: job.propertyAccessMethod,
    instructions: job.propertyAccessInstructions,
    contactName: job.propertyAccessContactName,
    contactInfo: job.propertyAccessContactInfo,
    pickupLocation: job.propertyAccessPickupLocation,
    note: job.propertyAccessNote,
  };
}

export function isAccessArrangementComplete(job: {
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessContactName: string | null;
  propertyAccessContactInfo: string | null;
  propertyAccessPickupLocation: string | null;
  propertyAccessNote: string | null;
}) {
  const current = accessArrangementFromJob(job);
  if (!current) return false;
  return validateAccessArrangement({
    method: current.method,
    instructions: current.instructions ?? undefined,
    contactName: current.contactName ?? undefined,
    contactInfo: current.contactInfo ?? undefined,
    pickupLocation: current.pickupLocation ?? undefined,
    note: current.note ?? undefined,
  }).ok;
}

export function accessArrangementWriteData(value: AccessArrangement) {
  return {
    propertyAccessMethod: value.method,
    propertyAccessInstructions: value.instructions,
    propertyAccessContactName: value.contactName,
    propertyAccessContactInfo: value.contactInfo,
    propertyAccessPickupLocation: value.pickupLocation,
    propertyAccessNote: value.note,
  };
}

export function hasSensitiveAccessDetails(job: {
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessPickupLocation: string | null;
}) {
  if (!job.propertyAccessMethod) return false;
  return Boolean(
    job.propertyAccessInstructions?.trim() || job.propertyAccessPickupLocation?.trim(),
  );
}

export function accessFormValuesFromJob(job: {
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessContactName: string | null;
  propertyAccessContactInfo: string | null;
  propertyAccessPickupLocation: string | null;
  propertyAccessNote: string | null;
}) {
  return {
    method: job.propertyAccessMethod ?? "",
    instructions: job.propertyAccessInstructions ?? "",
    contactName: job.propertyAccessContactName ?? "",
    contactInfo: job.propertyAccessContactInfo ?? "",
    pickupLocation: job.propertyAccessPickupLocation ?? "",
    note: job.propertyAccessNote ?? "",
  };
}

export function ownerAccessSummaryLines(job: {
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessContactName: string | null;
  propertyAccessContactInfo: string | null;
  propertyAccessPickupLocation: string | null;
  propertyAccessNote: string | null;
}) {
  const method = propertyAccessMethodById(job.propertyAccessMethod);
  if (!method) {
    return ["Access arrangement has not been recorded."];
  }
  const lines = [`Access: ${method.ownerLabel}`];
  if (job.propertyAccessContactName) {
    lines.push(`Who will be there: ${job.propertyAccessContactName}`);
  }
  if (job.propertyAccessContactInfo) {
    lines.push(`Contact: ${job.propertyAccessContactInfo}`);
  }
  if (job.propertyAccessPickupLocation) {
    lines.push(`Pickup: ${job.propertyAccessPickupLocation}`);
  }
  if (job.propertyAccessInstructions) {
    lines.push(`Access instructions: ${job.propertyAccessInstructions}`);
  }
  if (job.propertyAccessNote) {
    lines.push(`Note: ${job.propertyAccessNote}`);
  }
  return lines;
}
