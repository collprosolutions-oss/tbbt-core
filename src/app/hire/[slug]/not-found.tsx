import { PublicUnavailable } from "@/components/public/public-unavailable";

export default function PublicHireNotFound() {
  return (
    <PublicUnavailable
      title="Page unavailable"
      body="This business could not be found."
    />
  );
}
