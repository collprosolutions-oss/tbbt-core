import {
  Clock,
  FileText,
  Handshake,
  HeartHandshake,
  Home,
  MapPin,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { PublicFittedImage } from "@/components/public/public-fitted-image";
import {
  ABOUT_REASON_CARDS,
  ABOUT_TRUST_POINTS,
  REVIEWS_PLACEHOLDER_COPY,
  SERVICE_AREA_COPY,
  SERVICE_AREA_MAP_IMAGE,
} from "@/lib/public-site";
import type { ResolvedPublicSiteImage } from "@/lib/public-site-images";
import { splitAboutParagraphs } from "@/lib/website-story";

const TRUST_ICONS = [Handshake, ShieldCheck, HeartHandshake] as const;
const REASON_ICONS = [Wrench, Clock, FileText, Home, MapPin] as const;

export function PublicAbout({
  storyImage,
  storyCopy,
}: {
  storyImage: ResolvedPublicSiteImage;
  storyCopy: string;
}) {
  const paragraphs = splitAboutParagraphs(storyCopy);

  return (
    <>
      <section className="bg-white">
        <div className="public-container public-about-story">
          <div className="public-about-media">
            <PublicFittedImage
              src={storyImage.src}
              alt="Handyman working at a residential doorway"
              objectPosition={storyImage.objectPosition}
              sizes="(max-width: 1099px) 100vw, 48vw"
            />
          </div>
          <div>
            <p className="text-xs font-extrabold tracking-[0.14em] text-[var(--public-blue)] uppercase">
              Our Story
            </p>
            <h2 className="mt-2 text-3xl font-extrabold uppercase tracking-tight">
              Built on experience
            </h2>
            {paragraphs.map((paragraph) => (
              <p key={paragraph} className="mt-4 text-base leading-7 text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[var(--public-paper)]">
        <div className="public-container public-about-trust">
          {ABOUT_TRUST_POINTS.map((point, index) => {
            const Icon = TRUST_ICONS[index] ?? Handshake;
            return (
              <article key={point.title} className="public-about-trust-card">
                <Icon className="size-8 text-[var(--public-blue)]" aria-hidden="true" />
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="bg-white public-section">
        <div className="public-container">
          <h2 className="public-section-title">
            <span>Why Homeowners Choose CollPro Reno</span>
          </h2>
          <div className="public-about-reasons">
            {ABOUT_REASON_CARDS.map((card, index) => {
              const Icon = REASON_ICONS[index] ?? Wrench;
              return (
                <article key={card.title} className="public-about-reason">
                  <Icon className="size-9 text-[var(--public-blue)]" aria-hidden="true" />
                  <h3>{card.title}</h3>
                  <p>{card.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="bg-[var(--public-paper)] public-section">
        <div className="public-container public-about-split">
          <div>
            <h2 className="text-3xl font-extrabold uppercase tracking-tight">
              What Our Customers Say
            </h2>
            <div className="public-review-card mt-6">
              <p className="text-xs font-extrabold tracking-[0.12em] uppercase">Reviews</p>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                {REVIEWS_PLACEHOLDER_COPY}
              </p>
            </div>
          </div>
          <div>
            <h2 className="text-3xl font-extrabold uppercase tracking-tight">
              Our Service Area
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{SERVICE_AREA_COPY}</p>
            <div className="public-about-map mt-5 overflow-hidden rounded-md">
              <PublicFittedImage
                src={SERVICE_AREA_MAP_IMAGE}
                alt="Map of the Fort Myers and Cape Coral area"
                objectPosition="50% 50%"
                sizes="(max-width: 1099px) 100vw, 48vw"
              />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Map shows the Fort Myers / Cape Coral area. It is not an exact
              service-boundary guarantee. Map data © OpenStreetMap contributors.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
