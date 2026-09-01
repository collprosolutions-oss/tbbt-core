import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Clock, Home, MessageSquare, Shield } from "lucide-react";
import { CategoryCards } from "@/components/public/category-cards";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { telHref } from "@/lib/directions";
import {
  HOME_FEATURED_PROJECT_IDS,
  PRIMARY_CTA_LABEL,
  PUBLIC_HOME_HERO_IMAGE,
  PUBLIC_PRICING_DISCLAIMER,
  TRUST_POINTS,
  popularPublicCategories,
  publicDisplayName,
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
  items,
  groups,
}: {
  business: PublicBusiness;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
}) {
  const name = publicDisplayName(business);
  const phone = publicPhone(business.slug);
  const callHref = telHref(phone);
  const requestHref = publicRequestPath(business.slug);
  const servicesHref = publicServicesPath(business.slug);
  const projectsHref = publicProjectsPath(business.slug);
  const categories = popularPublicCategories(groups);
  const featured = PUBLIC_PROJECTS.filter((project) =>
    (HOME_FEATURED_PROJECT_IDS as readonly string[]).includes(project.id),
  );

  return (
    <main>
      <section className="public-home-hero">
        <div className="public-container public-home-hero-grid">
          <div className="public-home-hero-copy">
            <p className="public-kicker">Reliable. Professional. Done Right.</p>
            <h1 className="public-home-title">
              Your Home.
              <br />
              Our Handyman
              <em>Expertise.</em>
            </h1>
            <p className="public-home-lead">
              From small repairs to home improvements, we get the job done
              right the first time.
            </p>
            <div className="public-home-actions">
              <Link href={requestHref} className="public-btn public-btn-primary">
                {PRIMARY_CTA_LABEL}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link href={servicesHref} className="public-btn public-btn-ghost">
                Our Services
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className="public-home-hero-media">
            <Image
              src={PUBLIC_HOME_HERO_IMAGE}
              alt="Completed CollPro Reno feature wall and television mounting project"
              fill
              sizes="(max-width: 768px) 100vw, 50vw"
              className="object-cover"
              priority
            />
          </div>
        </div>
        <div className="public-trust-bar">
          <div className="public-container public-trust-grid">
            {TRUST_POINTS.map((point, index) => {
              const Icon = TRUST_ICONS[index] ?? Shield;
              return (
                <div key={point.title} className="public-trust-item">
                  <span className="public-trust-icon">
                    <Icon className="size-7" aria-hidden="true" />
                  </span>
                  <div>
                    <h2>{point.title}</h2>
                    <p>{point.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="services" className="public-home-services">
        <div className="public-container">
          <div className="public-panel px-5 py-10 sm:px-8 lg:px-10 lg:py-12">
            <h2 className="public-section-title">
              Handyman Services You Can Count On
            </h2>
            <div className="mt-10">
              <CategoryCards categories={categories} servicesHref={servicesHref} />
            </div>
            {items.length === 0 ? (
              <p className="mt-8 text-center text-muted-foreground">
                Tell us what you need — we will review the work before preparing
                an estimate.
              </p>
            ) : null}
            <p className="mx-auto mt-8 max-w-3xl text-center text-sm leading-6 text-muted-foreground">
              {PUBLIC_PRICING_DISCLAIMER}
            </p>
          </div>
        </div>
      </section>

      {featured.length > 0 ? (
        <section className="bg-white py-16 lg:py-20">
          <div className="public-container">
            <h2 className="public-section-title">Recent Project Work</h2>
            <ul className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {featured.map((project) => (
                <li key={project.id}>
                  <Link href={projectsHref} className="public-project-card">
                    <div className="public-project-card-media">
                      <Image
                        src={project.src}
                        alt={project.title}
                        fill
                        sizes="(max-width: 768px) 100vw, 25vw"
                      />
                    </div>
                    <div className="public-project-card-body">
                      <h3>{project.title}</h3>
                      <p>{project.description}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-8 flex justify-center">
              <Link href={projectsHref} className="public-btn public-btn-outline-blue">
                View Projects
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      <PublicCtaBar
        title="Ready to get started?"
        body={`Tell ${name} about your project and we will review the request before preparing a written estimate.`}
        requestHref={requestHref}
        callHref={callHref}
        phone={phone}
      />
    </main>
  );
}
