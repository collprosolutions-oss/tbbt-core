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
2. First-run setup → starter services → website setup (`/setup`, `/setup/services`, `/setup/website`). Owners can continue into resumable Business Launch (`/launch`) and AI-assisted Build my company (`/launch/build`) without being dumped into forty blank settings. Settings → Go-live / Health (`/settings?section=go-live`) is a read-only production capability board. It does not connect providers or produce a single “100% ready” boolean.
3. Public website + request with photos (`/hire/[slug]`, `/r/[slug]`). After the first Website Publish, public pages read the immutable snapshot; businesses with no publish stay on the live-assembled path.
4. CRM / requests / pipeline (`/customers`, `/requests`, `/pipeline`).
5. Estimate → send / email → customer approve (`/estimates`, `/e/[token]`).
6. Materials & suppliers → purchase list / pickup (`/materials`, estimate or job purchase list). No live retailer integration.
7. Material deposit (Connect Stripe or fake local adapter).
8. Job → schedule → employee field workflow (`/jobs`, `/field/jobs/[jobId]`). Capacity, skill match, and Fill-In Bench recommendations stay owner-approved (`npm run test:workforce-capacity`). Assigned members see pickup only, not vendor economics.
9. Time cards → job photos → additional work / change order.
10. Complete → invoice → payment (`/invoices`, `/p/[token]/invoice`).
11. Expense → job profitability / reports / financial intelligence (`/expenses`, `/reports`). Linked material purchases must not double-count. Known cash flow uses recorded payments and recorded expenses. PROCESSED payroll gross labor is an operational cost record, not verified bank cash out. OWNER bank CSV review (`/reconciliation`) matches imported rows to recorded Payment / Expense rows for review only. It never creates a Payment, changes an invoice, or claims a verified bank balance. Banking and accounting stay Not Connected.
12. Review request → marketing opportunity → Growth loop → BSOS recommendation (`/reviews`, `/marketing`, `/growth`, `/business-health`). Launch progress, unreviewed knowledge, and candidate learnings feed Business Health facts — they do not replace the BSOS engine.
13. Communications department → customer timeline, compose, missed-call log (`/communications`). Voice answering is not connected. A verified inbound Twilio Voice webhook can record one missed-call log and owner callback item per CallSid. Growth never sends customer messages; Communications owns delivery.
14. Knowledge Hub (`/knowledge`) stores owner-approved operational knowledge, procedures/checklists, and Experience Intelligence candidates. Ask Knowledge distinguishes approved knowledge, historical evidence, inference, and unknown. No cross-tenant retrieval.
15. Business Protection / Vault / Agreement Coach (`/business-protection`). Stores private records and drafts. Does not verify licenses. Dropbox Sign is the connected e-sign adapter when configured; the fake adapter is local-only. Manual upload remains. TBBT does not invent a digital signature.

## Cross-cutting proofs

- Tenant A cannot read or write tenant B (`npm run test:isolation` plus focused checks).
- OWNER / ADMIN open the management console; MEMBER is field-scoped.
- Public tokens are `Estimate.publicToken` and `Job.projectToken` — not workspace IDs.
- SaaS Stripe (`STRIPE_SAAS_PRICE_ID`, `TBBT_SAAS_BILLING_ADAPTER`) is separate from Connect payments (`STRIPE_SECRET_KEY`, `TBBT_PAYMENTS_ADAPTER`).
- Provider failure must not delete core records (review / referral rows stay SENT).
- Password recovery: `/forgot-password`, `/reset-password/[token]`.
- R2 website uploads: `R2_*` in `.env.example`. Field job photos use private R2. Legacy historical job-photo rows may still store a Vercel Blob URL for read-only rendering. A localhost database dump/restore recreates `StoredAsset` metadata only — it does not recreate R2 bytes. See `docs/DATABASE_RESTORE.md` and `npm run test:handyman-database-restore`.
- Website publishing: Settings → Website Publish. `npm run test:website-engine` covers snapshot isolation, rollback, multi-trade publication, and SEO/sitemap. OWNER-visible custom-domain verification is read-only and display-only (`npm run test:website-domain-verification`); it checks DNS/host ownership against that business and its published site and shows Pending when the lookup fails or there is no published site. Public routing still uses stored `WebsiteHostBinding.status === VERIFIED` only. Settings shows the newest binding; go-live considers every binding. Display matching requires every CNAME and A to point at TBBT (Vercel CNAME family or apex A `76.76.21.21` / `76.76.21.22`). It does not edit DNS, publish, or live-check DNS on public requests.
- Resend: unset `RESEND_API_KEY` / `EMAIL_FROM` is NOT_CONFIGURED, not a fake send.

## Explicit blockers

- Instagram and Google publishing remain **disconnected**. Facebook Page publish is an explicit OWNER action only when that destination is connected; a DRAFT or planned day never publishes. Failed provider results are recorded and shown without the `PUBLISHED` label. MarketingContent.status is never advanced to `PUBLISHED`. Growth does not claim Instagram, Google rankings, or autonomous posting.
- Banking / accounting are **Not Connected**. TBBT will not invent a cash balance or tax conclusion.
- Supplier commerce adapters are **DISCONNECTED**. No Home Depot / Lowe’s scrape or live order API. Production provider integrations need API/licensing review.
- Marketing AI uses the canonical provider only after an OWNER requests a content draft and a key is configured. Unconfigured providers show Unavailable. Template creator-package drafts stay available. Generated items remain DRAFT. An env string does not mean a provider is called. This harness does not make a live AI call.
- This checklist does not replace a human production walkthrough on www.collproreno.com.
