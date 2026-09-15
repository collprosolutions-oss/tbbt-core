export function TbbtDashboardMock() {
  return (
    <div className="tbbt-dash-stack" aria-hidden="true">
      <aside className="tbbt-platform-card">
        <strong>One platform. Any trade.</strong>
        <ul>
          <li>Simple to use</li>
          <li>Built for real work</li>
          <li>Professional results</li>
          <li>Grows with you</li>
        </ul>
      </aside>
      <div className="tbbt-laptop">
        <div className="tbbt-laptop-lid">
          <div className="tbbt-laptop-screen">
            <div className="tbbt-dash">
              <div className="tbbt-dash-rail">
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
                  <strong>Today in the business</strong>
                </div>
                <div className="tbbt-dash-kpis">
                  <div>
                    <span>Requests</span>
                    <b>Open</b>
                  </div>
                  <div>
                    <span>Schedule</span>
                    <b>Today</b>
                  </div>
                  <div>
                    <span>Jobs</span>
                    <b>Active</b>
                  </div>
                </div>
                <div className="tbbt-dash-row">
                  <span>Estimate ready for review</span>
                  <span>Office</span>
                </div>
                <div className="tbbt-dash-row">
                  <span>Job on today&apos;s calendar</span>
                  <span>Field</span>
                </div>
                <div className="tbbt-dash-row">
                  <span>Invoice after completion</span>
                  <span>Billing</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="tbbt-hero-phone">
        <TbbtPhoneMock />
      </div>
    </div>
  );
}

export function TbbtPhoneMock() {
  return (
    <div className="tbbt-phone-ui" aria-hidden="true">
      <div className="tbbt-notch" />
      <h3>Today</h3>
      <div className="tbbt-phone-item">8:00 · Kitchen repair</div>
      <div className="tbbt-phone-item">10:00 · Estimate visit</div>
      <div className="tbbt-phone-item">1:00 · Install fixture</div>
      <div className="tbbt-phone-item">3:30 · Customer meeting</div>
    </div>
  );
}

export function TbbtWebsiteMock() {
  return (
    <div className="tbbt-site-mock" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/tbbt-marketing/build-house.png" alt="" />
      <div className="tbbt-site-mock-body">
        <strong>Professional Home Services</strong>
        <span>Request a Quote</span>
        <div className="tbbt-site-tiles">
          <b>Repairs</b>
          <b>Remodeling</b>
          <b>Painting</b>
        </div>
      </div>
    </div>
  );
}

export function TbbtGrowMock() {
  return (
    <div className="tbbt-grow-ui">
      <span className="tbbt-badge">Planned</span>
      <p>
        Business Success coaching is a direction for later. It is not a
        production AI feature today.
      </p>
    </div>
  );
}
