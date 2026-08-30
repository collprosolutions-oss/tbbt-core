/**
 * Grant or revoke Founder Design Mode access for one existing TBBT User,
 * by email. This is the ONLY supported way to change User.isFounder --
 * there is deliberately no UI or API for it (see src/lib/founder-access.ts
 * for why: this is a platform-level developer flag, never a tenant-facing
 * setting).
 *
 * Usage:
 *   node --experimental-strip-types scripts/set-founder-access.mjs <email> true|false
 *
 * Example:
 *   node --experimental-strip-types scripts/set-founder-access.mjs founder@tbbt.dev true
 */
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { prisma } = await import("@/lib/prisma");

const [, , email, rawValue] = process.argv;

if (!email || (rawValue !== "true" && rawValue !== "false")) {
  console.error("Usage: node --experimental-strip-types scripts/set-founder-access.mjs <email> true|false");
  process.exit(1);
}

const isFounder = rawValue === "true";

const existing = await prisma.user.findUnique({ where: { email } });
if (!existing) {
  console.error(`No User found with email "${email}". Nothing changed.`);
  process.exit(1);
}

const updated = await prisma.user.update({
  where: { email },
  data: { isFounder },
});

console.log(
  `${updated.email} (id ${updated.id}) isFounder is now ${updated.isFounder}.` +
    (isFounder
      ? " They will see the 'Founder Design Mode' control on Dashboard/Requests/Customers/Estimates/Schedule-Jobs/Invoices next time they load those pages."
      : " Founder Design Mode is now hidden for this account; any design overrides they previously saved remain stored but unreadable/unappliable while isFounder is false."),
);

await prisma.$disconnect();
