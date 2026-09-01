import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { PublicActionRail } from "@/components/public/public-action-rail";
import { PUBLIC_INNER_HERO_IMAGE } from "@/lib/public-site";

export function PublicPageHero({
  homeHref,
  current,
  title,
  accent,
  description,
  imageSrc = PUBLIC_INNER_HERO_IMAGE,
  phone,
  smsHref,
  requestHref,
  showQuote,
  children,
}: {
  homeHref: string;
  current: string;
  title: ReactNode;
  accent?: string;
  description?: string;
  imageSrc?: string;
  phone: string | null;
  smsHref: string | null;
  requestHref: string;
  showQuote?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="public-cinematic">
      <div className="public-cinematic-media">
        <Image src={imageSrc} alt="" fill sizes="100vw" className="object-cover" priority />
      </div>
      <div className="public-cinematic-shade" />
      <div className="public-container public-cinematic-inner">
        <PublicActionRail
          phone={phone}
          smsHref={smsHref}
          requestHref={requestHref}
          showQuote={showQuote}
        />
        <div className={children ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] lg:items-start" : ""}>
          <div className="public-cinematic-copy">
            <p className="public-crumb">
              <Link href={homeHref}>Home</Link>
              <span aria-hidden="true"> / </span>
              <span>{current}</span>
            </p>
            <h1 className="public-page-title">{title}</h1>
            {accent ? <p className="public-page-accent mt-2 text-xl font-extrabold uppercase">{accent}</p> : null}
            {description ? <p className="public-page-lead">{description}</p> : null}
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}
