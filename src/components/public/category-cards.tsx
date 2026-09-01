import Link from "next/link";
import {
  Bath,
  ChevronRight,
  Fan,
  Hammer,
  Home,
  KeyRound,
  ListChecks,
  Monitor,
  Sofa,
  Square,
  UtensilsCrossed,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { PopularPublicCategory } from "@/lib/public-site";

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  "Doors & Locks": KeyRound,
  "Mounting & Hanging": Monitor,
  "Walls & Drywall": Square,
  "Trim & Carpentry": Hammer,
  "Bathroom / Caulking / Accessories": Bath,
  "Furniture & Assembly": Sofa,
  "Exterior Repairs": Home,
  "Cabinets / Kitchen": UtensilsCrossed,
  "Fans & Fixtures": Fan,
  "Punch Lists / Small Jobs": ListChecks,
  "General Home Repairs": Wrench,
};

export function categoryIcon(category: string) {
  return CATEGORY_ICONS[category] ?? Wrench;
}

export function CategoryCards({
  categories,
  servicesHref,
  variant = "home",
}: {
  categories: PopularPublicCategory[];
  servicesHref: string;
  variant?: "home" | "services";
}) {
  if (categories.length === 0) {
    return (
      <p className="text-lg text-muted-foreground">
        Services will appear here when the catalog is available.
      </p>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {categories.map((category) => {
        const Icon = categoryIcon(category.category);
        const href = `${servicesHref}?category=${encodeURIComponent(category.category)}#select-work`;
        return (
          <li key={category.category}>
            {variant === "home" ? (
              <Link href={href} className="public-home-card">
                <span className="public-icon-circle">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span>
                  <h3>{category.category}</h3>
                  <p>{category.descriptor}</p>
                </span>
              </Link>
            ) : (
              <Link href={href} className="public-service-card">
                <span className="public-icon-circle">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <h3>{category.category}</h3>
                  <p>{category.descriptor}</p>
                  <span className="public-service-card-link">View Services</span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-[var(--public-blue)]" aria-hidden="true" />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
