import { NextResponse } from "next/server";
import {
  createCustomerInvoiceCheckout,
  isFakePaymentsAdapterEnabled,
  PaymentError,
} from "@/lib/payments";
import { prisma } from "@/lib/prisma";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  try {
    const session = await createCustomerInvoiceCheckout(prisma, token);
    if (isFakePaymentsAdapterEnabled()) {
      const next = new URL("/dev/fake-checkout", _request.url);
      next.searchParams.set("session_id", session.id);
      next.searchParams.set("token", token);
      return NextResponse.redirect(next, 303);
    }
    return NextResponse.redirect(session.url, 303);
  } catch (error) {
    if (error instanceof PaymentError) {
      return NextResponse.redirect(
        new URL(`/p/${token}?checkout=unavailable`, _request.url),
        303,
      );
    }
    return NextResponse.redirect(
      new URL(`/p/${token}?checkout=unavailable`, _request.url),
      303,
    );
  }
}
