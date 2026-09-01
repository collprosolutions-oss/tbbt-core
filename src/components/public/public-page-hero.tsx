import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { PUBLIC_INNER_HERO_IMAGE } from "@/lib/public-site";

export function PublicPageHero({
  homeHref,
  current,
  title,
  accent,
  description,
  imageSrc = PUBLIC_INNER_HERO_IMAGE,
  children,
}: {
  homeHref: string;
  current: string;
  title: string;
  accent?: string;
  description?: string;
  imageSrc?: string;
  children?: ReactNode;
}) {
  return (
    <section className="public-page-hero">
      <div className="public-page-hero-media">
        <Image
          src={imageSrc}
          alt=""
          fill
          sizes="100vw"
          className="object-cover"
          priority
        />
      </div>
      <div className="public-container public-page-hero-inner">
        <p className="public-crumb">
          <Link href={homeHref}>Home</Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{current}</span>
        </p>
        <h1 className="public-page-title">{title}</h1>
        {accent ? <p className="public-page-accent">{accent}</p> : null}
        {description ? <p className="public-page-lead">{description}</p> : null}
        {children}
      </div>
    </section>
  );
}
