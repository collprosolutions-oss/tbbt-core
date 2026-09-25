import type { CommunicationComposeTemplate } from "@/lib/communications/types";

export type CommunicationTemplateContext = {
  businessName: string;
  customerName: string;
  relatedLabel?: string | null;
};

export function renderCommunicationTemplate(
  template: CommunicationComposeTemplate,
  context: CommunicationTemplateContext,
) {
  const business = context.businessName.trim() || "Your contractor";
  const customer = context.customerName.trim() || "there";
  const related = context.relatedLabel?.trim();

  if (template === "estimate_follow_up") {
    return {
      subject: `${business} follow-up on your estimate`,
      body: related
        ? `Hi ${customer}, just checking whether you had any questions about the estimate (${related}) from ${business}. Reply to this message and we can help.`
        : `Hi ${customer}, just checking whether you had any questions about the estimate from ${business}. Reply to this message and we can help.`,
    };
  }
  if (template === "appointment_reminder") {
    return {
      subject: `${business} appointment reminder`,
      body: related
        ? `Hi ${customer}, this is a reminder of your upcoming appointment with ${business} (${related}).`
        : `Hi ${customer}, this is a reminder of your upcoming appointment with ${business}.`,
    };
  }
  if (template === "job_update") {
    return {
      subject: `${business} job update`,
      body: related
        ? `Hi ${customer}, ${business} has an update on your job (${related}).`
        : `Hi ${customer}, ${business} has an update on your job.`,
    };
  }
  if (template === "invoice_reminder") {
    return {
      subject: `${business} invoice reminder`,
      body: related
        ? `Hi ${customer}, this is a reminder that an invoice from ${business} is still unpaid (${related}).`
        : `Hi ${customer}, this is a reminder that an invoice from ${business} is still unpaid.`,
    };
  }
  if (template === "review_request") {
    return {
      subject: `How did we do? A review request from ${business}`,
      body: `Hi ${customer}, thanks for hiring ${business}. If the work went well, a short review helps other neighbors find us.`,
    };
  }
  return {
    subject: `Message from ${business}`,
    body: `Hi ${customer},`,
  };
}
