export function TbbtDashboardMock() {
  return (
    <div className="tbbt-dash-stack" aria-hidden="true">
      <aside className="tbbt-platform-card">
        <strong>One platform. Any trade.</strong>
        <ul>
          <li>Simple to use</li>
          <li>Professional results</li>
          <li>Built for real work</li>
          <li>Affordable</li>
          <li>No long-term contracts</li>
          <li>Grows with you</li>
        </ul>
      </aside>
      <div className="tbbt-laptop">
        <div className="tbbt-laptop-lid">
          <span className="tbbt-laptop-cam" />
          <div className="tbbt-laptop-screen">
            <div className="tbbt-dash">
              <div className="tbbt-dash-rail">
                <b>TBBT</b>
                <span className="is-on" />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="tbbt-dash-main">
                <div className="tbbt-dash-hello">
                  <span>TBBT workspace</span>
                  <strong>Here&apos;s what&apos;s happening in the business</strong>
                </div>
                <div className="tbbt-dash-kpis">
                  <div>
                    <span>Today&apos;s jobs</span>
                    <b>3</b>
                  </div>
                  <div>
                    <span>Estimates</span>
                    <b>Review</b>
                  </div>
                  <div>
                    <span>Jobs this week</span>
                    <b>Active</b>
                  </div>
                </div>
                <div className="tbbt-dash-row">
                  <span>Kitchen repair — scheduled</span>
                  <span>Field</span>
                </div>
                <div className="tbbt-dash-row">
                  <span>Estimate ready for review</span>
                  <span>Office</span>
                </div>
                <div className="tbbt-dash-row">
                  <span>Invoice after completion</span>
                  <span>Billing</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="tbbt-laptop-base" />
      </div>
      <div className="tbbt-hero-phone">
        <TbbtPhoneMock variant="nav" />
      </div>
    </div>
  );
}

export function TbbtPhoneMock({
  variant = "schedule",
}: {
  variant?: "schedule" | "nav" | "ops";
}) {
  const items =
    variant === "ops"
      ? ["Lead inbox", "Estimate sent", "Job in progress", "Invoice due"]
      : ["8:00 · Kitchen repair", "10:00 · Estimate visit", "1:00 · Install fixture", "3:30 · Customer meeting"];

  return (
    <div className="tbbt-phone-ui" aria-hidden="true">
      <div className="tbbt-notch" />
      <h3>{variant === "ops" ? "Pipeline" : "Today"}</h3>
      {items.map((item) => (
        <div className="tbbt-phone-item" key={item}>
          {item}
        </div>
      ))}
      {variant === "nav" ? (
        <div className="tbbt-phone-nav">
          <span>Jobs</span>
          <span>Estimates</span>
          <span>Invoices</span>
          <span>More</span>
        </div>
      ) : null}
    </div>
  );
}

export function TbbtWebsiteMock() {
  return (
    <div className="tbbt-laptop tbbt-laptop--site" aria-hidden="true">
      <div className="tbbt-laptop-lid">
        <span className="tbbt-laptop-cam" />
        <div className="tbbt-site-mock">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/tbbt-marketing/build-house.png" alt="" />
          <div className="tbbt-site-mock-body">
            <strong>Professional Home Services</strong>
            <em>Reliable. Local. Done Right.</em>
            <span>Request a Quote</span>
            <div className="tbbt-site-tiles">
              <b>Repairs</b>
              <b>Remodeling</b>
              <b>Painting</b>
            </div>
          </div>
        </div>
      </div>
      <div className="tbbt-laptop-base" />
    </div>
  );
}

export function TbbtRunPhones() {
  return (
    <div className="tbbt-run-phones" aria-hidden="true">
      <TbbtPhoneMock />
      <TbbtPhoneMock variant="ops" />
    </div>
  );
}

export function TbbtGrowMock() {
  return (
    <div className="tbbt-grow-ui" aria-hidden="true">
      <header>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/tbbt-marketing/grow-coach.png" alt="" />
        <div>
          <span className="tbbt-badge">Planned</span>
          <strong>Business Success OS</strong>
        </div>
      </header>
      <p>
        Coaching from recorded jobs, invoices, and time — not a live AI
        feature today.
      </p>
      <ul>
        <li>Review today&apos;s open estimates</li>
        <li>Follow up after completed jobs</li>
        <li>Stay on track for weekly goals</li>
      </ul>
    </div>
  );
}
