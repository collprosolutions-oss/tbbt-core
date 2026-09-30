/**
 * P1 regression-gate domain map.
 *
 * This file is the only place that decides which existing
 * `scripts/check-*.mjs` files belong to each P1 domain. The runner
 * executes `scripts` in order. `pending` names tests that coding PRs
 * must add later. Pending placeholders are data, not registrations:
 * the runner never executes them and must not treat a missing
 * placeholder as a failure.
 *
 * Filenames below were checked against origin/main
 * fc9b8955d52870bc353e98e2347f12a00c6e06b6. Every path in `scripts`
 * exists under scripts/. No renames were required.
 *
 * Proposed final order (static domain first, then the DB domains,
 * one domain at a time):
 *   1. migration-and-db-safety
 *   2. customer-boundaries
 *   3. transaction-races
 *   4. timekeeping
 *   5. native-active-membership
 */

/**
 * Listed scripts that do not open a database. Every other listed
 * script is treated as DB-backed, which forces the canonical
 * scripts/lib/local-database-guard.mjs preflight before any child starts.
 */
export const STATIC_SCRIPTS = new Set([
  "scripts/check-production-migrate.mjs",
]);

/**
 * Scripts that spawn `next start` and need a .next directory already
 * on disk. The runner never builds. If one of these is listed and
 * .next is missing, that script fails with "requires prior next build".
 * check-change-orders.mjs is not in a domain yet; it is listed so a
 * later registration gets the same fail-closed behavior.
 */
export const NEXT_BUILD_SCRIPTS = new Set([
  "scripts/check-work-order-portal.mjs",
  "scripts/check-client-portal-excellence.mjs",
  "scripts/check-change-orders.mjs",
]);

export const P1_DOMAINS = [
  {
    id: "migration-and-db-safety",
    summary:
      "Static migrate-owner checks first. DB migrate and drift proofs are still pending.",
    scripts: [
      // Static file read. package.json runs this with plain `node` (no strip-types). No database.
      "scripts/check-production-migrate.mjs",
    ],
    pending: [
      {
        placeholder: "scripts/check-p1-migrate-deploy-empty.mjs",
        requirement: "clean `prisma migrate deploy` from an empty database",
      },
      {
        placeholder: "scripts/check-p1-migrate-diff-drift.mjs",
        requirement: "`prisma migrate diff` drift check",
      },
      {
        placeholder: "scripts/check-p1-db-script-localhost-guard.mjs",
        requirement: "DB-script localhost-guard audit",
      },
    ],
  },
  {
    id: "customer-boundaries",
    summary: "Tenant isolation, authorization, and customer/portal boundaries.",
    scripts: [
      "scripts/check-isolation.mjs",
      "scripts/check-authorization.mjs",
      "scripts/check-customer-merge.mjs",
      "scripts/check-customer-csv-import.mjs",
      "scripts/check-work-order-portal.mjs",
      "scripts/check-client-portal-excellence.mjs",
      "scripts/check-customer-messaging.mjs",
    ],
    pending: [
      {
        placeholder: "scripts/check-p1-portal-token-scope-expiry.mjs",
        requirement: "portal token scope and expiry",
      },
      {
        placeholder: "scripts/check-p1-cross-customer-access.mjs",
        requirement: "cross-customer access tests",
      },
    ],
  },
  {
    id: "transaction-races",
    summary: "Existing race harnesses. New barrier tests are still pending.",
    scripts: [
      "scripts/check-customer-merge.mjs",
      "scripts/check-purchase-order-receipts.mjs",
      "scripts/check-estimate-options.mjs",
      "scripts/check-job-callback.mjs",
      "scripts/check-time-cards.mjs",
      "scripts/check-native-field-pickup.mjs",
    ],
    pending: [
      {
        placeholder: "scripts/check-p1-estimate-to-job-conversion.mjs",
        requirement:
          "estimate-to-job conversion race with a real barrier and separate PrismaClients",
      },
      {
        placeholder: "scripts/check-p1-payment-webhook-idempotency.mjs",
        requirement: "payment webhook idempotency",
      },
      {
        placeholder: "scripts/check-p1-invoice-payment-race.mjs",
        requirement:
          "invoice payment races with real barriers and separate PrismaClients",
      },
    ],
  },
  {
    id: "timekeeping",
    summary: "Current time-card, payroll, and native time-entry checks.",
    scripts: [
      "scripts/check-time-cards.mjs",
      "scripts/check-time-correction-requests.mjs",
      "scripts/check-payroll.mjs",
      "scripts/check-native-field-api.mjs",
      "scripts/check-native-field-visit.mjs",
      "scripts/check-native-field-activity.mjs",
    ],
    pending: [
      {
        placeholder: "scripts/check-p1-timekeeping-fixes.mjs",
        requirement:
          "fixes from the timekeeping PR (replace this placeholder with the files that PR adds)",
      },
    ],
  },
  {
    id: "native-active-membership",
    summary: "Native field writes plus team membership onboarding.",
    scripts: [
      "scripts/check-native-field-api.mjs",
      "scripts/check-native-field-checklist.mjs",
      "scripts/check-native-field-pickup.mjs",
      "scripts/check-team-onboarding.mjs",
    ],
    pending: [
      {
        placeholder: "scripts/check-p1-native-deactivate-after-token.mjs",
        requirement:
          "deactivate-after-token-issue tests across all native write routes",
      },
    ],
  },
];

export function domainById(id) {
  return P1_DOMAINS.find((domain) => domain.id === id) ?? null;
}

export function isDatabaseBacked(scriptPath) {
  return !STATIC_SCRIPTS.has(scriptPath);
}
