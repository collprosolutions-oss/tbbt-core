"use client";

import { useActionState } from "react";
import {
  checkMarketingConnectionStatusAction,
  confirmMarketingConnectionSelectionAction,
  disconnectMarketingConnectionAction,
  reconnectMarketingConnectionAction,
  startMarketingConnectionAction,
  type MarketingConnectionActionState,
} from "@/app/actions/marketing-connections";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { MarketingConnectionCard } from "@/lib/marketing-connections/presenter";

const initial: MarketingConnectionActionState = {};

function ConnectionButtons({ card }: { card: MarketingConnectionCard }) {
  const [connectState, connectAction, connectPending] = useActionState(startMarketingConnectionAction, initial);
  const [reconnectState, reconnectAction, reconnectPending] = useActionState(
    reconnectMarketingConnectionAction,
    initial,
  );
  const [statusState, statusAction, statusPending] = useActionState(checkMarketingConnectionStatusAction, initial);
  const [disconnectState, disconnectAction, disconnectPending] = useActionState(
    disconnectMarketingConnectionAction,
    initial,
  );
  const error = connectState.error || reconnectState.error || statusState.error || disconnectState.error;
  const message = statusState.message || disconnectState.message;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {card.showConnect ? (
          <form action={connectAction}>
            <input type="hidden" name="destination" value={card.destination} />
            <Button type="submit" size="sm" disabled={connectPending}>
              Connect {card.label}
            </Button>
          </form>
        ) : null}
        {card.showReconnect ? (
          <form action={reconnectAction}>
            <input type="hidden" name="destination" value={card.destination} />
            <Button type="submit" size="sm" variant="outline" disabled={reconnectPending}>
              Reconnect {card.label}
            </Button>
          </form>
        ) : null}
        {card.showStatusCheck ? (
          <form action={statusAction}>
            <input type="hidden" name="destination" value={card.destination} />
            <Button type="submit" size="sm" variant="outline" disabled={statusPending}>
              Check status
            </Button>
          </form>
        ) : null}
        {card.showDisconnect ? (
          <form action={disconnectAction}>
            <input type="hidden" name="destination" value={card.destination} />
            <Button type="submit" size="sm" variant="outline" disabled={disconnectPending}>
              Disconnect
            </Button>
          </form>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

export function MarketingConnectionsPanel({
  cards,
  owner,
  selection,
  connectionError,
}: {
  cards: MarketingConnectionCard[];
  owner: boolean;
  selection: {
    token: string;
    label: string;
    candidates: Array<{ externalId: string; displayName: string }>;
  } | null;
  connectionError: string | null;
}) {
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmMarketingConnectionSelectionAction,
    initial,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Marketing connections</CardTitle>
        <CardDescription>
          Each destination is separate. Connecting does not publish. Facebook, Instagram, and Google Business Profile publish still require an approved package and an explicit OWNER publish click. Instagram uses only an approved public marketing image and never sends a private job or customer photo. Google local posts do not change rankings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!owner ? (
          <p className="text-sm text-muted-foreground">Only the OWNER can connect, reconnect, or disconnect a marketing destination.</p>
        ) : null}
        {connectionError ? <p className="text-sm text-destructive">{connectionError}</p> : null}
        {selection ? (
          <form action={confirmAction} className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Choose one {selection.label} destination</p>
            <p className="text-xs text-muted-foreground">Nothing is selected automatically, even when only one choice is returned.</p>
            <input type="hidden" name="selectionToken" value={selection.token} />
            <div className="space-y-1">
              {selection.candidates.map((candidate) => (
                <label key={candidate.externalId} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="externalId" value={candidate.externalId} />
                  <span>{candidate.displayName}</span>
                </label>
              ))}
            </div>
            <Button type="submit" size="sm" disabled={confirmPending}>
              Confirm destination
            </Button>
            {confirmState.error ? <p className="text-xs text-destructive">{confirmState.error}</p> : null}
            {confirmState.message ? <p className="text-xs text-muted-foreground">{confirmState.message}</p> : null}
          </form>
        ) : null}
        {cards.map((card) => (
          <div key={card.destination} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{card.label}</p>
              <p className="text-xs text-muted-foreground">{card.statusLabel}</p>
            </div>
            {card.displayName ? <p className="text-sm">{card.displayName}</p> : null}
            <p className="text-xs text-muted-foreground">{card.detail}</p>
            {owner ? <ConnectionButtons card={card} /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
