import { NextResponse } from "next/server";
import { requireFakeTestCheckoutSession } from "@/lib/payments/test-checkout";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const session = await requireFakeTestCheckoutSession(sessionId);
  return NextResponse.redirect(session.cancelUrl, 303);
}
