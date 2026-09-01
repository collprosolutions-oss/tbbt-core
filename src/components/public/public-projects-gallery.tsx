"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import {
  PROJECT_FILTERS,
  filterPublicProjects,
  type ProjectFilter,
} from "@/lib/public-projects";

export function PublicProjectsGallery() {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const projects = useMemo(() => filterPublicProjects(filter), [filter]);

  return (
    <div className="bg-[var(--public-paper)]">
      <div className="public-container py-6">
        <div className="flex flex-wrap items-center gap-3">
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
      <div className="public-container pb-16">
        <ul className="grid gap-5 md:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id}>
              <article className="public-project-tile">
                <Image src={project.src} alt={project.title} fill sizes="(max-width: 768px) 100vw, 50vw" />
                <div className="public-project-tile-bar">
                  <h2>{project.title}</h2>
                  <p>{PROJECT_FILTERS.find((item) => item.id === project.filters[0])?.label}</p>
                </div>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
