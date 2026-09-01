"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import {
  PROJECT_FILTERS,
  PUBLIC_PROJECTS,
  filterPublicProjects,
  type ProjectFilter,
} from "@/lib/public-projects";

export function PublicProjectsGallery() {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const projects = useMemo(() => filterPublicProjects(filter), [filter]);

  return (
    <div>
      <div className="bg-[var(--public-navy)]">
        <div className="public-container flex flex-wrap gap-2 py-5">
          {PROJECT_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="public-chip public-chip-dark"
              data-active={filter === item.id ? "true" : "false"}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="public-container py-12 lg:py-16">
        <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {projects.map((project) => (
            <li key={project.id}>
              <article className="public-project-card">
                <div className="public-project-card-media">
                  <Image
                    src={project.src}
                    alt={project.title}
                    fill
                    sizes="(max-width: 768px) 100vw, 25vw"
                  />
                </div>
                <div className="public-project-card-body">
                  <h2>{project.title}</h2>
                  <p>{project.description}</p>
                </div>
              </article>
            </li>
          ))}
        </ul>
        {projects.length === 0 ? (
          <p className="mt-6 text-center text-muted-foreground">
            No projects in this group yet.
          </p>
        ) : null}
        <p className="mt-8 text-center text-sm text-muted-foreground">
          Showing {projects.length} of {PUBLIC_PROJECTS.length} project photos.
        </p>
      </div>
    </div>
  );
}
