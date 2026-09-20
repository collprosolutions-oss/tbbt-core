import { PublicUnavailable } from "@/components/public/public-unavailable";

export default function PublicRequestNotFound() {
  return (
    <PublicUnavailable
      title="Request unavailable"
      body="This request could not be submitted."
    />
  );
}
