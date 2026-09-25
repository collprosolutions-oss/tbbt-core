import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  ClipboardList,
  CreditCard,
  FileText,
  Hammer,
  RefreshCw,
  ShieldCheck,
  Smile,
  Sparkles,
  Timer,
  Users,
  Wrench,
} from "lucide-react";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-home.css";
import {
  TBBT_BRAND_MOTTO,
  TBBT_DIFFERENTIATION,
  TBBT_FOUNDER_NO_CARD,
  TBBT_FOUNDER_PLAN_DISPLAY_NAME,
  TBBT_FOUNDER_PRICE_LABEL,
  TBBT_FOUNDER_PROTECTION,
  TBBT_FOUNDER_TRIAL_LABEL,
  TBBT_HERO_ACCENT,
  TBBT_HERO_EYEBROW,
  TBBT_HERO_HEADLINE,
  TBBT_HERO_OFFER,
  TBBT_HERO_SCRIPT,
  TBBT_HERO_SUPPORT_LINES,
  TBBT_HOMEPAGE_PRICING_POINTS,
  TBBT_HOW_IT_WORKS,
  TBBT_PROMISE_STRIP,
  TBBT_SEE_WHAT_YOU_GET_HREF,
  TBBT_SEE_WHAT_YOU_GET_LABEL,
  TBBT_SIGN_UP_HREF,
  TBBT_TRADE_STATUS_LABEL,
  TBBT_TRADE_THUMBS,
  TBBT_TRADES,
  TBBT_TRIAL_CTA_LABEL,
  TBBT_WORKFLOW_STEPS,
} from "@/lib/tbbt-marketing";

const BENEFIT_ICONS = [Timer, Sparkles, Users, ShieldCheck] as const;

const WORKFLOW_ICONS = [
  ClipboardList,
  Users,
  FileText,
  CalendarClock,
  Hammer,
  FileText,
  CreditCard,
  Smile,
  RefreshCw,
] as const;

function tradeBadgeClass(status: (typeof TBBT_TRADES)[number]["status"]) {
  if (status === "available") return "tbbt-badge tbbt-badge--available";
  if (status === "coming-next") return "tbbt-badge tbbt-badge--coming";
  return "tbbt-badge";
}

export function TbbtHomePage() {
  return (
    <div className="tbbt-home">
      <section className="tbbt-hero-cinematic">
        <div className="tbbt-wrap tbbt-hero-stage">
          <div className="tbbt-hero-copy">
            <p className="tbbt-eyebrow">{TBBT_HERO_EYEBROW}</p>
            <h1>
              {TBBT_HERO_HEADLINE[0]}
              <br />
              {TBBT_HERO_HEADLINE[1]}
              <br />
              <span className="tbbt-hero-lastline">
                {TBBT_HERO_HEADLINE[2]}{" "}
                <span className="tbbt-accent">{TBBT_HERO_ACCENT}</span>
              </span>
            </h1>
            <p className="tbbt-hero-support">{TBBT_HERO_SUPPORT_LINES.join(" ")}</p>
            <p className="tbbt-hero-offer">{TBBT_HERO_OFFER}</p>
            <div className="tbbt-hero-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <Link href={TBBT_SEE_WHAT_YOU_GET_HREF} className="tbbt-btn tbbt-btn--ghost tbbt-btn--lg">
                {TBBT_SEE_WHAT_YOU_GET_LABEL}
              </Link>
            </div>
          </div>

          <div className="tbbt-hero-visual">
            <div className="tbbt-hero-pro">
              <p className="tbbt-script tbbt-hero-script">{TBBT_HERO_SCRIPT}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/tbbt-marketing/hero-tradespro.png"
                alt="Trades professional in the shop"
              />
            </div>
            <div className="tbbt-hero-devices" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/tbbt-marketing/hero-devices.png" alt="" />
            </div>
          </div>

          <div className="tbbt-benefit-row">
            {TBBT_PROMISE_STRIP.map((item, index) => {
              const Icon = BENEFIT_ICONS[index] ?? Sparkles;
              return (
                <div className="tbbt-benefit" key={item.kicker}>
                  <Icon size={18} />
                  {item.kicker}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-band tbbt-band--trades">
        <div className="tbbt-wrap">
          <div className="tbbt-split-head">
            <h2>Built for trades businesses</h2>
            <p className="tbbt-muted">
              Handyman is the live starting setup today. Additional trades
              are planned after the core platform is completed — they are
              not launched yet.
            </p>
          </div>
          <div className="tbbt-trade-strip">
            {TBBT_TRADES.map((trade) => {
              const thumb = TBBT_TRADE_THUMBS[trade.name];
              return (
                <figure className="tbbt-thumb" key={trade.name}>
                  <div className="tbbt-thumb-photo">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb.src}
                        alt=""
                        style={thumb.position ? { objectPosition: thumb.position } : undefined}
                      />
                    ) : (
                      <div className="tbbt-thumb-fallback">
                        <Wrench size={28} />
                      </div>
                    )}
                  </div>
                  <figcaption>
                    <span>{trade.name}</span>
                    <span className={tradeBadgeClass(trade.status)}>
                      {TBBT_TRADE_STATUS_LABEL[trade.status]}
                    </span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-band tbbt-band--brg" id="what-you-get">
        <div className="tbbt-wrap">
          <div className="tbbt-brg-head">
            <h2>Build. Run. Grow.</h2>
            <p className="tbbt-muted">
              One system to get online, run the work, and grow from records you
              already keep.
            </p>
          </div>
          <div className="tbbt-brg">
            <article className="tbbt-brg-card tbbt-brg-card--build-photo">
              <Link href="/features#website-builder" className="tbbt-brg-build-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/tbbt-marketing/build-card.png"
                  alt="BUILD — A Professional Website for Your Business"
                />
              </Link>
            </article>
            <article className="tbbt-brg-card tbbt-brg-card--run-photo">
              <Link href="#connected" className="tbbt-brg-run-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/tbbt-marketing/run-card.png"
                  alt="RUN — Manage Your Day With Ease"
                />
              </Link>
            </article>
            <article className="tbbt-brg-card tbbt-brg-card--grow-photo">
              <Link href="/features" className="tbbt-brg-grow-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/tbbt-marketing/grow-card.png"
                  alt="GROW — A Business Partner That Works for You"
                />
              </Link>
            </article>
          </div>
        </div>
      </section>

      <section className="tbbt-band tbbt-how" id="how-it-works">
        <div className="tbbt-wrap">
          <div className="tbbt-split-head">
            <h2>How it works</h2>
            <p className="tbbt-muted">
              Self-serve setup. No custom domain is included automatically.
            </p>
          </div>
          <ol className="tbbt-how-grid">
            {TBBT_HOW_IT_WORKS.map((item) => (
              <li className="tbbt-how-card" key={item.step}>
                <span className="tbbt-how-step">{item.step}</span>
                <h3>{item.title}</h3>
                <p className="tbbt-muted">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="tbbt-band tbbt-offer" id="founder-plan">
        <div className="tbbt-wrap tbbt-offer-grid">
          <div className="tbbt-offer-copy">
            <h2>{TBBT_DIFFERENTIATION.title}</h2>
            <p className="tbbt-muted">{TBBT_DIFFERENTIATION.body}</p>
          </div>
          <article className="tbbt-panel tbbt-price tbbt-offer-price">
            <p className="tbbt-kicker">{TBBT_FOUNDER_PLAN_DISPLAY_NAME}</p>
            <p className="tbbt-amount">{TBBT_FOUNDER_PRICE_LABEL}</p>
            <p className="tbbt-muted">
              {TBBT_FOUNDER_TRIAL_LABEL}. {TBBT_FOUNDER_NO_CARD}
            </p>
            <ul>
              {TBBT_HOMEPAGE_PRICING_POINTS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="tbbt-muted tbbt-offer-protect">{TBBT_FOUNDER_PROTECTION}</p>
            <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
              {TBBT_TRIAL_CTA_LABEL}
            </Link>
          </article>
        </div>
      </section>

      <section className="tbbt-band tbbt-connected" id="connected">
        <div className="tbbt-wrap">
          <div className="tbbt-connected-head">
            <h2>It&apos;s all connected</h2>
            <p className="tbbt-muted">
              From the first customer inquiry to the final payment — everything
              works together.
            </p>
            <Link href="/features" className="tbbt-btn tbbt-btn--primary">
              See the Full System
              <ArrowRight size={16} />
            </Link>
          </div>
          <div className="tbbt-connected-flow">
            {TBBT_WORKFLOW_STEPS.map((step, index) => {
              const Icon = WORKFLOW_ICONS[index] ?? ClipboardList;
              const last = index === TBBT_WORKFLOW_STEPS.length - 1;
              return (
                <div className="tbbt-connected-item" key={step}>
                  <div className="tbbt-connected-step">
                    <span className="tbbt-connected-icon">
                      <Icon size={22} />
                    </span>
                    {step}
                  </div>
                  {last ? null : <span className="tbbt-connected-arrow" aria-hidden="true">→</span>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="tbbt-band tbbt-founder-note">
        <div className="tbbt-wrap tbbt-founder-note-inner">
          <p className="tbbt-kicker">Built from the trade</p>
          <h2>TBBT is being built from real trades operating experience.</h2>
          <p className="tbbt-muted">
            Not a generic software experiment. The workflows follow how the
            work actually moves: request, estimate, job, invoice.
          </p>
          <Link href="/about" className="tbbt-btn tbbt-btn--ghost">
            About TBBT
          </Link>
        </div>
      </section>

      <section className="tbbt-final-cta">
        <div className="tbbt-wrap tbbt-final-inner">
          <div className="tbbt-final-side" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/tbbt-marketing/cta-sunset.png" alt="" />
          </div>
          <div>
            <h2>Ready to run the business from one place?</h2>
            <p className="tbbt-muted tbbt-final-lead">
              Start the 30-day Founder trial. No credit card required.
            </p>
            <div className="tbbt-hero-actions tbbt-final-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton />
            </div>
          </div>
          <div className="tbbt-final-motto">
            <p className="tbbt-script tbbt-final-script">{TBBT_BRAND_MOTTO}</p>
            <p className="tbbt-final-tagline">
              More Than Tools.
              <br />
              A Better Way Forward.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
