import Image from "next/image";
import { MessageSquare } from "lucide-react";
import {
  ABOUT_COPY,
  PUBLIC_ABOUT_PHOTO,
  TEXT_US_LABEL,
  TRUST_POINTS,
} from "@/lib/public-site";

const STORY_PHOTOS = [
  PUBLIC_ABOUT_PHOTO,
  "/brand/projects/feature-wall-tv.jpg",
  "/brand/projects/closet.jpg",
  "/brand/projects/door-install.jpg",
] as const;

export function PublicAbout() {
  return (
    <>
      <section className="bg-white">
        <div className="public-container grid items-center gap-8 py-10 lg:grid-cols-2">
          <div className="relative min-h-80 overflow-hidden rounded-md">
            <Image
              src={STORY_PHOTOS[0]}
              alt="Finished porch and lanai work by CollPro Reno"
              fill
              sizes="50vw"
              className="object-cover"
            />
          </div>
          <div>
            <p className="text-xs font-extrabold tracking-[0.14em] text-[var(--public-blue)] uppercase">
              Our Story
            </p>
            <h2 className="mt-2 text-3xl font-extrabold uppercase tracking-tight">
              Local. Dedicated. Detail-Minded.
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">{ABOUT_COPY.lead}</p>
            <p className="mt-3 text-base leading-7 text-muted-foreground">{ABOUT_COPY.body}</p>
            <p className="mt-5 font-semibold text-[var(--public-blue)]">{ABOUT_COPY.signature}</p>
          </div>
        </div>
      </section>

      <section className="bg-[var(--public-paper)] public-section">
        <div className="public-container">
          <h2 className="public-section-title">How We Work</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {TRUST_POINTS.map((point, index) => (
              <article key={point.title} className="grid overflow-hidden bg-white md:grid-cols-[11rem_minmax(0,1fr)]">
                <div className="relative min-h-40">
                  <Image
                    src={STORY_PHOTOS[index] ?? STORY_PHOTOS[0]}
                    alt=""
                    fill
                    sizes="180px"
                    className="object-cover"
                  />
                </div>
                <div className="p-5">
                  <h3 className="text-lg font-extrabold uppercase">{point.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{point.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white public-section">
        <div className="public-container grid items-center gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div>
            <h2 className="text-3xl font-extrabold uppercase tracking-tight">
              {ABOUT_COPY.priorityTitle}
            </h2>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
              {ABOUT_COPY.priorityBody}
            </p>
            <ul className="mt-6 space-y-3">
              {ABOUT_COPY.points.map((point) => (
                <li key={point} className="flex gap-3">
                  <span className="mt-1 inline-block size-2.5 shrink-0 rounded-full bg-[var(--public-blue)]" />
                  <span className="font-semibold">{point}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="relative min-h-80 overflow-hidden rounded-md">
            <Image
              src="/brand/projects/wall-cabinets.jpg"
              alt="Cabinet and shelving work by CollPro Reno"
              fill
              sizes="40vw"
              className="object-cover"
            />
          </div>
        </div>
      </section>

      <section className="bg-[#e8f1ff]">
        <div className="public-container flex flex-wrap items-center justify-between gap-5 py-8">
          <div className="flex items-start gap-3">
            <MessageSquare className="mt-1 size-6 text-[var(--public-blue)]" />
            <div>
              <p className="text-xs font-extrabold tracking-[0.14em] uppercase">{TEXT_US_LABEL} preferred</p>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                Text project details, photos, and your address. We will review the
                request and follow up.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
