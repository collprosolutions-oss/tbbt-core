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
      <div className="tbbt-laptop tbbt-laptop--hero">
        <div className="tbbt-laptop-lid">
          <span className="tbbt-laptop-cam" />
          <div className="tbbt-laptop-screen">
            <div className="tbbt-dash">
              <div className="tbbt-dash-rail">
                <b>TBBT</b>
                <span className="is-on">Dashboard</span>
                <span>Jobs</span>
                <span>Estimates</span>
                <span>Schedule</span>
                <span>Invoices</span>
                <span>Time Cards</span>
              </div>
              <div className="tbbt-dash-main">
                <div className="tbbt-dash-hello">
                  <span>TBBT workspace</span>
                  <strong>Today&apos;s work</strong>
                </div>
                <div className="tbbt-dash-kpis tbbt-dash-kpis--4">
                  <div>
                    <span>Jobs today</span>
                    <b>On deck</b>
                  </div>
                  <div>
                    <span>Estimates</span>
                    <b>To review</b>
                  </div>
                  <div>
                    <span>Schedule</span>
                    <b>This week</b>
                  </div>
                  <div>
                    <span>Invoices</span>
                    <b>Ready</b>
                  </div>
                </div>
                <div className="tbbt-dash-split">
                  <div>
                    <em>Today&apos;s schedule</em>
                    <div className="tbbt-dash-row">
                      <span>Kitchen repair</span>
                      <span>Field</span>
                    </div>
                    <div className="tbbt-dash-row">
                      <span>Estimate visit</span>
                      <span>Office</span>
                    </div>
                    <div className="tbbt-dash-row">
                      <span>Fixture install</span>
                      <span>Field</span>
                    </div>
                  </div>
                  <div>
                    <em>Business health</em>
                    <div className="tbbt-dash-row">
                      <span>Reviews to request</span>
                      <span>Follow up</span>
                    </div>
                    <div className="tbbt-dash-row">
                      <span>Invoices after jobs</span>
                      <span>Billing</span>
                    </div>
                    <div className="tbbt-dash-row">
                      <span>Hours recorded</span>
                      <span>Time</span>
                    </div>
                  </div>
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
  const heading = variant === "ops" ? "Customers" : "Today";
  const items =
    variant === "ops"
      ? ["Website request", "Estimate sent", "Job in progress", "Invoice due"]
      : ["8:00 · Kitchen repair", "10:00 · Estimate visit", "1:00 · Install fixture", "3:30 · Follow-up"];

  return (
    <div className="tbbt-phone-ui" aria-hidden="true">
      <div className="tbbt-notch" />
      <p className="tbbt-phone-brand">TBBT</p>
      <h3>{heading}</h3>
      {items.map((item) => (
        <div className="tbbt-phone-item" key={item}>
          {item}
        </div>
      ))}
      <div className="tbbt-phone-nav">
        <span>Jobs</span>
        <span>Estimates</span>
        <span>Invoices</span>
        <span>Schedule</span>
        <span>Time</span>
      </div>
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
      <div className="tbbt-grow-chart">
        <span>Business activity</span>
        <strong>Last 6 months</strong>
        <div className="tbbt-grow-cols">
          <i style={{ height: "32%" }} />
          <i style={{ height: "44%" }} />
          <i style={{ height: "40%" }} />
          <i style={{ height: "58%" }} />
          <i style={{ height: "67%" }} />
          <i style={{ height: "84%" }} />
        </div>
        <em>Jobs, invoices, and hours from TBBT records</em>
      </div>
      <div className="tbbt-grow-coach">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/tbbt-marketing/grow-coach.png" alt="" />
        <div>
          <span className="tbbt-badge">Planned</span>
          <strong>Business Coach</strong>
          <p>Coming later — not a live AI feature today.</p>
        </div>
      </div>
    </div>
  );
}
