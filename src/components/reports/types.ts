import type { BuiltReport, DatePreset, ReportArea } from "@/lib/reports";

export type ReportsWorkspaceProps = {
  area: ReportArea;
  rangePreset: DatePreset;
  from: string;
  to: string;
  report: BuiltReport;
};
