import { createDisconnectedCustomerMessagingProvider } from "@/lib/customer-messaging/disconnected";
import { createFakeCustomerMessagingProvider } from "@/lib/customer-messaging/fake";
import { isFakeCustomerMessagingAdapterEnabled } from "@/lib/customer-messaging/config";
import type { CustomerMessagingProvider } from "@/lib/customer-messaging/types";

let cached: CustomerMessagingProvider | null = null;

export function getCustomerMessagingProvider(): CustomerMessagingProvider {
  if (!cached) {
    cached = isFakeCustomerMessagingAdapterEnabled()
      ? createFakeCustomerMessagingProvider()
      : createDisconnectedCustomerMessagingProvider();
  }
  return cached;
}

export function resetCustomerMessagingProvider() {
  cached = null;
}

export function setCustomerMessagingProvider(provider: CustomerMessagingProvider | null) {
  cached = provider;
}
