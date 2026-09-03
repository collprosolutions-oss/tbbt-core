export const PAYMENT_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHECK", label: "Check" },
  { value: "ZELLE_BANK_TRANSFER", label: "Zelle / Bank Transfer" },
  { value: "CARD_EXTERNAL", label: "Card / External Processor" },
  { value: "OTHER", label: "Other" },
] as const;

export const PROCESSOR_PAYMENT_METHODS = [
  { value: "STRIPE", label: "Card (Stripe)" },
] as const;

export const INVOICE_PAYMENT_METHOD_FILTERS = [
  ...PAYMENT_METHODS,
  ...PROCESSOR_PAYMENT_METHODS,
] as const;

export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number]["value"];
export type ProcessorPaymentMethodValue =
  (typeof PROCESSOR_PAYMENT_METHODS)[number]["value"];

const PAYMENT_METHOD_VALUES = new Set<string>(
  PAYMENT_METHODS.map((method) => method.value),
);

const ALL_PAYMENT_LABELS = [
  ...PAYMENT_METHODS,
  ...PROCESSOR_PAYMENT_METHODS,
] as const;

export function isPaymentMethodValue(
  value: string,
): value is PaymentMethodValue {
  return PAYMENT_METHOD_VALUES.has(value);
}

export function paymentMethodLabel(value: string | null | undefined) {
  if (!value) return null;
  return ALL_PAYMENT_LABELS.find((method) => method.value === value)?.label ?? value;
}
