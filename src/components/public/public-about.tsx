import Image from "next/image";
import {
  Clock,
  Home,
  MessageSquare,
  Shield,
} from "lucide-react";
import {
  ABOUT_COPY,
  PUBLIC_ABOUT_PHOTO,
  PUBLIC_HOME_HERO_IMAGE,
  TRUST_POINTS,
} from "@/lib/public-site";

const COMMITMENT_ICONS = [Shield, Clock, MessageSquare, Home] as const;

export function PublicAbout() {
  return (
    <>
      <section className="bg-white">
        <div className="public-container public-section">
          <h2 className="public-section-title">Our Commitment To You</h2>
          <ul className="mt-12 grid gap-8 sm:grid-cols-2 xl:grid-cols-4">
            {TRUST_POINTS.map((point, index) => {
              const Icon = COMMITMENT_ICONS[index] ?? Shield;
              return (
                <li key={point.title} className="text-center">
                  <span className="public-icon-circle mx-auto">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-bold">{point.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {point.body}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="bg-[var(--public-paper)]">
        <div className="public-container grid items-center gap-8 py-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_minmax(0,0.75fr)] lg:gap-10 lg:py-20">
          <div className="relative min-h-72 overflow-hidden rounded-lg">
            <Image
              src={PUBLIC_ABOUT_PHOTO}
              alt="Finished porch and lanai carpentry by CollPro Reno"
              fill
              sizes="(max-width: 1024px) 100vw, 36vw"
              className="object-cover"
            />
          </div>
          <div>
            <span className="mb-4 block h-1 w-12 bg-[var(--public-blue)]" />
            <h2 className="text-3xl font-extrabold tracking-tight uppercase sm:text-4xl">
              Local. Dedicated. Detail-Minded.
            </h2>
            <p className="mt-5 text-base leading-7 text-muted-foreground">
              {ABOUT_COPY.lead}
            </p>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              {ABOUT_COPY.body}
            </p>
            <p className="mt-6 font-semibold text-[var(--public-blue)]">
              {ABOUT_COPY.signature}
            </p>
          </div>
          <aside className="rounded-lg bg-[#e8f0ff] p-6">
            <span className="public-icon-circle">
              <Home className="size-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-xl font-extrabold text-[var(--public-navy)]">
              {ABOUT_COPY.priorityTitle}
            </h3>
            <p className="mt-3 text-sm leading-6 text-[var(--public-navy)]/75">
              {ABOUT_COPY.priorityBody}
            </p>
            <div className="relative mt-6 h-36 overflow-hidden rounded-md">
              <Image
                src={PUBLIC_HOME_HERO_IMAGE}
                alt="Barn-board feature wall completed for a homeowner"
                fill
                sizes="(max-width: 1024px) 100vw, 22vw"
                className="object-cover"
              />
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
