import type { ReactNode } from "react";
import Image from "next/image";
import {
  PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  publicImageFrameModel,
} from "@/lib/public-site-images";

export function PublicSiteImageFrame({
  objectPosition,
  objectZoom = PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  children,
}: {
  objectPosition: string;
  objectZoom?: number;
  children: ReactNode;
}) {
  const frame = publicImageFrameModel(objectPosition, objectZoom);
  return (
    <div data-public-site-image-frame="" style={frame.box}>
      {children}
    </div>
  );
}

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
  const frame = publicImageFrameModel(objectPosition, objectZoom);
  return (
    <PublicSiteImageFrame objectPosition={objectPosition} objectZoom={objectZoom}>
      <Image
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        unoptimized={remote}
        className={className}
        style={frame.image}
      />
    </PublicSiteImageFrame>
  );
}
