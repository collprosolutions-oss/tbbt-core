import Link from "next/link";
import {
  Bath,
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

const CATEGORY_ICONS: Record<string, LucideIcon> = {
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

export function CategoryCards({
  categories,
  servicesHref,
}: {
  categories: PopularPublicCategory[];
  servicesHref: string;
}) {
  if (categories.length === 0) {
    return (
      <p className="text-lg text-muted-foreground">
        Services will appear here when the catalog is available.
      </p>
    );
  }

  return (
    <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      {categories.map((category) => {
        const Icon = CATEGORY_ICONS[category.category] ?? Wrench;
        const href = `${servicesHref}?category=${encodeURIComponent(category.category)}`;
        return (
          <li key={category.category}>
            <Link
              href={href}
              className="group flex h-full min-h-52 flex-col rounded-2xl border border-border bg-white p-6 shadow-[0_10px_30px_rgba(10,20,36,0.06)] transition-transform hover:-translate-y-0.5"
            >
              <span className="inline-flex size-14 items-center justify-center rounded-xl bg-[var(--public-navy)] text-white">
                <Icon className="size-7" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-xl font-semibold tracking-tight">
                {category.category}
              </h3>
              <p className="mt-2 flex-1 text-base leading-6 text-muted-foreground">
                {category.descriptor}
              </p>
              <p className="mt-3 text-sm font-medium text-[var(--public-ink)]/70">
                {category.itemCount} service{category.itemCount === 1 ? "" : "s"}
              </p>
              <span className="mt-5 text-sm font-bold tracking-wide text-[var(--public-blue)] uppercase">
                View Services
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
