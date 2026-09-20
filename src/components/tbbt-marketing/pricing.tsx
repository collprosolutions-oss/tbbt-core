import Link from "next/link";
import {
  TBBT_FOUNDER_NO_CARD,
  TBBT_FOUNDER_PLAN_DISPLAY_NAME,
  TBBT_FOUNDER_PRICE_LABEL,
  TBBT_FOUNDER_TRIAL_LABEL,
  TBBT_PRICING_FEATURES,
  TBBT_SIGN_UP_HREF,
  TBBT_TRIAL_CTA_LABEL,
} from "@/lib/tbbt-marketing";

export function TbbtPricingPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Pricing</p>
        <h1>One launch plan. No invented tiers.</h1>
        <p className="tbbt-lead">
          TBBT is launching with a single Founder Plan. There is no Starter,
          Business, or Enterprise ladder on this page, and there are no paid
          add-on prices published here.
        </p>
      </header>

      <section className="tbbt-wrap tbbt-section" style={{ paddingTop: 0 }}>
        <article className="tbbt-panel tbbt-price">
          <p className="tbbt-kicker">TBBT {TBBT_FOUNDER_PLAN_DISPLAY_NAME}</p>
          <p className="tbbt-amount">{TBBT_FOUNDER_PRICE_LABEL}</p>
          <p className="tbbt-muted">
            {TBBT_FOUNDER_TRIAL_LABEL}. {TBBT_FOUNDER_NO_CARD} The
            Founder rate is protected while you stay continuously subscribed.
          </p>
          <ul>
            {TBBT_PRICING_FEATURES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
            {TBBT_TRIAL_CTA_LABEL}
          </Link>
        </article>
        <p className="tbbt-muted" style={{ marginTop: "1.4rem", maxWidth: "40rem" }}>
          Future plans or features may be introduced as TBBT grows. Nothing on
          this page promises additional paid tiers, prices, or add-ons that are
          not offered today.
        </p>
      </section>
    </>
  );
}
