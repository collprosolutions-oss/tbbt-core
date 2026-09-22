import Link from "next/link";
import {
  ArrowRight,
  Cog,
  Globe,
  Handshake,
  Quote,
  Rocket,
  Shield,
  Star,
  TrendingUp,
  Users,
  Wrench,
} from "lucide-react";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-about.css";
import {
  TBBT_ABOUT_DIRECTION,
  TBBT_ABOUT_FOUNDER_BIO,
  TBBT_ABOUT_FOUNDER_HEADING,
  TBBT_ABOUT_FOUNDER_NAME,
  TBBT_ABOUT_FOUNDER_QUOTE,
  TBBT_ABOUT_FOUNDER_ROLE,
  TBBT_ABOUT_MISSION,
  TBBT_ABOUT_PAGE_CTA_BUTTON,
  TBBT_ABOUT_PAGE_CTA_HEADLINE,
  TBBT_ABOUT_PAGE_CTA_SRC,
  TBBT_ABOUT_PAGE_CTA_SUPPORT,
  TBBT_ABOUT_PAGE_EYEBROW,
  TBBT_ABOUT_PAGE_FOUNDER_SRC,
  TBBT_ABOUT_PAGE_HEADLINE,
  TBBT_ABOUT_PAGE_HERO_SRC,
  TBBT_ABOUT_PAGE_MISSION_CTA,
  TBBT_ABOUT_PAGE_MISSION_SRC,
  TBBT_ABOUT_PAGE_SCRIPT,
  TBBT_ABOUT_PAGE_SUPPORT,
  TBBT_ABOUT_PAGE_WATCH_STORY_LABEL,
  TBBT_ABOUT_VALUES,
  TBBT_ABOUT_VALUES_INTRO,
  TBBT_ABOUT_VISION,
  TBBT_BRAND_MOTTO,
  TBBT_SIGN_UP_HREF,
  TBBT_TAGLINE,
} from "@/lib/tbbt-marketing";

const VALUE_ICONS = {
  simplicity: Cog,
  trades: Users,
  fair: Shield,
  growth: TrendingUp,
  support: Handshake,
  improve: Star,
} as const;

const DIRECTION_ICONS = {
  platform: Users,
  trades: Wrench,
  serve: Globe,
  experience: Star,
  future: Rocket,
} as const;

export function TbbtAboutPage() {
  const [taglineLead, taglineAccent] = TBBT_TAGLINE.split(". ");

  return (
    <div className="tbbt-about">
      <section className="tbbt-abt-hero">
        <div className="tbbt-wrap tbbt-abt-hero-inner">
          <div className="tbbt-abt-hero-copy">
            <p className="tbbt-kicker">{TBBT_ABOUT_PAGE_EYEBROW}</p>
            <h1>
              {TBBT_ABOUT_PAGE_HEADLINE[0]}
              <br />
              <span className="tbbt-abt-accent">{TBBT_ABOUT_PAGE_HEADLINE[1]}</span>
            </h1>
            <p className="tbbt-abt-hero-support">{TBBT_ABOUT_PAGE_SUPPORT}</p>
            <div className="tbbt-hero-actions tbbt-abt-hero-actions">
              <a href="#our-mission" className="tbbt-btn tbbt-btn--primary">
                {TBBT_ABOUT_PAGE_MISSION_CTA}
                <ArrowRight size={16} />
              </a>
              <TbbtWatchVideoButton
                className="tbbt-btn tbbt-btn--ghost"
                label={TBBT_ABOUT_PAGE_WATCH_STORY_LABEL}
              />
            </div>
          </div>
          <div className="tbbt-abt-hero-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={TBBT_ABOUT_PAGE_HERO_SRC}
              alt="Tradesman from behind wearing a TBBT shirt that reads Build, Manage, Grow"
            />
            <p className="tbbt-abt-script">
              {TBBT_ABOUT_PAGE_SCRIPT.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
          </div>
        </div>
      </section>

      <section className="tbbt-abt-values" aria-label="Our values">
        <div className="tbbt-wrap tbbt-abt-values-inner">
          <div className="tbbt-abt-values-intro">
            <h2>{TBBT_ABOUT_VALUES_INTRO.heading}</h2>
            <p>{TBBT_ABOUT_VALUES_INTRO.body}</p>
          </div>
          {TBBT_ABOUT_VALUES.map((item) => {
            const Icon = VALUE_ICONS[item.icon];
            return (
              <article key={item.title} className="tbbt-abt-value">
                <span className="tbbt-abt-value-icon" aria-hidden="true">
                  <Icon size={22} />
                </span>
                <h3>{item.title}</h3>
                <p>
                  {item.body.split("\n").map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tbbt-abt-purpose" id="our-mission" aria-label="Mission and vision">
        <div className="tbbt-wrap tbbt-abt-purpose-grid">
          <article className="tbbt-abt-purpose-copy">
            <h2>{TBBT_ABOUT_MISSION.heading}</h2>
            <p>{TBBT_ABOUT_MISSION.body}</p>
          </article>
          <div className="tbbt-abt-purpose-panel">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={TBBT_ABOUT_PAGE_MISSION_SRC} alt="" />
            <p className="tbbt-abt-purpose-tagline">
              <span>{taglineLead}.</span>
              <strong>{taglineAccent}</strong>
            </p>
          </div>
          <article className="tbbt-abt-purpose-copy">
            <h2>{TBBT_ABOUT_VISION.heading}</h2>
            <p>{TBBT_ABOUT_VISION.body}</p>
          </article>
        </div>
      </section>

      <section className="tbbt-abt-direction" aria-label="Company direction">
        <div className="tbbt-wrap tbbt-abt-direction-grid">
          {TBBT_ABOUT_DIRECTION.map((item) => {
            const Icon = DIRECTION_ICONS[item.icon];
            return (
              <article key={item.kicker} className="tbbt-abt-direction-item">
                <span aria-hidden="true">
                  <Icon size={22} />
                </span>
                <div>
                  <strong>{item.kicker}</strong>
                  <p>{item.body}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tbbt-abt-founder" aria-label="Meet the founder">
        <div className="tbbt-wrap tbbt-abt-founder-grid">
          <h2>{TBBT_ABOUT_FOUNDER_HEADING}</h2>
          <figure className="tbbt-abt-founder-photo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={TBBT_ABOUT_PAGE_FOUNDER_SRC}
              alt="Daniel LeBlanc, founder of TBBT"
            />
          </figure>
          <div className="tbbt-abt-founder-bio">
            <h3>{TBBT_ABOUT_FOUNDER_NAME}</h3>
            <p className="tbbt-abt-founder-role">{TBBT_ABOUT_FOUNDER_ROLE}</p>
            <p>{TBBT_ABOUT_FOUNDER_BIO}</p>
          </div>
          <blockquote className="tbbt-abt-founder-quote">
            <Quote size={22} aria-hidden="true" />
            <p>{TBBT_ABOUT_FOUNDER_QUOTE}</p>
            <cite>— {TBBT_ABOUT_FOUNDER_NAME}</cite>
          </blockquote>
        </div>
      </section>

      <section className="tbbt-abt-cta">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="tbbt-abt-cta-photo" src={TBBT_ABOUT_PAGE_CTA_SRC} alt="" />
        <div className="tbbt-wrap tbbt-abt-cta-inner">
          <div className="tbbt-abt-cta-copy">
            <h2>{TBBT_ABOUT_PAGE_CTA_HEADLINE}</h2>
            <p>{TBBT_ABOUT_PAGE_CTA_SUPPORT}</p>
            <div className="tbbt-hero-actions tbbt-abt-cta-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_ABOUT_PAGE_CTA_BUTTON}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton />
            </div>
          </div>
          <div className="tbbt-abt-cta-script">
            <p>{TBBT_BRAND_MOTTO}</p>
            <span>{TBBT_TAGLINE}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
