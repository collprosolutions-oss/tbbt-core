import { DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER } from "@/lib/customer-messaging/config";
import type {
  CustomerMessageSendInput,
  CustomerMessagingProvider,
  CustomerMessageSendResult,
} from "@/lib/customer-messaging/types";

/**
 * Default adapter. Does not talk to any vendor, does not mint a
 * provider message id, and never reports SENT/DELIVERED.
 */
export function createDisconnectedCustomerMessagingProvider(): CustomerMessagingProvider {
  return {
    id: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
    connected: false,
    async send(_input: CustomerMessageSendInput): Promise<CustomerMessageSendResult> {
      return {
        ok: false,
        status: "NOT_SENT",
        error: "SMS delivery is not connected.",
      };
    },
  };
}
