import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Building2,
  CalendarClock,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Lightbulb,
  Megaphone,
  TrendingUp,
  Users,
} from "lucide-react";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-resources.css";
import {
  TBBT_RESOURCE_CATEGORIES,
  TBBT_RESOURCES_BROWSE_HEADING,
  TBBT_RESOURCES_BROWSE_LEAD,
  TBBT_RESOURCES_DOWNLOADS,
  TBBT_RESOURCES_DOWNLOADS_HEADING,
  TBBT_RESOURCES_FAQ_HEADING,
  TBBT_RESOURCES_FAQ_LEAD,
  TBBT_RESOURCES_FAQ_VIEW_ALL,
  TBBT_RESOURCES_FAQS,
  TBBT_RESOURCES_FEATURED,
  TBBT_RESOURCES_FEATURED_HEADING,
  TBBT_RESOURCES_FEATURED_LEAD,
  TBBT_RESOURCES_FEATURED_VIEW_ALL,
  TBBT_RESOURCES_PAGE_CTA_BUTTON,
  TBBT_RESOURCES_PAGE_CTA_HEADLINE,
  TBBT_RESOURCES_PAGE_CTA_SRC,
  TBBT_RESOURCES_PAGE_CTA_SUPPORT,
  TBBT_RESOURCES_PAGE_EYEBROW,
  TBBT_RESOURCES_PAGE_HEADLINE,
  TBBT_RESOURCES_PAGE_HEADLINE_ACCENT,
  TBBT_RESOURCES_PAGE_HERO_SRC,
  TBBT_RESOURCES_PAGE_SCRIPT,
  TBBT_RESOURCES_PAGE_SUPPORT,
  TBBT_RESOURCES_PAGE_WATCH_LABEL,
  TBBT_RESOURCES_VALUE_POINTS,
  TBBT_SIGN_UP_HREF,
  TBBT_TAGLINE,
} from "@/lib/tbbt-marketing";

const VALUE_ICONS = {
  learn: BookOpen,
  tools: ClipboardList,
  trades: Users,
  grow: TrendingUp,
} as const;

const CATEGORY_ICONS = {
  setup: Building2,
  pricing: CircleDollarSign,
  marketing: Megaphone,
  templates: FileText,
  operations: CalendarClock,
  insights: Lightbulb,
} as const;

export function TbbtResourcesPage() {
  const [taglineLead, taglineAccent] = TBBT_TAGLINE.split(". ");

  return (
    <div className="tbbt-resources">
      <section className="tbbt-res-hero">
        <div className="tbbt-wrap tbbt-res-hero-inner">
          <div className="tbbt-res-hero-copy">
            <p className="tbbt-kicker">{TBBT_RESOURCES_PAGE_EYEBROW}</p>
            <h1>
              {TBBT_RESOURCES_PAGE_HEADLINE[0]}
              <br />
              {TBBT_RESOURCES_PAGE_HEADLINE[1]}{" "}
              <span className="tbbt-res-accent">{TBBT_RESOURCES_PAGE_HEADLINE_ACCENT}</span>
            </h1>
            <p className="tbbt-res-hero-support">
              {TBBT_RESOURCES_PAGE_SUPPORT.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
            <ul className="tbbt-res-values">
              {TBBT_RESOURCES_VALUE_POINTS.map((item) => {
                const Icon = VALUE_ICONS[item.icon];
                return (
                  <li key={item.title}>
                    <span aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    {item.title}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="tbbt-res-hero-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={TBBT_RESOURCES_PAGE_HERO_SRC}
              alt="TBBT mug, tools, and tape measure on a workbench"
            />
            <p className="tbbt-res-script">
              {TBBT_RESOURCES_PAGE_SCRIPT.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
          </div>
        </div>
      </section>

      <section className="tbbt-res-featured" id="featured-resources" aria-label="Featured resources">
        <div className="tbbt-wrap">
          <div className="tbbt-res-featured-head">
            <h2>{TBBT_RESOURCES_FEATURED_HEADING}</h2>
            <p>{TBBT_RESOURCES_FEATURED_LEAD}</p>
            <a className="tbbt-res-text-link" href="#browse-categories">
              {TBBT_RESOURCES_FEATURED_VIEW_ALL}
              <ArrowRight size={14} />
            </a>
          </div>
          <div className="tbbt-res-featured-grid">
            {TBBT_RESOURCES_FEATURED.map((item) => (
              <article key={item.key} className="tbbt-res-card">
                <div className="tbbt-res-card-media">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.src} alt={item.alt} />
                </div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <span className="tbbt-res-text-link">
                  {item.action}
                  <ArrowRight size={14} />
                </span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="tbbt-res-library" aria-label="Resource library">
        <div className="tbbt-wrap tbbt-res-library-grid">
          <div id="browse-categories">
            <h2>{TBBT_RESOURCES_BROWSE_HEADING}</h2>
            <p>{TBBT_RESOURCES_BROWSE_LEAD}</p>
            <div className="tbbt-res-category-grid">
              {TBBT_RESOURCE_CATEGORIES.map((category) => {
                const Icon = CATEGORY_ICONS[category.icon];
                return (
                  <a key={category.title} className="tbbt-res-category" href="#featured-resources">
                    <span aria-hidden="true">
                      <Icon size={20} />
                    </span>
                    {category.title}
                  </a>
                );
              })}
            </div>
          </div>

          <div>
            <h2>{TBBT_RESOURCES_DOWNLOADS_HEADING}</h2>
            <ul className="tbbt-res-downloads">
              {TBBT_RESOURCES_DOWNLOADS.map((item) => (
                <li key={item.title}>
                  <span aria-hidden="true">
                    <FileText size={16} />
                  </span>
                  {item.title} ({item.format})
                </li>
              ))}
            </ul>
          </div>

          <div id="resources-faqs">
            <h2>{TBBT_RESOURCES_FAQ_HEADING}</h2>
            <p>{TBBT_RESOURCES_FAQ_LEAD}</p>
            <ul className="tbbt-res-faqs">
              {TBBT_RESOURCES_FAQS.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
            <a className="tbbt-res-text-link" href="#resources-faqs">
              {TBBT_RESOURCES_FAQ_VIEW_ALL}
              <ArrowRight size={14} />
            </a>
          </div>
        </div>
      </section>

      <section className="tbbt-res-cta">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="tbbt-res-cta-photo" src={TBBT_RESOURCES_PAGE_CTA_SRC} alt="" />
        <div className="tbbt-wrap tbbt-res-cta-inner">
          <div className="tbbt-res-cta-copy">
            <h2>{TBBT_RESOURCES_PAGE_CTA_HEADLINE}</h2>
            <p>{TBBT_RESOURCES_PAGE_CTA_SUPPORT}</p>
            <div className="tbbt-hero-actions tbbt-res-cta-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary">
                {TBBT_RESOURCES_PAGE_CTA_BUTTON}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton
                className="tbbt-btn tbbt-btn--ghost"
                label={TBBT_RESOURCES_PAGE_WATCH_LABEL}
              />
            </div>
          </div>
          <div className="tbbt-res-cta-script">
            <p>
              <span>{taglineLead}.</span>
              <strong>{taglineAccent}</strong>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
