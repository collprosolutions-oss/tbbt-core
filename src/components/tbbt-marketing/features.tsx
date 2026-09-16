import Link from "next/link";
import {
  TBBT_ADDITIONAL_FEATURES,
  TBBT_CORE_FEATURES,
  TBBT_SIGN_UP_HREF,
  TBBT_TRIAL_CTA_LABEL,
} from "@/lib/tbbt-marketing";

export function TbbtFeaturesPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Features</p>
        <h1>The operating system, not a pile of apps.</h1>
        <p className="tbbt-lead">
          These cards describe capabilities that exist in TBBT today. Where a
          direction is not yet production software, it is labeled planned.
        </p>
      </header>

      <section className="tbbt-wrap tbbt-section" style={{ paddingTop: 0 }}>
        <div className="tbbt-feature-grid">
          {TBBT_CORE_FEATURES.map((feature) => (
            <article
              key={feature.title}
              id={feature.href.replace("/features#", "")}
              className="tbbt-card tbbt-feature-card"
            >
              <span className="tbbt-badge tbbt-badge--available">In product</span>
              <h2 style={{ margin: "0.7rem 0 0.45rem", fontSize: "1.35rem" }}>
                {feature.title}
              </h2>
              <p className="tbbt-muted">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <p className="tbbt-kicker">Also in the workspace</p>
        <h2>Related tools, labeled honestly.</h2>
        <div className="tbbt-feature-grid" style={{ marginTop: "1.3rem" }}>
          {TBBT_ADDITIONAL_FEATURES.map((feature) => (
            <article key={feature.title} className="tbbt-card tbbt-feature-card">
              <span
                className={
                  feature.status === "live"
                    ? "tbbt-badge tbbt-badge--available"
                    : "tbbt-badge"
                }
              >
                {feature.status === "live" ? "In product" : "Planned"}
              </span>
              <h3 style={{ margin: "0.7rem 0 0.45rem", fontSize: "1.2rem" }}>
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
            <h2 style={{ marginBottom: 0 }}>See it in your own workspace.</h2>
            <p className="tbbt-muted" style={{ marginTop: "0.5rem" }}>
              Sign up uses the existing TBBT account path and 30-day Founder
              Plan trial.
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
