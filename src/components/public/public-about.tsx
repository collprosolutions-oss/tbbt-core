import { ABOUT_COPY } from "@/lib/public-site";

export function PublicAbout({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "" : "grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-center"}>
      <div>
        <p className="text-sm font-bold tracking-[0.18em] text-[var(--public-blue)] uppercase">
          {ABOUT_COPY.eyebrow}
        </p>
        <h2 className="mt-3 text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
          {ABOUT_COPY.title}
        </h2>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
          {ABOUT_COPY.lead}
        </p>
      </div>
      <ul className="grid gap-4">
        {ABOUT_COPY.points.map((point) => (
          <li
            key={point}
            className="rounded-2xl border border-border bg-white px-5 py-4 text-lg leading-7"
          >
            {point}
          </li>
        ))}
      </ul>
    </div>
  );
}
