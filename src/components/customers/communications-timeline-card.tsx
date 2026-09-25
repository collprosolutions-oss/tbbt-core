import Link from "next/link";
import { CommunicationTimelineList } from "@/components/communications/timeline-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CommunicationTimelineItem } from "@/lib/communications/timeline";

export function CustomerCommunicationsCard({
  customerId,
  items,
}: {
  customerId: string;
  items: CommunicationTimelineItem[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Communications</CardTitle>
        <Button asChild size="sm" variant="outline">
          <Link href={`/communications?area=compose&customerId=${customerId}`}>Compose</Link>
        </Button>
      </CardHeader>
      <CardContent>
        <CommunicationTimelineList items={items} />
      </CardContent>
    </Card>
  );
}
