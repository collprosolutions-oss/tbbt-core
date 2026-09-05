"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BusinessServiceArea } from "@/lib/business-service-area";
import {
  OTHER_CITY_VALUE,
  OUT_OF_AREA_WARNING,
  US_STATES,
  isUsServiceCountry,
  shouldWarnOutsideServiceArea,
  type StructuredServiceAddress,
} from "@/lib/service-address";

export function ServiceAddressFields({
  value,
  onChange,
  serviceArea,
}: {
  value: StructuredServiceAddress;
  onChange: (next: StructuredServiceAddress) => void;
  serviceArea: BusinessServiceArea;
}) {
  const [forceOtherCity, setForceOtherCity] = useState(false);
  const approvedCities = serviceArea.cities;
  const hasCityOptions = approvedCities.length > 0;
  const listedCity = hasCityOptions && approvedCities.some((city) => city === value.city);
  const showOtherCity =
    hasCityOptions && (forceOtherCity || Boolean(value.city && !listedCity));
  const citySelectValue = showOtherCity ? OTHER_CITY_VALUE : value.city;
  const showOutOfArea = shouldWarnOutsideServiceArea(value.city, approvedCities);
  const requireZip = isUsServiceCountry(serviceArea.country);
  const useUsStateSelect = isUsServiceCountry(serviceArea.country);

  function setField<K extends keyof StructuredServiceAddress>(
    key: K,
    next: StructuredServiceAddress[K],
  ) {
    onChange({ ...value, [key]: next });
  }

  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Service address</legend>
      <div className="space-y-2">
        <Label htmlFor="streetAddress">Street Address</Label>
        <Input
          id="streetAddress"
          name="streetAddress"
          autoComplete="address-line1"
          value={value.streetAddress}
          onChange={(event) => setField("streetAddress", event.target.value)}
          className="h-12 bg-white text-base"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="unit">Unit / Apt / Suite</Label>
        <Input
          id="unit"
          name="unit"
          autoComplete="address-line2"
          value={value.unit}
          onChange={(event) => setField("unit", event.target.value)}
          className="h-12 bg-white text-base"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_7.5rem_8.5rem]">
        <div className="space-y-2">
          <Label htmlFor={hasCityOptions ? "citySelect" : "city"}>City / Town</Label>
          {hasCityOptions ? (
            <select
              id="citySelect"
              name="citySelect"
              autoComplete="address-level2"
              value={citySelectValue}
              onChange={(event) => {
                const next = event.target.value;
                if (next === OTHER_CITY_VALUE) {
                  setForceOtherCity(true);
                  if (listedCity) setField("city", "");
                  return;
                }
                setForceOtherCity(false);
                setField("city", next);
              }}
              className="h-12 w-full rounded-lg border border-input bg-white px-2.5 text-base"
            >
              <option value="">Select a city</option>
              {approvedCities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
              <option value={OTHER_CITY_VALUE}>Other / not listed</option>
            </select>
          ) : (
            <Input
              id="city"
              name="city"
              autoComplete="address-level2"
              value={value.city}
              onChange={(event) => setField("city", event.target.value)}
              className="h-12 bg-white text-base"
            />
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="region">State</Label>
          {useUsStateSelect ? (
            <select
              id="region"
              name="region"
              autoComplete="address-level1"
              value={value.region}
              onChange={(event) => setField("region", event.target.value)}
              className="h-12 w-full rounded-lg border border-input bg-white px-2.5 text-base"
            >
              <option value="">State</option>
              {US_STATES.map((state) => (
                <option key={state.code} value={state.code}>
                  {state.code}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="region"
              name="region"
              autoComplete="address-level1"
              value={value.region}
              onChange={(event) => setField("region", event.target.value)}
              className="h-12 bg-white text-base"
            />
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="postalCode">{requireZip ? "ZIP Code" : "Postal code"}</Label>
          <Input
            id="postalCode"
            name="postalCode"
            autoComplete="postal-code"
            inputMode="numeric"
            value={value.postalCode}
            onChange={(event) => setField("postalCode", event.target.value)}
            className="h-12 bg-white text-base"
          />
        </div>
      </div>
      {showOtherCity ? (
        <div className="space-y-2">
          <Label htmlFor="city">City / Town</Label>
          <Input
            id="city"
            name="city"
            autoComplete="address-level2"
            value={value.city}
            onChange={(event) => setField("city", event.target.value)}
            className="h-12 bg-white text-base"
          />
        </div>
      ) : null}
      {showOutOfArea ? (
        <p className="rounded-md border border-[#d6e3f5] bg-[#eef4ff] px-3 py-2 text-sm text-[var(--public-ink)]">
          {OUT_OF_AREA_WARNING}
        </p>
      ) : null}
    </fieldset>
  );
}
