import Image from "next/image";
import {
  PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  publicImageObjectStyle,
} from "@/lib/public-site-images";

export function PublicFittedImage({
  src,
  alt,
  objectPosition,
  objectZoom = PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  sizes,
  priority,
  className,
}: {
  src: string;
  alt: string;
  objectPosition: string;
  objectZoom?: number;
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  const remote = src.startsWith("https://");
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={remote}
      className={className ?? "object-cover"}
      style={publicImageObjectStyle(objectPosition, objectZoom)}
    />
  );
}
