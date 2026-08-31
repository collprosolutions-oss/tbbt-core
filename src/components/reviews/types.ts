import type { ReviewArea } from "@/lib/reviews";
import type { ReviewsSource } from "@/lib/reviews-data";

export type ReviewsWorkspaceProps = {
  area: ReviewArea;
  source: ReviewsSource;
};
