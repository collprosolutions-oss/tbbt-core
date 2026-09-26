import { Mail, Phone } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  recordedCustomerEmail,
  recordedCustomerPhone,
  requestCallHref,
  requestEmailHref,
  type RequestIdentityReviewContext,
} from "@/lib/request-follow-up";

export function RequestIdentityReviewNotice({
  review,
}: {
  review: RequestIdentityReviewContext | null;
}) {
  if (!review) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">Needs identity review</p>
      <p className="mt-1">{review.message}</p>
    </div>
  );
}

export function RequestIdentityReviewBadge({
  review,
}: {
  review: RequestIdentityReviewContext | null;
}) {
  if (!review) return null;
  return <StatusBadge status="IDENTITY_REVIEW" />;
}

export function RequestRecordedContact({
  phone,
  email,
}: {
  phone: string | null | undefined;
  email: string | null | undefined;
}) {
  const recordedPhone = recordedCustomerPhone(phone);
  const recordedEmail = recordedCustomerEmail(email);
  return (
    <div className="space-y-1 text-sm">
      <p>{recordedPhone ?? "No phone on file"}</p>
      <p>{recordedEmail ?? "No email on file"}</p>
    </div>
  );
}

export function RequestContactActions({
  phone,
  email,
  size = "default",
}: {
  phone: string | null | undefined;
  email: string | null | undefined;
  size?: "default" | "sm";
}) {
  const tel = requestCallHref(phone);
  const mailto = requestEmailHref(email);
  if (!tel && !mailto) return null;
  return (
    <>
      {tel ? (
        <Button asChild variant="outline" size={size}>
          <a href={tel}>
            <Phone className="size-4" />
            Call
          </a>
        </Button>
      ) : null}
      {mailto ? (
        <Button asChild variant="outline" size={size}>
          <a href={mailto}>
            <Mail className="size-4" />
            Email
          </a>
        </Button>
      ) : null}
    </>
  );
}
