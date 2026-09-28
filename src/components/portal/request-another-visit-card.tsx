import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { publicRepeatVisitPath } from "@/lib/cleaning-repeat-visit";

export function RequestAnotherVisitCard({
  projectToken,
  alreadyRequested,
}: {
  projectToken: string;
  alreadyRequested: boolean;
}) {
  return (
    <Card id="another-visit">
      <CardHeader>
        <CardTitle>Request another visit</CardTitle>
        <CardDescription>
          Ask this Cleaning business to review another visit. Submitting a request does
          not schedule a job, take payment, or send a message.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {alreadyRequested ? (
          <p>We already received your request for another visit. The team will review it.</p>
        ) : (
          <p>
            <Link
              href={publicRepeatVisitPath(projectToken)}
              className="underline underline-offset-4"
            >
              Request another visit
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
