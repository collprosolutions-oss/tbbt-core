"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/messages";

export type SaasOperatingUiState = {
  canOperate: boolean;
  requiresSubscription: boolean;
  role: "OWNER" | "ADMIN" | "MEMBER";
  blockedMessage: string;
};

const DEFAULT_STATE: SaasOperatingUiState = {
  canOperate: true,
  requiresSubscription: false,
  role: "OWNER",
  blockedMessage: SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
};

const SaasOperatingContext = createContext<SaasOperatingUiState>(DEFAULT_STATE);

export function SaasOperatingProvider({
  value,
  children,
}: {
  value: SaasOperatingUiState;
  children: ReactNode;
}) {
  return <SaasOperatingContext.Provider value={value}>{children}</SaasOperatingContext.Provider>;
}

export function useSaasOperating() {
  return useContext(SaasOperatingContext);
}

export function operatingBlockedMessage(role: "OWNER" | "ADMIN" | "MEMBER") {
  return role === "OWNER"
    ? SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE
    : SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE;
}

export function OperatingWriteGate({
  children,
  fallbackLabel,
}: {
  children?: ReactNode;
  fallbackLabel?: string;
}) {
  const operating = useSaasOperating();
  if (operating.canOperate) return <>{children}</>;
  return (
    <div className="space-y-1">
      {fallbackLabel ? (
        <Button type="button" size="sm" disabled>
          {fallbackLabel}
        </Button>
      ) : null}
      <p className="max-w-sm text-sm text-muted-foreground">{operating.blockedMessage}</p>
    </div>
  );
}
