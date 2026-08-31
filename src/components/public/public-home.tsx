import Link from "next/link";
import {
  ClipboardList,
  Home,
  MessageSquare,
  Smartphone,
} from "lucide-react";
import { CategoryCards } from "@/components/public/category-cards";
import { PublicAbout } from "@/components/public/public-about";
import { PublicHeroVisual } from "@/components/public/public-hero-visual";
import { telHref } from "@/lib/directions";
import {
  ABOUT_COPY,
  HOW_IT_WORKS_STEPS,
  PRIMARY_CTA_LABEL,
  PROJECTS_PLACEHOLDER_COPY,
  PUBLIC_PRICING_DISCLAIMER,
  REVIEWS_PLACEHOLDER_COPY,
  SERVICE_AREA_COPY,
  TRUST_POINTS,
  popularPublicCategories,
  publicAboutPath,
  publicDisplayName,
  publicPhone,
  publicRequestPath,
  publicServicesPath,
  type PublicBusiness,
  type PublicCatalogGroup,
  type PublicCatalogItem,
} from "@/lib/public-site";

const TRUST_ICONS = [ClipboardList, Home, Smartphone, MessageSquare] as const;

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
  const aboutHref = publicAboutPath(business.slug);
  const categories = popularPublicCategories(groups);

  return (
    <main>
      <section className="bg-[var(--public-navy)] text-white">
        <div className="public-container grid items-center gap-12 py-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:py-24">
          <div>
            <p className="text-sm font-bold tracking-[0.22em] text-[var(--public-blue-soft)] uppercase">
              {name}
            </p>
            <h1 className="mt-5 text-5xl leading-[0.95] font-extrabold tracking-tight text-balance sm:text-6xl lg:text-7xl">
              Your home.
              <span className="mt-2 block text-[var(--public-blue-soft)]">
                Our handyman expertise.
              </span>
            </h1>
            <p className="mt-6 max-w-2xl text-xl leading-8 text-white/85">
              From small repairs to home improvements, CollPro Reno helps
              homeowners get projects handled professionally and clearly.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link href={requestHref} className="public-btn public-btn-primary">
                {PRIMARY_CTA_LABEL}
              </Link>
              <a href="#services" className="public-btn public-btn-ghost">
                View Our Services
              </a>
              {callHref ? (
                <a href={callHref} className="public-btn public-btn-secondary">
                  {phone}
                </a>
              ) : null}
            </div>
          </div>
          <PublicHeroVisual />
        </div>
      </section>

      <section className="bg-[var(--public-navy-mid)] text-white">
        <div className="public-container grid gap-6 py-10 sm:grid-cols-2 xl:grid-cols-4">
          {TRUST_POINTS.map((point, index) => {
            const Icon = TRUST_ICONS[index] ?? ClipboardList;
            return (
              <div key={point.title} className="rounded-2xl bg-white/5 px-5 py-6">
                <Icon className="size-8 text-[var(--public-blue-soft)]" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-semibold">{point.title}</h2>
                <p className="mt-2 text-base leading-7 text-white/75">{point.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section id="services" className="scroll-mt-28">
        <div className="public-container py-16 lg:py-24">
          <div className="flex max-w-3xl flex-col gap-4">
            <p className="text-sm font-bold tracking-[0.18em] text-[var(--public-blue)] uppercase">
              Popular Handyman Services
            </p>
            <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              Work we help homeowners with
            </h2>
            <p className="text-lg leading-8 text-muted-foreground">
              These categories come from the live service catalog
              {items.length > 0
                ? ` — ${items.length} active services across ${groups.length} categories`
                : ""}. Browse a category, or open the full list when you are
              ready to request work.
            </p>
          </div>
          <div className="mt-10">
            <CategoryCards categories={categories} servicesHref={servicesHref} />
          </div>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href={servicesHref} className="public-btn public-btn-primary">
              View All Services
            </Link>
            <Link href={requestHref} className="public-btn public-btn-outline">
              {PRIMARY_CTA_LABEL}
            </Link>
          </div>
          <p className="mt-6 max-w-3xl text-base text-muted-foreground">
            {PUBLIC_PRICING_DISCLAIMER} Materials are not included unless a
            service description says so.
          </p>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-28 bg-white">
        <div className="public-container py-16 lg:py-24">
          <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            How It Works
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            A request is reviewed before an estimate is written. Estimates are
            not instant.
          </p>
          <ol className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-5">
            {HOW_IT_WORKS_STEPS.map((step) => (
              <li
                key={step.step}
                className="rounded-2xl border border-border bg-[var(--background)] p-6"
              >
                <p className="text-4xl font-extrabold text-[var(--public-blue)]">
                  {String(step.step).padStart(2, "0")}
                </p>
                <h3 className="mt-4 text-xl font-semibold">{step.title}</h3>
                <p className="mt-3 text-base leading-7 text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="about" className="scroll-mt-28">
        <div className="public-container py-16 lg:py-24">
          <PublicAbout />
          <div className="mt-10">
            <Link href={aboutHref} className="public-btn public-btn-outline">
              {ABOUT_COPY.eyebrow}
            </Link>
          </div>
        </div>
      </section>

      <section id="projects" className="scroll-mt-28 bg-white">
        <div className="public-container py-16 lg:py-24">
          <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            Projects
          </h2>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
            {PROJECTS_PLACEHOLDER_COPY}
          </p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {["Recent work", "Interior projects", "Exterior projects"].map((label) => (
              <div
                key={label}
                className="flex min-h-64 flex-col justify-end rounded-2xl bg-[var(--public-navy)] p-6 text-white"
              >
                <p className="text-sm font-bold tracking-[0.16em] text-[var(--public-blue-soft)] uppercase">
                  Gallery coming soon
                </p>
                <h3 className="mt-3 text-2xl font-semibold">{label}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="service-area" className="scroll-mt-28">
        <div className="public-container py-16 lg:py-24">
          <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            Service Area
          </h2>
          <p className="mt-5 max-w-3xl text-xl leading-8 text-muted-foreground">
            {SERVICE_AREA_COPY}
          </p>
        </div>
      </section>

      <section id="reviews" className="scroll-mt-28 bg-white">
        <div className="public-container py-16 lg:py-24">
          <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            Reviews
          </h2>
          <p className="mt-4 text-2xl font-semibold tracking-tight">
            Already worked with CollPro Reno?
          </p>
          <p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">
            {REVIEWS_PLACEHOLDER_COPY}
          </p>
          <p className="mt-8 inline-flex rounded-2xl border border-border bg-[var(--background)] px-5 py-4 text-lg font-semibold">
            Customer Reviews Coming Soon
          </p>
        </div>
      </section>

      <section id="contact" className="scroll-mt-28 bg-[var(--public-navy)] text-white">
        <div className="public-container py-16 text-center lg:py-24">
          <h2 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
            Ready to get started?
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-xl leading-8 text-white/80">
            Tell us what you need. We will review your request before creating
            an estimate.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href={requestHref} className="public-btn public-btn-primary">
              {PRIMARY_CTA_LABEL}
            </Link>
            {callHref ? (
              <a href={callHref} className="public-btn public-btn-ghost">
                Call or Text {phone}
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
