import type { KnowledgeArea } from "@/lib/knowledge";
import type { KnowledgeSource } from "@/lib/knowledge-data";

export type KnowledgeWorkspaceProps = {
  area: KnowledgeArea;
  source: KnowledgeSource;
};
