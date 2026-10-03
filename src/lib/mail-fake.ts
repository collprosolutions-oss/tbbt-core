import { randomUUID } from "node:crypto";
import { signResendWebhook } from "@/lib/mail-webhook-signature";

export const FAKE_EMAIL_ADAPTER = "fake";

export type FakeTransactionalEmailInput = {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  kind: string;
  purpose?: string;
  businessId: string;
};

export type FakeTransactionalEmailSender = {
  sent: FakeTransactionalEmailInput[];
  failNext: boolean;
  throwNext: boolean;
  setFailNext(value: boolean): void;
  setThrowNext(value: boolean): void;
  send(input: FakeTransactionalEmailInput): Promise<{ id?: string; error?: string }>;
};

export function isFakeEmailAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_EMAIL_ADAPTER === "fake";
}

export function signFakeResendWebhook(input: {
  secret: string;
  payload: string;
  id?: string;
  timestamp?: string | number;
}) {
  return signResendWebhook(input);
}

export function createFakeTransactionalEmailSender(): FakeTransactionalEmailSender {
  const sent: FakeTransactionalEmailInput[] = [];
  const sender: FakeTransactionalEmailSender = {
    sent,
    failNext: false,
    throwNext: false,
    setFailNext(value) {
      sender.failNext = value;
    },
    setThrowNext(value) {
      sender.throwNext = value;
    },
    async send(input) {
      if (sender.throwNext) {
        sender.throwNext = false;
        throw new Error("Fake email provider threw.");
      }
      if (sender.failNext) {
        sender.failNext = false;
        return { error: "Fake email provider rejected the message." };
      }
      sent.push(input);
      return { id: `fake_email_${randomUUID()}` };
    },
  };
  return sender;
}
