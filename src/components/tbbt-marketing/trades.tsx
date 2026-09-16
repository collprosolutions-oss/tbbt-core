import Link from "next/link";
import {
  TBBT_SIGN_UP_HREF,
  TBBT_TRADE_STATUS_LABEL,
  TBBT_TRADES,
  TBBT_TRIAL_CTA_LABEL,
} from "@/lib/tbbt-marketing";

export function TbbtTradesPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Trades</p>
        <h1>One Platform. Every Trade.</h1>
        <p className="tbbt-lead">
          TBBT is one business operating system with trade-specific setup,
          services, pricing concepts, and workflows. It is not a separate
          application for each trade, and it is not handyman-only.
        </p>
      </header>

      <section className="tbbt-wrap tbbt-section" style={{ paddingTop: 0 }}>
        <div className="tbbt-trade-grid">
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
              <h2 style={{ margin: "0.75rem 0 0.4rem", fontSize: "1.3rem" }}>
                {trade.name}
              </h2>
              <p className="tbbt-muted">{trade.summary}</p>
            </article>
          ))}
        </div>
        <p className="tbbt-muted" style={{ marginTop: "1.4rem" }}>
          New accounts start on the Handyman template because that is the trade
          that is live. Cleaning and later trades will reuse this same
          platform when they are ready — they cannot be selected as live
          production trades today.
        </p>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <div className="tbbt-panel tbbt-cta-band">
          <div>
            <h2 style={{ marginBottom: 0 }}>Start on the live Handyman template.</h2>
            <p className="tbbt-muted" style={{ marginTop: "0.5rem" }}>
              The 30-day Founder Plan trial uses the existing TBBT signup path.
            </p>
          </div>
          <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
            {TBBT_TRIAL_CTA_LABEL}
          </Link>
        </div>
      </section>
    </>
  );
}
