import {
  TBBT_RESOURCE_CATEGORIES,
} from "@/lib/tbbt-marketing";

export function TbbtResourcesPage() {
  return (
    <>
      <header className="tbbt-wrap tbbt-page-hero">
        <p className="tbbt-kicker">Resources</p>
        <h1>A real hub. No invented library.</h1>
        <p className="tbbt-lead">
          These categories are the structure of the TBBT resource library.
          Articles and downloads will be added here when they exist. Nothing
          below pretends a guide is already published.
        </p>
      </header>

      <section className="tbbt-wrap tbbt-section" style={{ paddingTop: 0 }}>
        <div className="tbbt-resource-grid">
          {TBBT_RESOURCE_CATEGORIES.map((category) => (
            <article key={category.title} className="tbbt-card tbbt-resource-card">
              <span className="tbbt-badge">Coming soon</span>
              <h2 style={{ margin: "0.7rem 0 0.4rem", fontSize: "1.25rem" }}>
                {category.title}
              </h2>
              <p className="tbbt-muted">{category.body}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
