import Link from "next/link";
import { ArrowRight, Clock, Home, MessageSquare, Shield } from "lucide-react";
import { PublicActionRail } from "@/components/public/public-action-rail";
import { PublicFittedImage } from "@/components/public/public-fitted-image";
import { smsHref } from "@/lib/directions";
import { selectPublicProjectsById } from "@/lib/public-projects";
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
import {
  PUBLIC_HOME_CATEGORY_DEFAULT_POSITION,
  PUBLIC_HOME_HERO_DEFAULT_POSITION,
  type PublicHomeImagePresentation,
} from "@/lib/public-site-images";

const TRUST_ICONS = [Shield, Clock, MessageSquare, Home] as const;

export function PublicHome({
  business,
  groups,
  images,
}: {
  business: PublicBusiness;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  images?: PublicHomeImagePresentation;
}) {
  const phone = publicPhone(business.slug);
  const textHref = smsHref(phone);
  const requestHref = publicRequestPath(business.slug);
  const servicesHref = publicServicesPath(business.slug);
  const projectsHref = publicProjectsPath(business.slug);
  const categories = popularPublicCategories(groups);
  const featured = selectPublicProjectsById(HOME_FEATURED_PROJECT_IDS);
  const hero = images?.hero ?? {
    src: PUBLIC_HOME_HERO_IMAGE,
    objectPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
  };

  return (
    <main>
      <section className="public-cinematic">
        <div className="public-cinematic-media">
          <PublicFittedImage
            src={hero.src}
            alt="Handyman working with tools in a workshop"
            objectPosition={hero.objectPosition}
            sizes="100vw"
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
            {categories.map((category) => {
              const visual = images?.categories[category.category] ?? {
                src: publicCategoryPhoto(category.category),
                objectPosition: PUBLIC_HOME_CATEGORY_DEFAULT_POSITION,
              };
              return (
                <li key={category.category}>
                  <Link
                    href={`${servicesHref}?category=${encodeURIComponent(category.category)}`}
                    className="public-photo-card"
                  >
                    <PublicFittedImage
                      src={visual.src}
                      alt=""
                      objectPosition={visual.objectPosition}
                      sizes="(max-width: 768px) 100vw, 25vw"
                    />
                    <span className="public-photo-card-bar">
                      <h3>{category.category}</h3>
                      <ArrowRight className="size-8 rounded-full bg-[var(--public-blue)] p-1.5" />
                    </span>
                  </Link>
                </li>
              );
            })}
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
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((project) => (
                <li key={project.id}>
                  <Link href={projectsHref} className="public-project-tile public-project-tile--lg">
                    <PublicFittedImage
                      src={project.src}
                      alt={project.title}
                      objectPosition="50% 38%"
                      sizes="(max-width: 768px) 100vw, (max-width: 1100px) 50vw, 33vw"
                    />
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
