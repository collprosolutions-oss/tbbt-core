# TBBT — The Better Business Tool

TBBT is a multi-tenant Handyman operating system. **Handyman is the live trade.** Other trades are not implemented.

This is not a foundation-only placeholder. The application includes public websites, intake, CRM, estimates, jobs, field workflow, invoices, payments, expenses, payroll, reports, reviews, marketing, and owner intelligence (Business Health / BSOS Coach).

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- Prisma + **PostgreSQL**
- Local session cookies (no third-party auth credentials)

SQLite is not used.

## Hosts

- Local: [http://localhost:43217](http://localhost:43217)
- CollPro Handyman production: [https://www.collproreno.com](https://www.collproreno.com)
- TBBT marketing site: [https://www.tbbtool.com](https://www.tbbtool.com)

## Run locally

Local development uses PostgreSQL and **fake** payment / SaaS billing / customer-messaging adapters. Never set those fake adapters in production.

```bash
# Cloud Agent / first-time machine
./scripts/cloud-agent-setup.sh
npm run dev
```

Or manually:

```bash
cp .env.example .env
# Set DATABASE_URL to a reachable Postgres database.
# For local-only adapters add:
#   TBBT_PAYMENTS_ADAPTER=fake
#   TBBT_PAYMENTS_FAKE_READY=1
#   TBBT_SAAS_BILLING_ADAPTER=fake
#   TBBT_CUSTOMER_MESSAGING_ADAPTER=fake
npm ci
npx prisma migrate deploy
npm run dev
```

`scripts/cloud-agent-start.sh` reconciles a local Postgres daemon if you are in the Cloud Agent environment.

## Production configuration

Production secrets never belong in git. See `.env.example` for the real names:

- Hosted Postgres: `DATABASE_URL`
- SaaS Stripe (the trade business pays TBBT): `STRIPE_SAAS_PRICE_ID`, optional `STRIPE_SAAS_WEBHOOK_SECRET`
- Connect Stripe (customer job payments): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Resend: `RESEND_API_KEY`, `EMAIL_FROM`
- Twilio SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, plus a messaging service or from-number
- Cloudflare R2 (website photos): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

Do **not** set `TBBT_PAYMENTS_ADAPTER=fake` or `TBBT_SAAS_BILLING_ADAPTER=fake` on Vercel production.

## Workspace isolation

- Every business-owned record has `businessId`.
- A user can only see a workspace through `Membership`.
- Server code must query with `businessScope(workspace.business.id)` from `src/lib/access.ts`.
- Session cookie proves the user; workspace cookie selects a membership the user already has.
- OWNER / ADMIN use the management console. MEMBER is field-scoped.

```bash
npm run test:isolation
```

## Tests

Focused isolation / domain scripts (all require `DATABASE_URL`):

```bash
npm run test:isolation
npm run test:authorization
npm run test:bsos
npm run test:service-areas
npm run test:referrals
npm run test:financial-intelligence
npm run test:marketing
npm run test:reviews
npm run test:reports
npm run test:production-certification
npx tsc --noEmit
npm run build
```

Production migrate policy (no database):

```bash
npm run test:production-migrate
```

Certification checklist: `docs/PRODUCTION_CERTIFICATION.md`.
