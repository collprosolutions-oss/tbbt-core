import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CircleCheck,
  Droplets,
  Hammer,
  Home,
  Leaf,
  Paintbrush,
  Plus,
  Settings2,
  Sparkles,
  Square,
  TrendingUp,
  Warehouse,
  Wind,
  Wrench,
  Zap,
} from "lucide-react";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-trades.css";
import {
  TBBT_HERO_OFFER,
  TBBT_SIGN_UP_HREF,
  TBBT_TRADE_STATUS_LABEL,
  TBBT_TRADES,
  TBBT_TRADES_PAGE_CAPABILITIES,
  TBBT_TRADES_PAGE_CARDS,
  TBBT_TRADES_PAGE_CTA_HEADLINE,
  TBBT_TRADES_PAGE_CTA_SRC,
  TBBT_TRADES_PAGE_EYEBROW,
  TBBT_TRADES_PAGE_GRID_HEADING,
  TBBT_TRADES_PAGE_GRID_LEAD,
  TBBT_TRADES_PAGE_HEADLINE,
  TBBT_TRADES_PAGE_HERO_PRO_SRC,
  TBBT_TRADES_PAGE_PLATFORM_HEADLINE,
  TBBT_TRADES_PAGE_PLATFORM_KICKER,
  TBBT_TRADES_PAGE_PLATFORM_SRC,
  TBBT_TRADES_PAGE_PLATFORM_SUPPORT,
  TBBT_TRADES_PAGE_ROADMAP_LABEL,
  TBBT_TRADES_PAGE_SEE_FEATURES_LABEL,
  TBBT_TRADES_PAGE_SUPPORT,
  TBBT_TRADES_PAGE_VALUE_POINTS,
  TBBT_TRIAL_CTA_LABEL,
} from "@/lib/tbbt-marketing";

const VALUE_ICONS = [Settings2, BookOpen, TrendingUp] as const;

const TRADE_ICONS: Record<string, typeof Hammer> = {
  Handyman: Hammer,
  Cleaning: Sparkles,
  Electrical: Zap,
  Plumbing: Droplets,
  HVAC: Wind,
  Painting: Paintbrush,
  Landscaping: Leaf,
  Roofing: Home,
  Remodeling: Warehouse,
  Concrete: Square,
  Carpentry: Wrench,
  "And More": Plus,
};

function tradeBadgeClass(status: (typeof TBBT_TRADES)[number]["status"], badge?: string) {
  if (badge === TBBT_TRADES_PAGE_ROADMAP_LABEL) {
    return "tbbt-badge tbbt-badge--roadmap";
  }
  if (status === "available") {
    return "tbbt-badge tbbt-badge--available";
  }
  if (status === "coming-next") {
    return "tbbt-badge tbbt-badge--coming";
  }
  return "tbbt-badge";
}

export function TbbtTradesPage() {
  return (
    <div className="tbbt-trades">
      <section className="tbbt-trd-hero">
        <div className="tbbt-wrap tbbt-trd-hero-inner">
          <div className="tbbt-trd-hero-copy">
            <p className="tbbt-kicker">{TBBT_TRADES_PAGE_EYEBROW}</p>
            <h1>
              {TBBT_TRADES_PAGE_HEADLINE[0]}{" "}
              <span className="tbbt-trd-hero-accent">{TBBT_TRADES_PAGE_HEADLINE[1]}</span>
            </h1>
            <p className="tbbt-trd-hero-support">{TBBT_TRADES_PAGE_SUPPORT}</p>
            <div className="tbbt-trd-values">
              {TBBT_TRADES_PAGE_VALUE_POINTS.map((item, index) => {
                const Icon = VALUE_ICONS[index] ?? Sparkles;
                return (
                  <article className="tbbt-trd-value" key={item.kicker}>
                    <span className="tbbt-trd-value-icon" aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <div>
                      <strong>{item.kicker}</strong>
                      <p>{item.body}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
          <div className="tbbt-trd-hero-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={TBBT_TRADES_PAGE_HERO_PRO_SRC}
              alt="Tradesman from behind wearing a TBBT shirt that reads Build, Manage, Grow"
            />
          </div>
        </div>
      </section>

      <section className="tbbt-trd-grid-band" id="supported-trades">
        <div className="tbbt-wrap">
          <div className="tbbt-trd-grid-head">
            <h2>{TBBT_TRADES_PAGE_GRID_HEADING}</h2>
            <p className="tbbt-muted">{TBBT_TRADES_PAGE_GRID_LEAD}</p>
          </div>
          <div className="tbbt-trd-grid">
            {TBBT_TRADES.map((trade) => {
              const card = TBBT_TRADES_PAGE_CARDS[trade.name];
              const Icon = TRADE_ICONS[trade.name] ?? Wrench;
              const badge = card?.badge;
              const label = badge ?? TBBT_TRADE_STATUS_LABEL[trade.status];
              return (
                <article
                  key={trade.name}
                  className={
                    trade.name === "And More"
                      ? "tbbt-trd-card tbbt-trd-card--more"
                      : "tbbt-trd-card"
                  }
                >
                  {card?.src ? (
                    <div className="tbbt-trd-photo">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={card.src}
                        alt=""
                        style={
                          card.position
                            ? { objectPosition: card.position }
                            : undefined
                        }
                      />
                    </div>
                  ) : (
                    <div className="tbbt-trd-photo tbbt-trd-photo--more" aria-hidden="true">
                      <span>
                        <Plus size={28} />
                      </span>
                    </div>
                  )}
                  <div className="tbbt-trd-card-body">
                    <h3>
                      <Icon size={14} />
                      {trade.name}
                    </h3>
                    <p>{card?.summary ?? trade.summary}</p>
                    <span className={tradeBadgeClass(trade.status, badge)}>
                      {label}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-trd-platform" id="platform">
        <div className="tbbt-wrap tbbt-trd-platform-inner">
          <div className="tbbt-trd-platform-copy">
            <p className="tbbt-kicker">{TBBT_TRADES_PAGE_PLATFORM_KICKER}</p>
            <h2>
              {TBBT_TRADES_PAGE_PLATFORM_HEADLINE[0]}
              <br />
              <span className="tbbt-trd-hero-accent">
                {TBBT_TRADES_PAGE_PLATFORM_HEADLINE[1]}
              </span>
            </h2>
            <p className="tbbt-muted">{TBBT_TRADES_PAGE_PLATFORM_SUPPORT}</p>
            <div className="tbbt-hero-actions tbbt-trd-platform-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <Link href="/features" className="tbbt-btn tbbt-btn--ghost tbbt-btn--lg">
                {TBBT_TRADES_PAGE_SEE_FEATURES_LABEL}
              </Link>
            </div>
          </div>
          <div className="tbbt-trd-platform-visual">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={TBBT_TRADES_PAGE_PLATFORM_SRC}
              alt="TBBT website and workspace on laptop and phone"
            />
          </div>
          <ul className="tbbt-trd-caps">
            {TBBT_TRADES_PAGE_CAPABILITIES.map((item) => (
              <li key={item}>
                <CircleCheck size={15} aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="tbbt-trd-cta">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="tbbt-trd-cta-photo" src={TBBT_TRADES_PAGE_CTA_SRC} alt="" />
        <div className="tbbt-wrap tbbt-trd-cta-inner">
          <div>
            <h2>{TBBT_TRADES_PAGE_CTA_HEADLINE}</h2>
            <p className="tbbt-muted tbbt-trd-cta-lead">{TBBT_HERO_OFFER}</p>
            <div className="tbbt-hero-actions tbbt-trd-cta-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
