"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createBankLinkTokenAction,
  disconnectBankConnectionAction,
  exchangeBankPublicTokenAction,
  syncBankConnectionAction,
  type BankConnectActionState,
} from "@/app/actions/bank-connect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BANK_CONNECT_NOT_CONFIGURED_MESSAGE,
  BANK_CONNECT_REVIEW_ONLY_MESSAGE,
  BANK_FEED_NOT_A_BALANCE_MESSAGE,
  bankPlaidStatusLabel,
} from "@/lib/bank-connect-copy";

const initialState: BankConnectActionState = {};

type ConnectBankPanelProps = {
  adapter: "fake" | "plaid" | "unconfigured";
  status: string;
  institutionName: string | null;
  lastSyncedAtLabel: string | null;
  importHref: string | null;
};

declare global {
  interface Window {
    Plaid?: {
      create: (config: {
        token: string;
        onSuccess: (publicToken: string) => void;
        onExit?: (error: unknown) => void;
      }) => { open: () => void };
    };
  }
}

async function loadPlaidLink(): Promise<void> {
  if (window.Plaid) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-tbbt-plaid-link]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Plaid Link failed to load.")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.dataset.tbbtPlaidLink = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Plaid Link failed to load."));
    document.head.appendChild(script);
  });
}

export function ConnectBankPanel({
  adapter,
  status,
  institutionName,
  lastSyncedAtLabel,
  importHref,
}: ConnectBankPanelProps) {
  const [syncState, syncFeed, syncing] = useActionState(
    async () => syncBankConnectionAction(),
    initialState,
  );
  const [disconnectState, disconnectFeed, disconnecting] = useActionState(
    async () => disconnectBankConnectionAction(),
    initialState,
  );
  const [pending, startTransition] = useTransition();
  const [clientError, setClientError] = useState<string | null>(null);

  const error = clientError || syncState.error || disconnectState.error;
  const connected = status === "ACTIVE" || status === "NEEDS_REAUTH";
  const busy = syncing || disconnecting || pending;

  function runLink(updateMode: boolean) {
    setClientError(null);
    startTransition(async () => {
      const form = new FormData();
      if (updateMode) form.set("updateMode", "1");
      const created = await createBankLinkTokenAction({}, form);
      if (created.error || !created.linkToken) {
        setClientError(created.error ?? "Plaid Link could not start.");
        return;
      }
      if (adapter === "fake") {
        const exchange = new FormData();
        exchange.set("publicToken", `public-sandbox-tbbt-${Date.now()}`);
        if (updateMode) exchange.set("updateMode", "1");
        const result = await exchangeBankPublicTokenAction({}, exchange);
        if (result.error) setClientError(result.error);
        return;
      }
      try {
        await loadPlaidLink();
        if (!window.Plaid) {
          setClientError("Plaid Link is unavailable.");
          return;
        }
        window.Plaid.create({
          token: created.linkToken,
          onSuccess: (publicToken) => {
            startTransition(async () => {
              const exchange = new FormData();
              exchange.set("publicToken", publicToken);
              if (updateMode) exchange.set("updateMode", "1");
              const result = await exchangeBankPublicTokenAction({}, exchange);
              if (result.error) setClientError(result.error);
            });
          },
          onExit: (exitError) => {
            if (exitError) setClientError("Bank connection was cancelled.");
          },
        }).open();
      } catch (loadError) {
        setClientError(loadError instanceof Error ? loadError.message : "Plaid Link failed to load.");
      }
    });
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>Plaid review feed</span>
        <Badge variant="outline">{bankPlaidStatusLabel(connected ? status : "DISCONNECTED")}</Badge>
      </div>
      {institutionName && connected ? (
        <p className="text-sm">{institutionName}</p>
      ) : null}
      {lastSyncedAtLabel ? (
        <p className="text-xs text-muted-foreground">Last synced {lastSyncedAtLabel}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">{BANK_CONNECT_REVIEW_ONLY_MESSAGE}</p>
      <p className="text-sm text-muted-foreground">{BANK_FEED_NOT_A_BALANCE_MESSAGE}</p>

      {adapter === "unconfigured" ? (
        <p className="text-sm text-muted-foreground">{BANK_CONNECT_NOT_CONFIGURED_MESSAGE}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {!connected && adapter !== "unconfigured" ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => runLink(false)}>
            Connect bank
          </Button>
        ) : null}
        {status === "NEEDS_REAUTH" ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => runLink(true)}>
            Reconnect bank
          </Button>
        ) : null}
        {status === "ACTIVE" ? (
          <form action={syncFeed}>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              Sync transactions
            </Button>
          </form>
        ) : null}
        {connected ? (
          <form action={disconnectFeed}>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              Disconnect
            </Button>
          </form>
        ) : null}
        {importHref ? (
          <Button asChild size="sm" variant="outline">
            <a href={importHref}>Open review workspace</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
