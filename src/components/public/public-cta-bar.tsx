import Link from "next/link";
import { ArrowRight, MessageSquare } from "lucide-react";
import { PRIMARY_CTA_LABEL, TEXT_US_LABEL } from "@/lib/public-site";

export function PublicCtaBar({
  title,
  body,
  requestHref,
  smsHref,
  phone,
  showQuote = true,
}: {
  title: string;
  body: string;
  requestHref: string;
  smsHref: string | null;
  phone: string | null;
  showQuote?: boolean;
}) {
  return (
    <section className="public-cta-bar">
      <div className="public-container public-cta-inner">
        <div>
          <h2 className="text-xl font-extrabold tracking-wide uppercase">{title}</h2>
          <p className="mt-2 max-w-xl text-white/75">{body}</p>
        </div>
        <div className="public-cta-actions flex flex-wrap gap-3">
          {showQuote ? (
            <Link href={requestHref} className="public-btn public-btn-primary">
              {PRIMARY_CTA_LABEL}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
          {smsHref ? (
            <a href={smsHref} className="public-text-us min-w-52">
              <strong>{TEXT_US_LABEL}</strong>
              <span className="inline-flex items-center gap-2">
                <MessageSquare className="size-4" aria-hidden="true" />
                {phone}
              </span>
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
