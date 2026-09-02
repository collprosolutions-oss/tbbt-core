export type ProjectFilter =
  | "all"
  | "carpentry"
  | "storage"
  | "walls"
  | "lanai"
  | "installations";

export type PublicProject = {
  id: string;
  /** Public project title. Owner-approved display name for this photo. */
  title: string;
  /**
   * Public project description / caption.
   * Empty means the gallery shows the title only. Never invent work,
   * materials, duration, location, price, or customer statements.
   */
  description: string;
  src: string;
  width: number;
  height: number;
  filters: readonly ProjectFilter[];
};

/** Public caption fields for any TBBT subscriber project photo. */
export function publicProjectCaption(project: Pick<PublicProject, "title" | "description">) {
  const title = project.title.trim();
  const description = project.description.trim();
  return {
    title,
    description: description && description !== title ? description : null,
  };
}

export const PROJECT_FILTERS: { id: ProjectFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "carpentry", label: "Carpentry" },
  { id: "storage", label: "Storage" },
  { id: "walls", label: "Walls & Finishes" },
  { id: "lanai", label: "Lanai / Exterior" },
  { id: "installations", label: "Installations" },
];

/**
 * Real CollPro project photographs supplied by the founder.
 * Titles stay conservative and only describe what the photo shows.
 */
export const PUBLIC_PROJECTS: PublicProject[] = [
  {
    id: "feature-wall-tv",
    title: "Feature wall and TV mounting",
    description: "Barn-board style wall finish with a mounted television.",
    src: "/brand/projects/feature-wall-tv.jpg",
    width: 1600,
    height: 1145,
    filters: ["walls", "installations"],
  },
  {
    id: "bathroom-shiplap",
    title: "Bathroom wall update",
    description: "White wall paneling and a vanity light in a bathroom corner.",
    src: "/brand/projects/bathroom-shiplap.jpg",
    width: 1600,
    height: 1145,
    filters: ["walls"],
  },
  {
    id: "closet",
    title: "Custom closet organization",
    description: "White closet system with shelves, hanging rods, and drawers.",
    src: "/brand/projects/closet.jpg",
    width: 1500,
    height: 2000,
    filters: ["storage", "carpentry"],
  },
  {
    id: "wall-cabinets",
    title: "Custom wall cabinets",
    description: "Upper cabinets and open shelving during installation.",
    src: "/brand/projects/wall-cabinets.jpg",
    width: 1600,
    height: 1200,
    filters: ["storage", "carpentry"],
  },
  {
    id: "dishwasher",
    title: "Kitchen appliance installation",
    description: "Dishwasher fitted between existing kitchen cabinets.",
    src: "/brand/projects/dishwasher.jpg",
    width: 1448,
    height: 1086,
    filters: ["installations"],
  },
  {
    id: "lanai-porch",
    title: "Lanai and porch finish",
    description: "Finished porch interior with ceiling, trim, and wall paneling.",
    src: "/brand/projects/lanai-porch.jpg",
    width: 1536,
    height: 1100,
    filters: ["lanai", "carpentry"],
  },
  {
    id: "outdoor-storage",
    title: "Outdoor storage organization",
    description: "Shed interior organized with shelving and stored equipment.",
    src: "/brand/projects/outdoor-storage.jpg",
    width: 1600,
    height: 1145,
    filters: ["storage", "lanai"],
  },
  {
    id: "exterior-carpentry",
    title: "Exterior storage carpentry",
    description: "Custom wood platform and enclosure in an outdoor utility area.",
    src: "/brand/projects/exterior-carpentry.jpg",
    width: 1600,
    height: 1145,
    filters: ["carpentry", "lanai"],
  },
  {
    id: "door-install",
    title: "Interior door installation",
    description: "Interior door being fitted and fastened at the hinges.",
    src: "/brand/projects/door-install.jpg",
    width: 1122,
    height: 1402,
    filters: ["installations", "carpentry"],
  },
  {
    id: "furniture-assembly",
    title: "Furniture assembly",
    description: "Desk assembly with hardware laid out for a complete build.",
    src: "/brand/projects/furniture-assembly.jpg",
    width: 1402,
    height: 1122,
    filters: ["installations"],
  },
  {
    id: "picture-hanging",
    title: "Picture hanging and leveling",
    description: "Framed artwork being leveled on an interior wall.",
    src: "/brand/projects/picture-hanging.jpg",
    width: 1448,
    height: 1086,
    filters: ["installations"],
  },
  {
    id: "bathroom-toilet",
    title: "Bathroom fixture installation",
    description: "Newly set bathroom fixture against finished flooring and cabinetry.",
    src: "/brand/projects/bathroom-toilet.jpg",
    width: 1086,
    height: 1448,
    filters: ["installations"],
  },
];

export function filterPublicProjects(filter: ProjectFilter) {
  if (filter === "all") return PUBLIC_PROJECTS;
  return PUBLIC_PROJECTS.filter((project) => project.filters.includes(filter));
}

/** Real portfolio photos only — skip unknown IDs, never invent filler. */
export function selectPublicProjectsById(ids: readonly string[]) {
  const byId = new Map(PUBLIC_PROJECTS.map((project) => [project.id, project]));
  return ids.flatMap((id) => {
    const project = byId.get(id);
    return project ? [project] : [];
  });
}
