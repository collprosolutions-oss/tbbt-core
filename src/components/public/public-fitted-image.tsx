import Image from "next/image";

export function PublicFittedImage({
  src,
  alt,
  objectPosition,
  sizes,
  priority,
  className,
}: {
  src: string;
  alt: string;
  objectPosition: string;
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
      style={{ objectPosition }}
    />
  );
}
