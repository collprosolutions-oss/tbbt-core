import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import {
  BANK_IMPORT_NOT_AVAILABLE_MESSAGE,
  BankReconciliationError,
} from "@/lib/bank-reconciliation";
import { loadOwnedBankSourceFile } from "@/lib/bank-reconciliation-ops";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  const access = await requireBusinessAccess();
  try {
    requireBusinessCapability(access, CAPABILITIES.REVIEW_BANK_RECONCILIATION);
    const { importId } = await context.params;
    const file = await loadOwnedBankSourceFile(prisma, access, importId);
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof BankReconciliationError &&
      error.message === BANK_IMPORT_NOT_AVAILABLE_MESSAGE
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
