"use client";

import { useActionState } from "react";
import {
  optIntoBsosNetworkAction,
  optOutOfBsosNetworkAction,
  type NetworkActionState,
} from "@/app/actions/bsos-network";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NETWORK_DEFAULT_OFF_MESSAGE,
  NETWORK_NO_MATCHING_MESSAGE,
  NETWORK_OWNER_ONLY_MESSAGE,
  NETWORK_PRIVACY_MESSAGE,
  type PublicNetworkListing,
} from "@/lib/bsos-network";
import type { NetworkSuggestions, OwnNetworkParticipation } from "@/lib/bsos-network-data";
import { tradeLabel } from "@/lib/trades";

const initialState: NetworkActionState = {};

function ListingCard({ listing }: { listing: PublicNetworkListing }) {
  return (
    <div className="rounded-md border p-3">
      <p className="font-medium text-foreground">{listing.publicName}</p>
      <p className="text-sm text-muted-foreground">{tradeLabel(listing.trade)}</p>
      <p className="text-sm">{listing.serviceArea}</p>
      <p className="text-sm">
        {listing.contactMethod === "PHONE"
          ? "Phone"
          : listing.contactMethod === "EMAIL"
            ? "Email"
            : "Website"}
        : {listing.contactValue}
      </p>
    </div>
  );
}

function OptInForm({ suggestions }: { suggestions: NetworkSuggestions }) {
  const [state, action, pending] = useActionState(optIntoBsosNetworkAction, initialState);
  const defaultMethod = suggestions.contacts[0]?.method ?? "EMAIL";
  const defaultValue =
    suggestions.contacts.find((item) => item.method === defaultMethod)?.value ??
    suggestions.contacts[0]?.value ??
    "";

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="publicName">Public business name</Label>
        <Input
          id="publicName"
          name="publicName"
          required
          defaultValue={suggestions.publicName}
          maxLength={120}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tradeCode">Trade</Label>
        <select
          id="tradeCode"
          name="tradeCode"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue={suggestions.trades[0]?.code ?? "HANDYMAN"}
        >
          {suggestions.trades.map((trade) => (
            <option key={trade.code} value={trade.code}>
              {trade.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="serviceAreaLabel">Broad service area</Label>
        <Input
          id="serviceAreaLabel"
          name="serviceAreaLabel"
          required
          defaultValue={suggestions.serviceArea}
          maxLength={120}
          placeholder="Reno, NV"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="publicContactMethod">Public contact method</Label>
        <select
          id="publicContactMethod"
          name="publicContactMethod"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue={defaultMethod}
        >
          <option value="PHONE">Phone</option>
          <option value="EMAIL">Email</option>
          <option value="WEBSITE">Website</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="publicContactValue">Public contact value</Label>
        <Input id="publicContactValue" name="publicContactValue" required defaultValue={defaultValue} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Listing…" : "Opt in"}
      </Button>
    </form>
  );
}

function OptOutForm() {
  const [state, action, pending] = useActionState(optOutOfBsosNetworkAction, initialState);
  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Leaving…" : "Opt out"}
      </Button>
    </form>
  );
}

export function BsosNetworkWorkspace({
  own,
  suggestions,
  listings,
  canManage,
  tradeFilter,
  serviceAreaFilter,
}: {
  own: OwnNetworkParticipation;
  suggestions: NetworkSuggestions;
  listings: PublicNetworkListing[];
  canManage: boolean;
  tradeFilter: string;
  serviceAreaFilter: string;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Participation</CardTitle>
          <CardDescription>
            {own.optedIn
              ? "This business is listed. Other opted-in owners can see only the public details below."
              : NETWORK_DEFAULT_OFF_MESSAGE}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{NETWORK_PRIVACY_MESSAGE}</p>
          <p className="text-sm text-muted-foreground">{NETWORK_NO_MATCHING_MESSAGE}</p>
          {own.listing ? <ListingCard listing={own.listing} /> : null}
          {!canManage ? (
            <p className="text-sm text-muted-foreground">{NETWORK_OWNER_ONLY_MESSAGE}</p>
          ) : own.optedIn ? (
            <OptOutForm key="opt-out" />
          ) : (
            <OptInForm key="opt-in" suggestions={suggestions} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Discovery</CardTitle>
          <CardDescription>
            Only businesses that have opted in appear here. Absence never means a
            known business stayed off the network.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form method="get" className="flex flex-wrap gap-2">
            <select
              name="trade"
              defaultValue={tradeFilter}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Any trade</option>
              <option value="HANDYMAN">Handyman</option>
              <option value="CLEANING">Cleaning</option>
            </select>
            <Input
              name="serviceArea"
              defaultValue={serviceAreaFilter}
              placeholder="Broad service area"
              className="max-w-xs"
            />
            <Button type="submit" size="sm" variant="outline">
              Filter
            </Button>
          </form>
          {listings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No opted-in listings match this view.</p>
          ) : (
            <ul className="space-y-2">
              {listings.map((listing) => (
                <ListingCard key={listing.listingId} listing={listing} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
