import Link from "next/link";
import Image from "next/image";
import {
  PRIMARY_CTA_LABEL,
  SERVICE_AREA_COPY,
  type PopularPublicCategory,
} from "@/lib/public-site";

export function PublicFooter({
  name,
  logoSrc,
  phone,
  homeHref,
  requestHref,
  servicesHref,
  aboutHref,
  callHref,
  categories,
}: {
  name: string;
  logoSrc: string | null;
  phone: string | null;
  homeHref: string;
  requestHref: string;
  servicesHref: string;
  aboutHref: string;
  callHref: string | null;
  categories: PopularPublicCategory[];
}) {
  return (
    <footer className="border-t border-white/10 bg-[var(--public-navy-deep)] text-white">
      <div className="public-container grid gap-10 py-14 md:grid-cols-2 xl:grid-cols-4">
        <div>
          {logoSrc ? (
            <Image
              src={logoSrc}
              alt={`${name} logo`}
              width={88}
              height={88}
              className="size-20 rounded-md bg-black object-contain"
            />
          ) : null}
          <p className="mt-4 text-lg font-semibold">{name}</p>
          <p className="mt-2 max-w-sm text-base leading-7 text-white/75">
            Local handyman service for homeowners. Request work online or call
            to get started.
          </p>
        </div>

        <div>
          <h2 className="text-sm font-bold tracking-[0.16em] text-[var(--public-blue-soft)] uppercase">
            Quick Links
          </h2>
          <ul className="mt-4 space-y-3 text-base">
            <li><Link className="hover:underline" href={homeHref}>Home</Link></li>
            <li><Link className="hover:underline" href={aboutHref}>About Us</Link></li>
            <li><Link className="hover:underline" href={servicesHref}>Services</Link></li>
            <li><Link className="hover:underline" href={`${homeHref}#projects`}>Projects</Link></li>
            <li><Link className="hover:underline" href={`${homeHref}#reviews`}>Reviews</Link></li>
            <li><Link className="hover:underline" href={requestHref}>{PRIMARY_CTA_LABEL}</Link></li>
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-bold tracking-[0.16em] text-[var(--public-blue-soft)] uppercase">
            Services
          </h2>
          <ul className="mt-4 space-y-3 text-base">
            {categories.length > 0 ? (
              categories.map((category) => (
                <li key={category.category}>
                  <Link
                    className="hover:underline"
                    href={`${servicesHref}?category=${encodeURIComponent(category.category)}`}
                  >
                    {category.category}
                  </Link>
                </li>
              ))
            ) : (
              <li>
                <Link className="hover:underline" href={servicesHref}>
                  View all services
                </Link>
              </li>
            )}
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-bold tracking-[0.16em] text-[var(--public-blue-soft)] uppercase">
            Service Area
          </h2>
          <p className="mt-4 text-base leading-7 text-white/80">{SERVICE_AREA_COPY}</p>
          <h2 className="mt-8 text-sm font-bold tracking-[0.16em] text-[var(--public-blue-soft)] uppercase">
            Contact
          </h2>
          <div className="mt-4 space-y-3 text-base">
            {callHref ? (
              <a className="block text-xl font-bold hover:underline" href={callHref}>
                {phone}
              </a>
            ) : null}
            <Link className="block font-semibold hover:underline" href={requestHref}>
              {PRIMARY_CTA_LABEL}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
