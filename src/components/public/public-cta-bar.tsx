import Link from "next/link";
import { ArrowRight, ClipboardList, Phone } from "lucide-react";
import { PRIMARY_CTA_LABEL } from "@/lib/public-site";

export function PublicCtaBar({
  title,
  body,
  requestHref,
  callHref,
  phone,
}: {
  title: string;
  body: string;
  requestHref: string;
  callHref: string | null;
  phone: string | null;
}) {
  return (
    <section className="public-cta-bar">
      <div className="public-container public-cta-inner">
        <div className="flex items-start gap-4">
          <span className="public-icon-circle shrink-0 bg-[var(--public-blue)] text-white">
            <ClipboardList className="size-5" aria-hidden="true" />
          </span>
          <div className="public-cta-copy">
            <h2>{title}</h2>
            <p>{body}</p>
          </div>
        </div>
        <div className="public-cta-actions">
          <Link href={requestHref} className="public-btn public-btn-primary">
            {PRIMARY_CTA_LABEL}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          {callHref ? (
            <a href={callHref} className="public-btn public-btn-ghost">
              <Phone className="size-4" aria-hidden="true" />
              Call or Text {phone}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
