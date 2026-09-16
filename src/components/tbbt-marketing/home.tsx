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
import {
  TbbtDashboardMock,
  TbbtGrowMock,
  TbbtRunPhones,
  TbbtWebsiteMock,
} from "@/components/tbbt-marketing/product-preview";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import "@/components/tbbt-marketing/tbbt-home.css";
import {
  TBBT_BRAND_MOTTO,
  TBBT_HERO_ACCENT,
  TBBT_HERO_HEADLINE,
  TBBT_HERO_SCRIPT,
  TBBT_HERO_SUPPORT_LINES,
  TBBT_PILLARS,
  TBBT_PROMISE_STRIP,
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

const [buildPillar, runPillar, growPillar] = TBBT_PILLARS;

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
            <p className="tbbt-eyebrow">More than tools. A better way to build your business.</p>
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
            <div className="tbbt-hero-actions">
              <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
                {TBBT_TRIAL_CTA_LABEL}
                <ArrowRight size={16} />
              </Link>
              <TbbtWatchVideoButton />
            </div>
          </div>

          <div className="tbbt-hero-visual">
            <p className="tbbt-script tbbt-hero-script">{TBBT_HERO_SCRIPT}</p>
            <div className="tbbt-hero-pro">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/tbbt-marketing/hero-tradespro.png"
                alt="Trades professional in the shop"
              />
            </div>
            <TbbtDashboardMock />
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
            <h2>Built for every trade</h2>
            <p className="tbbt-muted">
              Same powerful platform. Customized for your trade.
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

      <section className="tbbt-band tbbt-band--brg">
        <div className="tbbt-wrap">
          <div className="tbbt-brg-head">
            <h2>Build. Run. Grow.</h2>
            <p className="tbbt-muted">
              Website, operations, and business insight — one connected system.
            </p>
          </div>
          <div className="tbbt-brg">
            <article className="tbbt-brg-card">
            <p className="tbbt-kicker">{buildPillar.kicker}</p>
            <h3>{buildPillar.title}</h3>
            <p>{buildPillar.body}</p>
            <div className="tbbt-device-web">
              <TbbtWebsiteMock />
            </div>
            <Link href="/features#website-builder" className="tbbt-btn tbbt-btn--ghost">
              See Website Builder
              <ArrowRight size={16} />
            </Link>
          </article>
            <article className="tbbt-brg-card">
            <p className="tbbt-kicker">{runPillar.kicker}</p>
            <h3>{runPillar.title}</h3>
            <p>{runPillar.body}</p>
            <div className="tbbt-device-run">
              <TbbtRunPhones />
            </div>
            <Link href="#connected" className="tbbt-btn tbbt-btn--ghost">
              See How It Works
              <ArrowRight size={16} />
            </Link>
          </article>
            <article className="tbbt-brg-card">
            <p className="tbbt-kicker">{growPillar.kicker}</p>
            <h3>{growPillar.title}</h3>
            <p>{growPillar.body}</p>
            <TbbtGrowMock />
            <Link href="/features" className="tbbt-btn tbbt-btn--ghost">
              See Reports
              <ArrowRight size={16} />
            </Link>
          </article>
          </div>
        </div>
      </section>

      <section className="tbbt-band tbbt-connected" id="connected">
        <div className="tbbt-wrap">
          <div className="tbbt-connected-head">
            <h2>It&apos;s all connected</h2>
            <p className="tbbt-muted">
              From the first customer inquiry to the final payment, everything
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
                      <Icon size={18} />
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

      <section className="tbbt-final-cta">
        <div className="tbbt-wrap tbbt-final-inner">
          <p className="tbbt-final-side">
            TBBT
            <br />
            Build today.
            <br />
            A stronger tomorrow.
          </p>
          <div>
            <h2>Ready to Build a Better Business?</h2>
            <p className="tbbt-muted tbbt-final-lead">
              Start the 30-day Founder Plan trial. No credit card required to
              begin. Handyman is the first available trade.
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
