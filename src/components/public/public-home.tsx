import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Clock, Home, MessageSquare, Shield } from "lucide-react";
import { PublicActionRail } from "@/components/public/public-action-rail";
import { smsHref } from "@/lib/directions";
import {
  HOME_FEATURED_PROJECT_IDS,
  PUBLIC_HOME_HERO_IMAGE,
  TRUST_POINTS,
  popularPublicCategories,
  publicCategoryPhoto,
  publicPhone,
  publicProjectsPath,
  publicRequestPath,
  publicServicesPath,
  type PublicBusiness,
  type PublicCatalogGroup,
  type PublicCatalogItem,
} from "@/lib/public-site";
import { PUBLIC_PROJECTS } from "@/lib/public-projects";

const TRUST_ICONS = [Shield, Clock, MessageSquare, Home] as const;

export function PublicHome({
  business,
  groups,
}: {
  business: PublicBusiness;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
}) {
  const phone = publicPhone(business.slug);
  const textHref = smsHref(phone);
  const requestHref = publicRequestPath(business.slug);
  const servicesHref = publicServicesPath(business.slug);
  const projectsHref = publicProjectsPath(business.slug);
  const categories = popularPublicCategories(groups);
  const featured = PUBLIC_PROJECTS.filter((project) =>
    (HOME_FEATURED_PROJECT_IDS as readonly string[]).includes(project.id),
  );

  return (
    <main>
      <section className="public-cinematic">
        <div className="public-cinematic-media">
          <Image
            src={PUBLIC_HOME_HERO_IMAGE}
            alt="Handyman working with tools in a workshop"
            fill
            sizes="100vw"
            className="object-cover object-[70%_center]"
            priority
          />
        </div>
        <div className="public-cinematic-shade" />
        <div className="public-container public-cinematic-inner">
          <PublicActionRail phone={phone} smsHref={textHref} requestHref={requestHref} />
          <div className="public-cinematic-copy">
            <p className="public-kicker">Reliable. Professional. Done Right.</p>
            <h1>
              Your Home.
              <br />
              Our
              <br />
              Handyman
              <br />
              <em>Expertise.</em>
            </h1>
            <p>
              From small repairs to home improvements, we get the job done
              right the first time.
            </p>
          </div>
        </div>
      </section>

      <section className="public-trust-bar">
        <div className="public-container public-trust-grid">
          {TRUST_POINTS.map((point, index) => {
            const Icon = TRUST_ICONS[index] ?? Shield;
            return (
              <div key={point.title} className="public-trust-item">
                <Icon className="size-7 text-[var(--public-blue)]" aria-hidden="true" />
                <div>
                  <h2>{point.title}</h2>
                  <p>{point.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="public-section">
        <div className="public-container">
          <h2 className="public-section-title">
            Handyman <span>Services</span> You Can Count On
          </h2>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {categories.map((category) => (
              <li key={category.category}>
                <Link
                  href={`${servicesHref}?category=${encodeURIComponent(category.category)}`}
                  className="public-photo-card"
                >
                  <Image
                    src={publicCategoryPhoto(category.category)}
                    alt=""
                    fill
                    sizes="(max-width: 768px) 100vw, 25vw"
                  />
                  <span className="public-photo-card-bar">
                    <h3>{category.category}</h3>
                    <ArrowRight className="size-8 rounded-full bg-[var(--public-blue)] p-1.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-10 flex justify-center">
            <Link href={servicesHref} className="public-btn public-btn-outline-blue">
              View All Services
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      {featured.length > 0 ? (
        <section className="public-projects-band public-section">
          <div className="public-container">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-3xl font-extrabold tracking-wide uppercase">
                Recent Projects / Real CollPro Work
              </h2>
              <Link href={projectsHref} className="font-extrabold tracking-wide text-[var(--public-blue-soft)] uppercase">
                View More Projects →
              </Link>
            </div>
            <ul className="mt-6 grid gap-4 md:grid-cols-2">
              {featured.map((project) => (
                <li key={project.id}>
                  <Link href={projectsHref} className="public-project-tile public-project-tile--lg">
                    <Image src={project.src} alt={project.title} fill sizes="(max-width: 768px) 100vw, 25vw" />
                    <span className="public-project-tile-bar">
                      <h3>{project.title}</h3>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </main>
  );
}
