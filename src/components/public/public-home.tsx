import Link from "next/link";
import { HomeCatalogContinue } from "@/components/public/home-catalog-continue";
import { Button } from "@/components/ui/button";
import { telHref } from "@/lib/directions";
import {
  HOW_IT_WORKS_STEPS,
  PUBLIC_PRICING_DISCLAIMER,
  SERVICE_AREA_COPY,
  TRUST_POINTS,
  publicDisplayName,
  publicPhone,
  type PublicBusiness,
  type PublicCatalogGroup,
  type PublicCatalogItem,
} from "@/lib/public-site";

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
  const requestHref = `/r/${business.slug}`;

  return (
    <main>
      <section className="bg-[var(--public-navy)] text-white">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-center lg:py-16">
          <div>
            <p className="text-sm font-semibold tracking-wide text-white/70 uppercase">
              {name}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Reliable Handyman Services for Your Home
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-white/85">
              Request repairs, installations, mounting, carpentry, exterior
              repairs, and other handyman work. Choose one task or several for
              the same visit.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Button asChild className="h-12 px-5 text-base">
                <Link href={requestHref}>Request Service</Link>
              </Button>
              {callHref ? (
                <Button
                  asChild
                  variant="secondary"
                  className="h-12 bg-white px-5 text-base text-[var(--public-navy)] hover:bg-white/90"
                >
                  <a href={callHref}>Call {phone}</a>
                </Button>
              ) : null}
            </div>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/5 p-5">
            <h2 className="text-lg font-semibold">How a request works</h2>
            <ol className="mt-4 space-y-3 text-sm text-white/85">
              {HOW_IT_WORKS_STEPS.slice(0, 3).map((step) => (
                <li key={step.step}>
                  <span className="font-semibold text-white">
                    {step.step}. {step.title}
                  </span>
                  <p className="mt-1">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section id="services" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">Services</h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            These are the active services currently offered. Browse by
            category, search, and select the work you need.
          </p>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {PUBLIC_PRICING_DISCLAIMER}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Materials are not included unless a service description says so.
          </p>
          <div className="mt-8">
            <HomeCatalogContinue
              slug={business.slug}
              items={items}
              groups={groups}
            />
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">How It Works</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-5">
            {HOW_IT_WORKS_STEPS.map((step) => (
              <li key={step.step} className="rounded-xl border border-border bg-background p-4">
                <p className="text-sm font-semibold text-primary">Step {step.step}</p>
                <h3 className="mt-2 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="service-area" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">Service Area</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">{SERVICE_AREA_COPY}</p>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">Why homeowners request online</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TRUST_POINTS.map((point) => (
              <li key={point.title} className="rounded-xl border border-border bg-background p-4">
                <h3 className="font-semibold">{point.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{point.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section>
        <div className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">After approval</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            After you approve an estimate and the work is scheduled, you can
            access your project information online through a private project
            link when one is provided. That link is not listed on this website.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button asChild className="h-12 px-5 text-base">
              <Link href={requestHref}>Request Service</Link>
            </Button>
            {callHref ? (
              <Button asChild variant="outline" className="h-12 px-5 text-base">
                <a href={callHref}>Call {phone}</a>
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
