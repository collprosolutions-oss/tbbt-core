import Link from "next/link";
import { TBBT_SIGN_IN_HREF, TBBT_SIGN_UP_HREF } from "@/lib/tbbt-marketing";

export function TbbtContactPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Contact</p>
        <h1>Start in the product, not a fake inbox.</h1>
        <p className="tbbt-lead">
          TBBT does not publish a public support email or social accounts on
          this page yet. Use the existing account path — the same signup and
          sign-in routes the product already uses.
        </p>
      </header>
      <section className="tbbt-wrap tbbt-section" style={{ paddingTop: 0 }}>
        <article className="tbbt-panel tbbt-pillar">
          <p>
            A public contact form will be added when a real destination exists.
            Until then, create a workspace to begin the 30-day Founder Plan
            trial, or sign in if you already have an account.
          </p>
          <div className="tbbt-hero-actions">
            <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary tbbt-btn--lg">
              Start Free Trial
            </Link>
            <Link href={TBBT_SIGN_IN_HREF} className="tbbt-btn tbbt-btn--ghost tbbt-btn--lg">
              Sign In
            </Link>
          </div>
        </article>
      </section>
    </>
  );
}

export function TbbtPrivacyPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Privacy</p>
        <h1>How TBBT handles information.</h1>
      </header>
      <section className="tbbt-wrap tbbt-legal">
        <p>
          TBBT (Trades Business Builder Tool) is operated by Daniel LeBlanc.
          This page describes current product practices. It is not a substitute
          for a later attorney-reviewed policy if one is published.
        </p>
        <h2>Accounts</h2>
        <p>
          When you create a workspace we store the name, email, password hash,
          and business name you submit, plus the operating records you enter
          (customers, estimates, jobs, invoices, time, and related files).
        </p>
        <h2>Session cookies</h2>
        <p>
          Sign-in uses a session cookie so the app can recognize you. TBBT does
          not use that cookie as an advertising tracker.
        </p>
        <h2>Payments</h2>
        <p>
          TBBT subscription billing and customer card payments are processed by
          Stripe. Card details are handled by Stripe, not stored as raw card
          numbers in TBBT.
        </p>
        <h2>Email and files</h2>
        <p>
          Transactional email may be sent through the configured email provider.
          Website and job files may be stored with the platform object storage
          TBBT is configured to use.
        </p>
        <h2>Public business websites</h2>
        <p>
          A subscriber&apos;s public site (including CollPro on collproreno.com)
          shows the business information that business chooses to publish.
        </p>
        <h2>Contact</h2>
        <p>
          Privacy questions can be raised from a signed-in workspace once a
          public inbox is published. This page does not invent an email address.
        </p>
      </section>
    </>
  );
}

export function TbbtTermsPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Terms</p>
        <h1>Using TBBT.</h1>
      </header>
      <section className="tbbt-wrap tbbt-legal">
        <p>
          These terms describe the current launch offer. They are not a complete
          commercial contract and may be replaced by a fuller agreement later.
        </p>
        <h2>The product</h2>
        <p>
          TBBT is business software for trades and service companies. Handyman
          is the first live trade template. Other trades are planned and are
          not offered as live production templates today.
        </p>
        <h2>Founder Plan</h2>
        <p>
          Launch pricing is the Founder Plan at $49 per month. New workspaces
          begin with a 30-day free trial. No credit card is required to begin
          the trial. The Founder rate is intended to remain for accounts that
          stay continuously subscribed.
        </p>
        <h2>Your workspace</h2>
        <p>
          You are responsible for the accuracy of records you enter and for
          work you perform for your customers. TBBT does not become a party to
          your customer jobs.
        </p>
        <h2>Availability</h2>
        <p>
          Software is provided as it exists in the running product. Features
          labeled planned are not promised as current functionality.
        </p>
      </section>
    </>
  );
}
