import { saveServiceAreaAction, toggleServiceAreaAction } from "@/app/actions/service-areas";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { listServiceAreas } from "@/lib/service-area-ops";
import { prisma } from "@/lib/prisma";

export async function ServiceAreaSettings({ businessId }: { businessId: string }) {
  const areas = await listServiceAreas(prisma, businessId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Configure served cities and ZIP / postal codes. This is not a GIS engine and does not
        infer addresses. Historical requests keep their original qualification.
      </p>
      <ActionForm action={saveServiceAreaAction} className="grid gap-2 md:grid-cols-2">
        <select name="kind" className="rounded-md border px-3 py-2 text-sm">
          <option value="CITY">City</option>
          <option value="POSTAL">ZIP / postal</option>
        </select>
        <input className="rounded-md border px-3 py-2 text-sm" name="label" placeholder="Label" />
        <input className="rounded-md border px-3 py-2 text-sm" name="city" placeholder="City" />
        <input className="rounded-md border px-3 py-2 text-sm" name="region" placeholder="Region" />
        <input className="rounded-md border px-3 py-2 text-sm" name="postalCode" placeholder="Postal code" />
        <input className="rounded-md border px-3 py-2 text-sm" name="travelAdjustment" placeholder="Optional travel adjustment" />
        <input className="rounded-md border px-3 py-2 text-sm" name="minimumAdjustment" placeholder="Optional minimum adjustment" />
        <textarea className="md:col-span-2 rounded-md border px-3 py-2 text-sm" name="notes" placeholder="Notes" />
        <Button type="submit" size="sm">Add service area</Button>
      </ActionForm>
      <ul className="space-y-2 text-sm">
        {areas.length === 0 ? (
          <li className="rounded-md border border-dashed p-3 text-muted-foreground">
            No service areas yet. Add a city or ZIP so public local pages and intake
            qualification can use it. This is not inferred from CollPro&apos;s map.
          </li>
        ) : null}
        {areas.map((area) => (
          <li key={area.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div>
              <p className="font-medium">{area.label}</p>
              <p className="text-muted-foreground">
                {area.kind} · {area.enabled ? "enabled" : "disabled"}
                {area.city ? ` · ${area.city}` : ""}
                {area.postalCode ? ` · ${area.postalCode}` : ""}
              </p>
            </div>
            <ActionForm action={toggleServiceAreaAction}>
              <input type="hidden" name="areaId" value={area.id} />
              <input type="hidden" name="enabled" value={area.enabled ? "0" : "1"} />
              <Button type="submit" size="sm" variant="outline">
                {area.enabled ? "Disable" : "Enable"}
              </Button>
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
