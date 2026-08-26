export const PAYMENT_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHECK", label: "Check" },
  { value: "ZELLE_BANK_TRANSFER", label: "Zelle / Bank Transfer" },
  { value: "CARD_EXTERNAL", label: "Card / External Processor" },
  { value: "OTHER", label: "Other" },
] as const;

export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number]["value"];

const PAYMENT_METHOD_VALUES = new Set<string>(
  PAYMENT_METHODS.map((method) => method.value),
);

export function isPaymentMethodValue(
  value: string,
): value is PaymentMethodValue {
  return PAYMENT_METHOD_VALUES.has(value);
}

export function paymentMethodLabel(value: string | null | undefined) {
  if (!value) return null;
  return PAYMENT_METHODS.find((method) => method.value === value)?.label ?? value;
}
