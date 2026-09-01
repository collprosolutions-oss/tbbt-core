"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { PRIMARY_CTA_LABEL } from "@/lib/public-site";

export function PublicFooterQuote({ requestHref }: { requestHref: string }) {
  const pathname = usePathname();
  if (pathname.startsWith("/r/")) return null;

  return (
    <Link href={requestHref} className="public-btn public-btn-primary mt-5">
      {PRIMARY_CTA_LABEL}
      <ArrowRight className="size-4" aria-hidden="true" />
    </Link>
  );
}
