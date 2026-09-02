"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import {
  PROJECT_FILTERS,
  filterPublicProjects,
  publicProjectCaption,
  type ProjectFilter,
} from "@/lib/public-projects";

export function PublicProjectsGallery() {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const projects = useMemo(() => filterPublicProjects(filter), [filter]);

  return (
    <div className="bg-[var(--public-paper)]">
      <div className="public-container">
        <div className="public-filter-bar">
          <p className="text-xs font-extrabold tracking-[0.12em] uppercase">Filter Projects:</p>
          {PROJECT_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="public-chip"
              data-active={filter === item.id ? "true" : "false"}
              onClick={() => setFilter(item.id)}
            >
              {item.id === "all" ? "All Projects" : item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="public-container pb-12">
        <ul className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const caption = publicProjectCaption(project);
            return (
              <li key={project.id}>
                <article className="public-project-card">
                  <div className="public-project-tile public-project-tile--lg">
                    <Image
                      src={project.src}
                      alt={caption.title}
                      fill
                      sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    />
                  </div>
                  <div className="public-project-caption">
                    <h2>{caption.title}</h2>
                    {caption.description ? <p>{caption.description}</p> : null}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
