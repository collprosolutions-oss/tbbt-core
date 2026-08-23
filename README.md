# TBBT — The Better Business Tool

TBBT is a reusable business workspace for trade operators. **Handyman** is the first live trade. Other trades are not implemented.

This repository currently contains **Step 1 — Foundation only**:

- Application shell (desktop + mobile / PWA-style)
- Email/password accounts
- Business workspace + membership/role
- Foundational data models for later Handyman workflow
- Placeholder navigation for future screens

It does **not** include the Handyman website, estimates, scheduling, jobs, invoices, payments, or other trades.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- Prisma + SQLite (local, no hosted database required)
- Local session cookies (no third-party auth credentials)

SQLite keeps Step 1 runnable without accounts or secrets. The schema is workspace-scoped and can move to Postgres later.

## Run locally

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

Open [http://localhost:43217](http://localhost:43217) if you start the app with `npm run dev` (port 43217). Create an account to open a Handyman workspace.

## Workspace isolation

- Every business-owned record has `businessId`.
- A user can only see a workspace through `Membership`.
- Server code must query with `businessScope(workspace.business.id)` from `src/lib/access.ts`.
- Session cookie proves the user; workspace cookie selects a membership the user already has.

```bash
npm run test:isolation
```

## Step 1 status

Step 1 is complete when the foundation above runs. Do not add Handyman workflows until they are explicitly authorized.
