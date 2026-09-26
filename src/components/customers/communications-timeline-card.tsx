import Link from "next/link";
import { CustomerCommunicationTimeline } from "@/components/communications/customer-communication-timeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CommunicationTimelineItem,
  CommunicationTimelineSummary,
} from "@/lib/communications/timeline";

export function CustomerCommunicationsCard({
  customerId,
  items,
  summary,
  timeZone,
}: {
  customerId: string;
  items: CommunicationTimelineItem[];
  summary: CommunicationTimelineSummary;
  timeZone: string;
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
        <CustomerCommunicationTimeline items={items} summary={summary} timeZone={timeZone} />
      </CardContent>
    </Card>
  );
}
