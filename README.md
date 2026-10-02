# TBBT — The Better Business Tool

TBBT is a multi-tenant Handyman operating system. **Handyman is the live trade.** Other trades are not implemented.

This is not a foundation-only placeholder. The application includes public websites, intake, CRM, estimates, materials and suppliers, jobs, field workflow, invoices, payments, expenses, payroll, reports, financial intelligence, reviews, marketing, Growth (lead-to-revenue), Communications, and owner intelligence (Business Health / BSOS Coach). Banking and accounting adapters stay disconnected.

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
# Unknown Stripe account ids stay not-ready. Do not set
# TBBT_PAYMENTS_FAKE_READY. A test may list specific ids in
# TBBT_FAKE_PAYMENT_READY_ACCOUNTS (ignored when VERCEL_ENV=production).
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
- SaaS Stripe (the trade business pays TBBT): `STRIPE_SAAS_PRICE_ID` (Founder), optional `STRIPE_SAAS_WEBHOOK_SECRET`. Optional later plan prices: `STRIPE_SAAS_PRICE_ID_STARTER`, `STRIPE_SAAS_PRICE_ID_BUSINESS`, `STRIPE_SAAS_PRICE_ID_ENTERPRISE`, or `STRIPE_SAAS_PLAN_PRICE_MAP`. Starter / Business / Enterprise are not purchasable until the catalog marks them LIVE and an approved price exists.
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
- Native field clients use a Bearer token on the same hashed `Session` row, not the website cookie and not a copied password.
- OWNER / ADMIN use the management console. MEMBER is field-scoped, including `/api/native/v1` Today/job reads, Start/Complete job, Cleaning visit outcomes, and Cleaning checklist progress.
- Settings → Go-live / Health is a read-only production capability board. It does not connect providers or produce a single ready score.

```bash
npm run test:isolation
```

## Tests

Focused isolation / domain scripts (all require `DATABASE_URL`):

```bash
npm run test:isolation
npm run test:authorization
npm run test:customer-csv-import
npm run test:bsos
npm run test:chief-of-staff
npm run test:business-coach
npm run test:controlled-actions
npm run test:controlled-ai-actions
npm run test:financial-specialist
npm run test:growth-specialist
npm run test:materials-specialist
npm run test:knowledge
npm run test:knowledge-launch
npm run test:service-areas
npm run test:referrals
npm run test:financial-intelligence
npm run test:marketing
npm run test:marketing-owner-content-draft
npm run test:marketing-social-publish
npm run test:reviews
npm run test:growth-department
npm run test:reports
npm run test:customer-merge
npm run test:production-certification
npm run test:plan-entitlements
npm run test:materials-suppliers
npm run test:supplier-quote-compare
npm run test:communications-department
npm run test:native-field
npm run test:native-field-photos
npm run test:native-field-visit
npm run test:native-field-checklist
npm run test:native-field-checklist-offline
npm run test:native-field-time-offline
npm run test:native-field-activity
npm run test:native-field-pickup
npm run test:native-field-problem
npm run test:native-field-recovery
npm run test:collections-worklist
npm run test:job-money-reconciliation
npm run test:handyman-bank-reconciliation
npm run test:bank-reconciliation
npm run test:handyman-database-restore
npx tsc --noEmit
npm run build
```

`test:handyman-database-restore` is a localhost-only dump/restore drill.
It never connects to Production. A restored database has tenant rows and
private-file **metadata**; it does not recreate R2 bytes. See
`docs/DATABASE_RESTORE.md`.

The isolated native field app lives in `apps/native`. It is not a WebView of the website. See `docs/NATIVE_FIELD.md`.

Production migrate policy (no database):

```bash
npm run test:production-migrate
```

```bash
npm run test:website-engine
npm run test:website-domain-verification
npm run test:public-website
npm run test:live-public-website
npm run test:workforce-capacity
npm run test:business-protection
npm run test:job-callback
npm run test:portal-job-callback
npm run test:job-customer-issue
```

Business Protection (`/business-protection`) is a private vault and agreement-organization workspace. It is not a separately advertised purchasable plan feature and not a licensing authority. Dropbox Sign is the one connected e-sign adapter (OWNER Send of a locked version, verified webhooks). Manual upload and external completion stay available. Production never uses the fake adapter, and TBBT never invents a digital signature.

## Website publishing

Public customer sites use:

**editable website state → validated immutable snapshot → atomic current pointer → public render**

- `WebsitePublish` stores a versioned public snapshot (`schemaVersion = 1`).
- `Business.publishedWebsiteId` is the current pointer. It can only reference a publish row for the same business.
- Before the first publish, `/hire/[slug]` and `/r/[slug]` still assemble from live Business / catalog / image / service-area rows. CollPro stays on this path until it publishes.
- After the first publish, owner drafts do not appear on the public site until the next Publish.
- Rollback copies a historical snapshot into a new version. Old rows stay immutable.
- `WebsiteHostBinding` is the custom-domain boundary. Public routing uses the stored `VERIFIED` status only. `UNVERIFIED`, unknown, and other-tenant hosts never route. OWNER Settings shows the newest binding; go-live considers every binding for that business. Display matching requires every CNAME (and every A, if present) to point at TBBT — a single good record cannot hide a hostile one. Pending when the lookup fails or there is no published site. Matching accepts the Vercel CNAME family (`cname.vercel-dns.com`, `*.vercel-dns.com`, `*.vercel-dns-NNN.com`) and apex A `76.76.21.21` / `76.76.21.22`. Typing a website URL does not mark a domain connected. This repo does not purchase domains or provision DNS.

Certification checklist: `docs/PRODUCTION_CERTIFICATION.md`.
