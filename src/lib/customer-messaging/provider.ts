import { createDisconnectedCustomerMessagingProvider } from "@/lib/customer-messaging/disconnected";
import { createFakeCustomerMessagingProvider } from "@/lib/customer-messaging/fake";
import { createTwilioCustomerMessagingProvider } from "@/lib/customer-messaging/twilio";
import {
  getTwilioMessagingConfig,
  isFakeCustomerMessagingAdapterEnabled,
} from "@/lib/customer-messaging/config";
import type { CustomerMessagingProvider } from "@/lib/customer-messaging/types";

let cached: CustomerMessagingProvider | null = null;

export function getCustomerMessagingProvider(): CustomerMessagingProvider {
  if (!cached) {
    if (isFakeCustomerMessagingAdapterEnabled()) {
      cached = createFakeCustomerMessagingProvider();
    } else {
      const twilio = getTwilioMessagingConfig();
      cached = twilio
        ? createTwilioCustomerMessagingProvider(twilio)
        : createDisconnectedCustomerMessagingProvider();
    }
  }
  return cached;
}

export function resetCustomerMessagingProvider() {
  cached = null;
}

export function setCustomerMessagingProvider(provider: CustomerMessagingProvider | null) {
  cached = provider;
}
