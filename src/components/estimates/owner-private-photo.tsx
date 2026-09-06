import type { OwnerIntakePhoto } from "@/lib/intake-quote-handoff";

export function OwnerPrivatePhoto({ photo }: { photo: OwnerIntakePhoto }) {
  if (photo.previewable) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photo.src}
        alt=""
        className="aspect-square w-full rounded-md object-cover"
      />
    );
  }

  return (
    <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-center">
      <p className="line-clamp-3 text-xs font-medium text-foreground">{photo.fileName}</p>
      <p className="text-[11px] text-muted-foreground">
        This phone photo format cannot be previewed here.
      </p>
      <a
        href={photo.src}
        download={photo.fileName}
        className="text-xs font-medium underline underline-offset-4"
      >
        Download photo
      </a>
    </div>
  );
}
