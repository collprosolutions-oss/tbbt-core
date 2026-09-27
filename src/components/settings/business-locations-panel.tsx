import {
  archiveBusinessLocationAction,
  createBusinessLocationAction,
  restoreBusinessLocationAction,
  updateBusinessLocationAction,
} from "@/app/actions/business-locations";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { loadBusinessLocationDirectory } from "@/lib/business-location-ops";
import {
  formatLocationAddress,
  LOCATION_ADDITIVE_MESSAGE,
  LOCATION_EMPTY_MESSAGE,
  LOCATION_OWNER_ONLY_MESSAGE,
  LOCATION_UNAVAILABLE_MESSAGE,
} from "@/lib/business-locations";
import { prisma } from "@/lib/prisma";

export async function BusinessLocationsPanel({ canManage }: { canManage: boolean }) {
  const access = await requireManagementPageAccess();
  const directory = await loadBusinessLocationDirectory(prisma, access);
  const locations = directory.locations;

  if (!directory.available) {
    return (
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Business locations</h3>
        <p className="text-sm text-muted-foreground">{LOCATION_UNAVAILABLE_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Business locations</h3>
      <p className="text-sm text-muted-foreground">{LOCATION_ADDITIVE_MESSAGE}</p>
      {!canManage ? (
        <p className="text-sm text-muted-foreground">{LOCATION_OWNER_ONLY_MESSAGE}</p>
      ) : null}

      {canManage ? (
        <ActionForm action={createBusinessLocationAction} className="grid gap-2 md:grid-cols-2">
          <input className="rounded-md border px-3 py-2 text-sm" name="name" placeholder="Location name" />
          <input
            className="rounded-md border px-3 py-2 text-sm"
            name="addressLine1"
            placeholder="Address line 1"
          />
          <input
            className="rounded-md border px-3 py-2 text-sm"
            name="addressLine2"
            placeholder="Address line 2"
          />
          <input className="rounded-md border px-3 py-2 text-sm" name="city" placeholder="City" />
          <input className="rounded-md border px-3 py-2 text-sm" name="region" placeholder="Region" />
          <input
            className="rounded-md border px-3 py-2 text-sm"
            name="postalCode"
            placeholder="Postal code"
          />
          <textarea
            className="md:col-span-2 rounded-md border px-3 py-2 text-sm"
            name="notes"
            placeholder="Notes"
          />
          <Button type="submit" size="sm">
            Add location
          </Button>
        </ActionForm>
      ) : null}

      <ul className="space-y-2 text-sm">
        {locations.length === 0 ? (
          <li className="rounded-md border border-dashed p-3 text-muted-foreground">
            {LOCATION_EMPTY_MESSAGE}
          </li>
        ) : null}
        {locations.map((location) => {
          const address = formatLocationAddress(location);
          return (
            <li key={location.id} className="space-y-3 rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{location.name}</p>
                  <p className="text-muted-foreground">
                    {location.status === "ACTIVE" ? "Active" : "Archived"}
                    {address ? ` · ${address}` : ""}
                  </p>
                  {location.notes ? (
                    <p className="mt-1 text-muted-foreground">{location.notes}</p>
                  ) : null}
                </div>
                {canManage ? (
                  location.status === "ACTIVE" ? (
                    <ActionForm action={archiveBusinessLocationAction}>
                      <input type="hidden" name="locationId" value={location.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Archive
                      </Button>
                    </ActionForm>
                  ) : (
                    <ActionForm action={restoreBusinessLocationAction}>
                      <input type="hidden" name="locationId" value={location.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Restore
                      </Button>
                    </ActionForm>
                  )
                ) : null}
              </div>
              {canManage ? (
                <ActionForm
                  action={updateBusinessLocationAction}
                  className="grid gap-2 md:grid-cols-2"
                >
                  <input type="hidden" name="locationId" value={location.id} />
                  <input
                    className="rounded-md border px-3 py-2 text-sm"
                    name="name"
                    defaultValue={location.name}
                  />
                  <input
                    className="rounded-md border px-3 py-2 text-sm"
                    name="addressLine1"
                    defaultValue={location.addressLine1}
                    placeholder="Address line 1"
                  />
                  <input
                    className="rounded-md border px-3 py-2 text-sm"
                    name="addressLine2"
                    defaultValue={location.addressLine2}
                    placeholder="Address line 2"
                  />
                  <input
                    className="rounded-md border px-3 py-2 text-sm"
                    name="city"
                    defaultValue={location.city}
                    placeholder="City"
                  />
                  <input
                    className="rounded-md border px-3 py-2 text-sm"
                    name="region"
                    defaultValue={location.region}
                    placeholder="Region"
                  />
                  <input
                    className="rounded-md border px-3 py-2 text-sm"
                    name="postalCode"
                    defaultValue={location.postalCode}
                    placeholder="Postal code"
                  />
                  <textarea
                    className="md:col-span-2 rounded-md border px-3 py-2 text-sm"
                    name="notes"
                    defaultValue={location.notes}
                    placeholder="Notes"
                  />
                  <Button type="submit" size="sm" variant="outline">
                    Save location
                  </Button>
                </ActionForm>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
