import type { CustomerMessagePurpose } from "@/lib/customer-messaging/types";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog/codes";
import type { CommunicationComposeTemplate } from "@/lib/communications/types";

export function productCapabilityForPurpose(
  purpose: CustomerMessagePurpose | string,
): ProductCapabilityCode {
  if (
    purpose === "ESTIMATE_READY" ||
    purpose === "ESTIMATE_FOLLOW_UP" ||
    purpose === "INVOICE_READY" ||
    purpose === "PAYMENT_REMINDER"
  ) {
    return PRODUCT_CAPABILITIES.ESTIMATES_INVOICES;
  }
  if (
    purpose === "APPOINTMENT_CONFIRMATION" ||
    purpose === "APPOINTMENT_REMINDER" ||
    purpose === "SCHEDULE_CHANGE" ||
    purpose === "JOB_UPDATE"
  ) {
    return PRODUCT_CAPABILITIES.SCHEDULING;
  }
  return PRODUCT_CAPABILITIES.CRM;
}

export function purposeForComposeTemplate(
  template: CommunicationComposeTemplate,
): CustomerMessagePurpose {
  if (template === "estimate_follow_up") return "ESTIMATE_FOLLOW_UP";
  if (template === "appointment_reminder") return "APPOINTMENT_REMINDER";
  if (template === "job_update") return "JOB_UPDATE";
  if (template === "invoice_reminder") return "PAYMENT_REMINDER";
  if (template === "review_request") return "REVIEW_REQUEST";
  return "GENERAL";
}

export function productCapabilityForTemplate(template: CommunicationComposeTemplate) {
  return productCapabilityForPurpose(purposeForComposeTemplate(template));
}
