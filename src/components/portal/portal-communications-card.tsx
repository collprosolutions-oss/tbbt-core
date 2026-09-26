import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { PortalCommunicationItem } from "@/lib/portal-project-home";

export function PortalCommunicationsCard({
  messages,
  timeZone,
}: {
  messages: PortalCommunicationItem[];
  timeZone: string;
}) {
  return (
    <Card id="messages">
      <CardHeader>
        <CardTitle>Messages</CardTitle>
        <CardDescription>
          Messages we have already sent or received for this project. Sent is
          not the same as delivered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {messages.length === 0 ? (
          <p className="text-muted-foreground">
            No recorded project messages yet.
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="space-y-1 rounded-lg border p-3">
              <p className="font-medium">
                {message.purposeLabel}
                {message.direction === "INBOUND" ? " · From you" : ""}
                {message.direction === "OUTBOUND" ? " · From us" : ""}
              </p>
              <p className="text-muted-foreground">
                {formatDateTime(message.occurredAt, timeZone)}
                {" · "}
                {message.channel}
                {" · "}
                {message.statusLabel}
              </p>
              {message.body.trim() ? (
                <p className="whitespace-pre-line">{message.body}</p>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
