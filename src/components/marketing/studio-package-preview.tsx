import { CREATOR_PACKAGE_LIMITS_MESSAGE } from "@/lib/marketing";
import type { ShotListItem, StoryboardBeat } from "@/lib/marketing";

export function StudioPackagePreview({
  title,
  caption,
  hashtags,
  storyboard,
  shotList,
  photos,
  businessName,
  workPerformed,
  city,
}: {
  title: string;
  caption: string;
  hashtags: string;
  storyboard: StoryboardBeat[];
  shotList: ShotListItem[];
  photos: Array<{ id: string; url: string; stage: string; caption?: string | null; approved?: boolean }>;
  businessName: string;
  workPerformed: string | null;
  city: string | null;
}) {
  const revoked = photos.some((photo) => photo.approved === false);

  return (
    <div className="space-y-3 rounded-lg border border-border/70 p-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Internal preview
        </p>
        <h3 className="text-base font-semibold">{title || "Untitled package"}</h3>
        <p className="text-xs text-muted-foreground">
          {businessName}
          {workPerformed ? ` · ${workPerformed}` : ""}
          {city ? ` · ${city}` : ""}
        </p>
      </div>
      <p className="whitespace-pre-wrap text-sm">{caption || "No caption drafted."}</p>
      {hashtags ? <p className="text-sm text-muted-foreground">{hashtags}</p> : null}
      {photos.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={photo.id} src={photo.url} alt="" className="h-20 w-20 rounded-md object-cover" />
          ))}
        </div>
      ) : null}
      {revoked ? (
        <p className="text-sm text-destructive">
          A selected photo no longer has marketing permission. Approval and export are blocked.
        </p>
      ) : null}
      {storyboard.length > 0 ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {storyboard.map((beat, index) => (
            <li key={`${beat.heading}-${index}`}>
              <span className="font-medium">{beat.heading}:</span> {beat.visual} — {beat.narration}
            </li>
          ))}
        </ol>
      ) : null}
      {shotList.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {shotList.map((shot, index) => (
            <li key={`${shot.order}-${index}`}>
              {shot.order}. {shot.shot} — {shot.purpose}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">{CREATOR_PACKAGE_LIMITS_MESSAGE}</p>
    </div>
  );
}
