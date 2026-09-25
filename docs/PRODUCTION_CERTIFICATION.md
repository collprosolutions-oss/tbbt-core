# TBBT Handyman production-certification checklist

This is an inventory of the **real** Handyman application. It is not a
placeholder product. Passing a check script is not the same as a human
walking the production site.

Do not invent passing browser results. The isolated harness is
`npm run test:production-certification`.

## Hosts

| Surface | Host |
| --- | --- |
| Local app | http://localhost:43217 |
| CollPro Handyman production | https://www.collproreno.com |
| TBBT marketing site | https://www.tbbtool.com |

## Lifecycle (owner / customer / field)

1. Signup → trial / SaaS entitlement (`/sign-up`, SaaS Stripe — not Connect).
2. First-run setup → starter services → website setup (`/setup`, `/setup/services`, `/setup/website`).
3. Public website + request with photos (`/hire/[slug]`, `/r/[slug]`). After the first Website Publish, public pages read the immutable snapshot; businesses with no publish stay on the live-assembled path.
4. CRM / requests / pipeline (`/customers`, `/requests`, `/pipeline`).
5. Estimate → send / email → customer approve (`/estimates`, `/e/[token]`).
6. Materials & suppliers → purchase list / pickup (`/materials`, estimate or job purchase list). No live retailer integration.
7. Material deposit (Connect Stripe or fake local adapter).
8. Job → schedule → employee field workflow (`/jobs`, `/field/jobs/[jobId]`). Capacity, skill match, and Fill-In Bench recommendations stay owner-approved (`npm run test:workforce-capacity`). Assigned members see pickup only, not vendor economics.
9. Time cards → job photos → additional work / change order.
10. Complete → invoice → payment (`/invoices`, `/p/[token]/invoice`).
11. Expense → job profitability / reports / financial intelligence (`/expenses`, `/reports`). Linked material purchases must not double-count. Known cash flow uses recorded payments and recorded expenses. PROCESSED payroll gross labor is an operational cost record, not verified bank cash out. Banking and accounting stay Not Connected.
12. Review request → marketing opportunity → Growth loop → BSOS recommendation (`/reviews`, `/marketing`, `/growth`, `/business-health`).
13. Communications department → customer timeline, compose, missed-call log (`/communications`). Voice is not connected. Growth never sends customer messages; Communications owns delivery.

## Cross-cutting proofs

- Tenant A cannot read or write tenant B (`npm run test:isolation` plus focused checks).
- OWNER / ADMIN open the management console; MEMBER is field-scoped.
- Public tokens are `Estimate.publicToken` and `Job.projectToken` — not workspace IDs.
- SaaS Stripe (`STRIPE_SAAS_PRICE_ID`, `TBBT_SAAS_BILLING_ADAPTER`) is separate from Connect payments (`STRIPE_SECRET_KEY`, `TBBT_PAYMENTS_ADAPTER`).
- Provider failure must not delete core records (review / referral rows stay SENT).
- Password recovery: `/forgot-password`, `/reset-password/[token]`.
- R2 website uploads: `R2_*` in `.env.example`. Field job photos use private R2. Legacy historical job-photo rows may still store a Vercel Blob URL for read-only rendering.
- Website publishing: Settings → Website Publish. `npm run test:website-engine` covers snapshot isolation, rollback, multi-trade publication, and SEO/sitemap. Custom-domain verification is not automatic.
- Resend: unset `RESEND_API_KEY` / `EMAIL_FROM` is NOT_CONFIGURED, not a fake send.

## Explicit blockers

- External Facebook / Instagram / Google publishing is **not connected**. Marketing never writes `PUBLISHED`. Growth does not claim social publishing or Google rankings.
- Banking / accounting are **Not Connected**. TBBT will not invent a cash balance or tax conclusion.
- Supplier commerce adapters are **DISCONNECTED**. No Home Depot / Lowe’s scrape or live order API. Production provider integrations need API/licensing review.
- Marketing AI is not connected. Template drafts are available. An env string does not mean a provider is called.
- This checklist does not replace a human production walkthrough on www.collproreno.com.
