import { NextResponse } from "next/server";
import {
  completeFakeTestCheckout,
  fakeTestCheckoutSuccessHref,
} from "@/lib/payments/test-checkout";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const session = await completeFakeTestCheckout(sessionId);
  return NextResponse.redirect(fakeTestCheckoutSuccessHref(session), 303);
}
