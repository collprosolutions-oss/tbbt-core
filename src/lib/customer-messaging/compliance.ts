/**
 * External setup still required before TBBT can send production SMS.
 * The Twilio adapter does not make TBBT 10DLC/A2P compliant by existing.
 *
 * Twilio Advanced Opt-Out mapping (Messaging Service must have it enabled):
 * - STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT → REVOKED
 * - START / YES / UNSTOP restores only REVOKED → GRANTED (never UNKNOWN → GRANTED)
 * - HELP / INFO: Twilio sends the configured help auto-reply; TBBT does not
 *   invent a customer-service answer and does not change consent
 * - Any other inbound body is ignored for consent
 */
export const TWILIO_COMPLIANCE_SETUP_REQUIRED = [
  "Twilio account (not created by this PR)",
  "US A2P 10DLC Brand registration for the sending business (Trust Hub)",
  "A2P 10DLC Campaign for operational/customer-care use (not marketing)",
  "Twilio Messaging Service with Advanced Opt-Out enabled (STOP/START/HELP auto-replies)",
  "A provisioned US long code assigned to that Messaging Service (purchase is external)",
  "Campaign sample messages matching estimate/appointment/invoice/review operational copy",
  "Opt-in language on the public request form (implemented in TBBT; must match the campaign)",
  "Privacy and Terms URLs on the 10DLC campaign (https://www.tbbtool.com/privacy and /terms)",
  "Webhook: inbound messages + status callbacks to /api/customer-messaging/webhook over HTTPS",
  "Business.operationalSmsNumber set to the normalized receiving digits for tenant routing",
  "Vercel env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER",
] as const;

export const SMS_CONSENT_PRIVACY_URL = "https://www.tbbtool.com/privacy";
export const SMS_CONSENT_TERMS_URL = "https://www.tbbtool.com/terms";

export const SMS_OPT_IN_LABEL =
  "I agree to receive operational text messages about this request (estimates, appointments, invoices, and payment reminders). Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not required to request work.";

export const SMS_TRANSACTIONAL_OPT_OUT_FOOTER =
  "Msg & data rates may apply. Reply STOP to opt out.";
