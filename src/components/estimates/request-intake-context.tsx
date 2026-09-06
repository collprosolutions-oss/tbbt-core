import { OwnerPrivatePhoto } from "@/components/estimates/owner-private-photo";
import type {
  OwnerIntakeMeasurementView,
  OwnerIntakePhoto,
} from "@/lib/intake-quote-handoff";

export function RequestIntakeContext({
  photos,
  measurements,
}: {
  photos: OwnerIntakePhoto[];
  measurements: OwnerIntakeMeasurementView[];
}) {
  if (photos.length === 0 && measurements.length === 0) return null;

  return (
    <div className="mt-3 space-y-3 text-sm">
      {measurements.length > 0 ? (
        <div>
          <p className="font-medium">Customer-reported measurements</p>
          <p className="text-xs text-muted-foreground">
            Unverified intake values. Use as reference until a site visit confirms
            them. These are not shown to the customer.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {measurements.map((row) => (
              <li key={row.label}>{row.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {photos.length > 0 ? (
        <div>
          <p className="font-medium">Request photos</p>
          <p className="text-xs text-muted-foreground">
            Private intake photos for this request. Not shown on the customer
            estimate.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {photos.map((photo) => (
              <OwnerPrivatePhoto key={photo.id} photo={photo} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
