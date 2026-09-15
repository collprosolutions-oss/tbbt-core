export function TbbtProductPreview() {
  return (
    <div className="tbbt-product" aria-hidden="true">
      <div className="tbbt-product-chrome">
        <span className="tbbt-dot" />
        <span className="tbbt-dot" />
        <span className="tbbt-dot" />
        <span>TBBT workspace · Dashboard</span>
      </div>
      <div className="tbbt-product-grid">
        <div className="tbbt-product-rail">
          <span className="tbbt-rail-item is-active" />
          <span className="tbbt-rail-item" />
          <span className="tbbt-rail-item" />
          <span className="tbbt-rail-item" />
          <span className="tbbt-rail-item" />
          <span className="tbbt-rail-item" />
        </div>
        <div className="tbbt-product-main">
          <div className="tbbt-kpi-row">
            <div className="tbbt-kpi">
              <span>Requests</span>
              <strong>Open</strong>
            </div>
            <div className="tbbt-kpi">
              <span>Schedule</span>
              <strong>Today</strong>
            </div>
            <div className="tbbt-kpi">
              <span>Invoices</span>
              <strong>Due</strong>
            </div>
          </div>
          <div className="tbbt-rows">
            <div className="tbbt-row">
              <span>Estimate ready for review</span>
              <span>Office</span>
            </div>
            <div className="tbbt-row">
              <span>Job scheduled this week</span>
              <span>Field</span>
            </div>
            <div className="tbbt-row">
              <span>Invoice after completion</span>
              <span>Billing</span>
            </div>
          </div>
        </div>
      </div>
      <div className="tbbt-phone">
        <div className="tbbt-phone-bar" />
        <div className="tbbt-phone-card">Today&apos;s job</div>
        <div className="tbbt-phone-card">Time card</div>
        <div className="tbbt-phone-card">Customer notes</div>
      </div>
      <div className="tbbt-trades-strip">
        <span className="tbbt-chip">Handyman</span>
        <span className="tbbt-chip">Cleaning</span>
        <span className="tbbt-chip">Electrical</span>
        <span className="tbbt-chip">Plumbing</span>
        <span className="tbbt-chip">HVAC</span>
      </div>
    </div>
  );
}
