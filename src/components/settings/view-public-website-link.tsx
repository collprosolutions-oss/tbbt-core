import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { publicHomePath } from "@/lib/public-site";

export function ViewPublicWebsiteLink({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const href = publicHomePath(slug);
  return (
    <div className={className}>
      <p className="text-sm text-muted-foreground">
        Public website:{" "}
        <span className="break-all font-medium text-foreground">{href}</span>
      </p>
      <Link
        href={href}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "outline", className: "mt-2" })}
      >
        View Public Website
      </Link>
    </div>
  );
}
