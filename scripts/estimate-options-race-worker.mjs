/**
 * Child-process race contender. Imports the real approveEstimate /
 * returnEstimateToDraft + sendEstimate so each contender has its own
 * PrismaClient singleton.
 *
 * Env:
 *   RACE_MODE=approve|return_resend
 *   RACE_PAYLOAD=<json>
 */
import { register } from "node:module";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

const { setTestAccess } = await import("./estimate-options-test-access.mjs");
const { approveEstimate } = await import("@/app/actions/public-estimate");
const { sendEstimate, returnEstimateToDraft } = await import("@/app/actions/estimate");
const { prisma } = await import("@/lib/prisma");

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) data.set(key, String(value));
  }
  return data;
}

function makeAccess(payload) {
  const business = {
    id: payload.businessId,
    name: payload.businessName,
    slug: payload.businessSlug,
  };
  return {
    businessId: business.id,
    workspace: {
      role: payload.role,
      membership: { id: payload.membershipId },
      business,
    },
    scope: { businessId: business.id },
    assertOwned(record) {
      if (!record || record.businessId !== business.id) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== business.id) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function writeResult(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const mode = process.env.RACE_MODE;
let payload;
try {
  payload = JSON.parse(process.env.RACE_PAYLOAD ?? "{}");
} catch {
  writeResult({ ok: false, error: "invalid RACE_PAYLOAD" });
  await prisma.$disconnect();
  process.exit(0);
}

setTestAccess(makeAccess(payload.access));

try {
  if (mode === "approve") {
    const result = await approveEstimate({}, form(payload.approve));
    writeResult({
      ok: !result.error && result.status === "APPROVED",
      status: result.status ?? null,
      error: result.error ?? null,
    });
  } else if (mode === "return_resend") {
    const returned = await returnEstimateToDraft({}, form({ estimateId: payload.estimateId }));
    if (returned.error) {
      writeResult({
        ok: false,
        returned: false,
        sent: false,
        error: returned.error,
      });
    } else {
      const sent = await sendEstimate({}, form({ estimateId: payload.estimateId }));
      writeResult({
        ok: !sent.error,
        returned: true,
        sent: !sent.error,
        error: sent.error ?? null,
      });
    }
  } else {
    writeResult({ ok: false, error: `unknown RACE_MODE ${mode}` });
  }
} catch (error) {
  writeResult({
    ok: false,
    error: String(error?.message ?? error),
  });
} finally {
  await prisma.$disconnect();
}
