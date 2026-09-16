import Link from "next/link";
import {
  TBBT_SIGN_UP_HREF,
  TBBT_TRIAL_CTA_LABEL,
  TBBT_VALUES,
} from "@/lib/tbbt-marketing";

export function TbbtAboutPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">About</p>
        <h1>Built by a Tradesman. For the Trades.</h1>
        <p className="tbbt-lead">
          TBBT exists to help trades businesses become more professional,
          organized, and easier to operate — and to give owners more freedom.
          Software should reduce owner stress, not become another job.
        </p>
      </header>

      <section className="tbbt-wrap tbbt-section" style={{ paddingTop: 0 }}>
        <article className="tbbt-panel tbbt-pillar">
          <p className="tbbt-kicker">Founder</p>
          <h2 style={{ marginTop: 0 }}>Daniel LeBlanc</h2>
          <p>
            Daniel is a third-generation carpenter with decades of hands-on
            trades and business experience. TBBT was built from problems that
            show up in the field and in the office: scattered leads, estimates
            that live in a different place than the job, invoices that do not
            follow the work, and a public presence that does not match how the
            business actually operates.
          </p>
          <p className="tbbt-muted">
            This page does not publish customer counts, revenue, awards, or
            testimonials. Those will appear when they are real.
          </p>
          <div className="tbbt-asset-slot" style={{ marginTop: "1rem" }}>
            Founder portrait slot
            <br />
            public/brand/tbbt-marketing/founder.jpg · 4:5 · 1200×1500
          </div>
        </article>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <p className="tbbt-kicker">Values</p>
        <h2>How TBBT is supposed to behave.</h2>
        <div className="tbbt-value-grid" style={{ marginTop: "1.3rem" }}>
          {TBBT_VALUES.map((value) => (
            <article key={value.title} className="tbbt-card tbbt-value-card">
              <h3 style={{ margin: "0 0 0.45rem", fontSize: "1.15rem" }}>
                {value.title}
              </h3>
              <p className="tbbt-muted">{value.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="tbbt-wrap tbbt-section">
        <div className="tbbt-panel tbbt-cta-band">
          <div>
            <h2 style={{ marginBottom: 0 }}>Build. Run. Grow.</h2>
            <p className="tbbt-muted" style={{ marginTop: "0.5rem" }}>
              More than tools. A better way forward.
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
