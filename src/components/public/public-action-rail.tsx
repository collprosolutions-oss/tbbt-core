"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, MessageSquare } from "lucide-react";
import { PRIMARY_CTA_LABEL, TEXT_US_LABEL } from "@/lib/public-site";

export function PublicActionRail({
  phone,
  smsHref,
  requestHref,
  showQuote,
}: {
  phone: string | null;
  smsHref: string | null;
  requestHref: string;
  showQuote?: boolean;
}) {
  const pathname = usePathname();
  const quoteVisible = showQuote ?? !pathname.startsWith("/r/");

  return (
    <div className="public-rail">
      {smsHref ? (
        <a href={smsHref} className="public-text-us">
          <strong>
            <MessageSquare className="mr-1 inline size-3.5" aria-hidden="true" />
            {TEXT_US_LABEL}
          </strong>
          <span>{phone}</span>
        </a>
      ) : null}
      {quoteVisible ? (
        <Link href={requestHref} className="public-btn public-btn-primary">
          {PRIMARY_CTA_LABEL}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
