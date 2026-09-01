import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
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
  projectsHref,
  reviewsHref,
  serviceAreaHref,
  contactHref,
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
  projectsHref: string;
  reviewsHref: string;
  serviceAreaHref: string;
  contactHref: string;
  callHref: string | null;
  categories: PopularPublicCategory[];
}) {
  const year = new Date().getFullYear();

  return (
    <footer className="public-footer">
      <div className="public-container public-footer-grid">
        <div>
          {logoSrc ? (
            <Image
              src={logoSrc}
              alt={`${name} logo`}
              width={88}
              height={88}
              className="size-20 rounded-full bg-black object-contain"
            />
          ) : null}
          <p className="mt-4 font-semibold text-white">{name}</p>
          <p className="mt-2 max-w-xs">
            Reliable handyman services for homeowners. Request work online or
            call to get started.
          </p>
        </div>

        <div>
          <h2>Quick Links</h2>
          <ul className="space-y-1">
            <li><Link href={homeHref}>Home</Link></li>
            <li><Link href={servicesHref}>Services</Link></li>
            <li><Link href={aboutHref}>About Us</Link></li>
            <li><Link href={projectsHref}>Projects</Link></li>
            <li><Link href={reviewsHref}>Reviews</Link></li>
            <li><Link href={serviceAreaHref}>Service Area</Link></li>
            <li><Link href={contactHref}>Contact</Link></li>
          </ul>
        </div>

        <div>
          <h2>Services</h2>
          <ul className="space-y-1">
            {categories.length > 0 ? (
              categories.map((category) => (
                <li key={category.category}>
                  <Link href={`${servicesHref}?category=${encodeURIComponent(category.category)}`}>
                    {category.category}
                  </Link>
                </li>
              ))
            ) : (
              <li>
                <Link href={servicesHref}>View all services</Link>
              </li>
            )}
          </ul>
        </div>

        <div>
          <h2>Service Area</h2>
          <p>{SERVICE_AREA_COPY}</p>
        </div>

        <div>
          <h2>Contact</h2>
          {callHref ? (
            <p>
              <a href={callHref} className="text-lg font-bold text-white">
                {phone}
              </a>
              <span className="mt-1 block text-sm tracking-[0.12em] uppercase">
                Call or Text
              </span>
            </p>
          ) : null}
          <Link href={requestHref} className="public-btn public-btn-primary mt-5">
            {PRIMARY_CTA_LABEL}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
      <div className="public-container public-footer-bottom">
        <p>© {year} {name}</p>
      </div>
    </footer>
  );
}
