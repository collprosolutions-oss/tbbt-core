import { validateAccessArrangement } from "@/lib/property-access";

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function readAccessArrangementFromFormData(formData: FormData) {
  return validateAccessArrangement({
    method: readString(formData, "accessMethod"),
    instructions: readString(formData, "accessInstructions"),
    contactName: readString(formData, "accessContactName"),
    contactInfo: readString(formData, "accessContactInfo"),
    pickupLocation: readString(formData, "accessPickupLocation"),
    note: readString(formData, "accessNote"),
  });
}
