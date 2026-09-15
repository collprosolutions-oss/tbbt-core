import Link from "next/link";
import { TbbtProductPreview } from "@/components/tbbt-marketing/product-preview";
import { TbbtWatchVideoButton } from "@/components/tbbt-marketing/watch-video";
import {
  TBBT_BRAND_MOTTO,
  TBBT_CORE_FEATURES,
  TBBT_HERO_HEADLINE,
  TBBT_HERO_SUPPORT,
  TBBT_OPERATING_HELP,
  TBBT_PILLARS,
  TBBT_POSITIONING,
  TBBT_PROMISE_STRIP,
  TBBT_SIGN_UP_HREF,
  TBBT_TAGLINE,
  TBBT_TRADE_STATUS_LABEL,
  TBBT_TRADES,
  TBBT_TRIAL_CTA_LABEL,
  TBBT_WORKFLOW_STEPS,
} from "@/lib/tbbt-marketing";

export function TbbtHomePage() {
  return (
    <>
      <section className="tbbt-wrap tbbt-hero">
        <div>
          <p className="tbbt-kicker">{TBBT_BRAND_MOTTO}</p>
          <h1>
            {TBBT_HERO_HEADLINE[0]}
            <br />
            {TBBT_HERO_HEADLINE[1]}
            <br />
            {TBBT_HERO_HEADLINE[2]}
          </h1>
          <p className="tbbt-lead">{TBBT_HERO_SUPPORT}</p>
          <ul className="tbbt-help-list">
            {TBBT_OPERATING_HELP.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="tbbt-hero-actions">
            <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
              {TBBT_TRIAL_CTA_LABEL}
            </Link>
            <TbbtWatchVideoButton />
          </div>
          <p className="tbbt-muted" style={{ marginTop: "1rem" }}>
            {TBBT_TAGLINE}
          </p>
        </div>
        <TbbtProductPreview />
      </section>

      <section className="tbbt-wrap tbbt-section" aria-label="What TBBT is for">
        <div className="tbbt-promises">
          {TBBT_PROMISE_STRIP.map((item) => (
            <article key={item.kicker} className="tbbt-card tbbt-promise">
              <strong>{item.kicker}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <p className="tbbt-kicker">Built for the trades</p>
        <h2>One operating system. Many trades over time.</h2>
        <p className="tbbt-lead">
          TBBT is not a handyman-only product. Handyman is the first live
          template. Cleaning is next. Other trades share the same business
          operating system and are marked honestly until they can launch.
        </p>
        <div className="tbbt-trade-grid" style={{ marginTop: "1.4rem" }}>
          {TBBT_TRADES.map((trade) => (
            <article key={trade.name} className="tbbt-card tbbt-trade-card">
              <span
                className={
                  trade.status === "available"
                    ? "tbbt-badge tbbt-badge--available"
                    : trade.status === "coming-next"
                      ? "tbbt-badge tbbt-badge--coming"
                      : "tbbt-badge"
                }
              >
                {TBBT_TRADE_STATUS_LABEL[trade.status]}
              </span>
              <h3 style={{ margin: "0.7rem 0 0.35rem", fontSize: "1.2rem" }}>
                {trade.name}
              </h3>
              <p className="tbbt-muted">{trade.summary}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <p className="tbbt-kicker">{TBBT_BRAND_MOTTO}</p>
        <h2>The original idea, in production form.</h2>
        <div className="tbbt-pillars" style={{ marginTop: "1.4rem" }}>
          {TBBT_PILLARS.map((pillar) => (
            <article key={pillar.kicker} className="tbbt-panel tbbt-pillar">
              <p className="tbbt-kicker">{pillar.kicker}</p>
              <h3>{pillar.title}</h3>
              <p className="tbbt-muted">{pillar.body}</p>
              <ul>
                {pillar.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <p className="tbbt-kicker">It&apos;s all connected</p>
        <h2>The customer lifecycle stays in one system.</h2>
        <p className="tbbt-lead">
          TBBT connects the full customer and business lifecycle so a lead is
          not retyped into a spreadsheet, then a calendar, then an invoice app.
        </p>
        <div className="tbbt-flow" style={{ marginTop: "1.3rem" }}>
          {TBBT_WORKFLOW_STEPS.map((step, index) => (
            <div className="tbbt-flow-step" key={step}>
              <span className="tbbt-flow-node">{step}</span>
              {index < TBBT_WORKFLOW_STEPS.length - 1 ? (
                <span className="tbbt-flow-arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <p className="tbbt-kicker">In the product today</p>
        <h2>The operating pieces trades actually use.</h2>
        <div className="tbbt-feature-grid" style={{ marginTop: "1.4rem" }}>
          {TBBT_CORE_FEATURES.map((feature) => (
            <article key={feature.title} className="tbbt-card tbbt-feature-card">
              <h3 style={{ margin: "0 0 0.45rem", fontSize: "1.15rem" }}>
                {feature.title}
              </h3>
              <p className="tbbt-muted">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <div className="tbbt-panel tbbt-cta-band">
          <div>
            <p className="tbbt-kicker">{TBBT_POSITIONING}</p>
            <h2 style={{ marginBottom: 0 }}>Start with the Founder Plan trial.</h2>
            <p className="tbbt-muted" style={{ marginTop: "0.55rem" }}>
              New workspaces begin with a 30-day free trial. No credit card is
              required to begin. Handyman is the first available trade.
            </p>
          </div>
          <div>
            <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
              {TBBT_TRIAL_CTA_LABEL}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
