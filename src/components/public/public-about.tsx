import Image from "next/image";
import { Clock, Home, MessageSquare, Shield } from "lucide-react";
import { ABOUT_COPY, PUBLIC_ABOUT_PHOTO, TRUST_POINTS } from "@/lib/public-site";

const ICONS = [Shield, Clock, MessageSquare, Home] as const;

export function PublicAbout() {
  return (
    <>
      <section className="bg-white public-section">
        <div className="public-container">
          <h2 className="public-section-title">Our Commitment To You</h2>
          <ul className="mt-12 grid gap-8 sm:grid-cols-2 xl:grid-cols-4">
            {TRUST_POINTS.map((point, index) => {
              const Icon = ICONS[index] ?? Shield;
              return (
                <li key={point.title} className="text-center">
                  <Icon className="mx-auto size-8 text-[var(--public-blue)]" />
                  <h3 className="mt-4 font-extrabold">{point.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{point.body}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
      <section className="bg-[var(--public-paper)]">
        <div className="public-container grid items-center gap-8 py-16 lg:grid-cols-2">
          <div className="relative min-h-[28rem] overflow-hidden rounded-md">
            <Image
              src={PUBLIC_ABOUT_PHOTO}
              alt="Finished porch and lanai work by CollPro Reno"
              fill
              sizes="50vw"
              className="object-cover"
            />
          </div>
          <div>
            <h2 className="text-4xl font-extrabold uppercase tracking-tight">
              Local. Dedicated. Detail-Minded.
            </h2>
            <p className="mt-5 text-lg leading-8 text-muted-foreground">{ABOUT_COPY.lead}</p>
            <p className="mt-4 text-lg leading-8 text-muted-foreground">{ABOUT_COPY.body}</p>
            <p className="mt-6 font-semibold text-[var(--public-blue)]">{ABOUT_COPY.signature}</p>
          </div>
        </div>
      </section>
    </>
  );
}
