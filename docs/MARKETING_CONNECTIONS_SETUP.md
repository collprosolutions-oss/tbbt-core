# Marketing Connections — Meta and Google application setup

This is the operator runbook for merged marketing destination consent
(#347). It does not add a second connect path, and it does not turn on
automatic posting.

Connecting a destination never publishes. Facebook Page publish stays an
explicit OWNER click after an approved package. Instagram and Google
Business Profile publishing are not yet available.

Settings → Reviews / Marketing Connections is read-only status. The OWNER
starts consent from Marketing → Social posts
(`/marketing?area=social-posts`).

## Production host and Vercel project

| Item | Value |
| --- | --- |
| App host | `https://www.collproreno.com` |
| Do not use | `https://www.tbbtool.com` (corporate marketing site) |
| Vercel project | `collpro-reno` (`prj_7xmTwilZyg0plUHRzHgvboCusHLp`) |
| Deployment Protection | SSO on `all_except_custom_domains`. Production custom domains are reachable. Preview `*.vercel.app` URLs return 401 to the provider. Do not register preview callbacks. |

The Next.js auth proxy already allows these two paths without a session
cookie. Do not enable Vercel Authentication on Production.

## Production Vercel variable names

`CONNECTION_TOKEN_ENCRYPTION_KEY` is already set on Production. Do not rotate it.
Rotation would invalidate stored Gusto and marketing tokens.

Set these six names on Production after the provider consoles match the
URLs below. Values never belong in git.

| Vercel name | Value |
| --- | --- |
| `META_APP_ID` | Meta App ID |
| `META_APP_SECRET` | Meta App Secret |
| `META_OAUTH_REDIRECT_URI` | `https://www.collproreno.com/api/marketing/connections/meta/callback` |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth 2.0 Web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth 2.0 Web client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://www.collproreno.com/api/marketing/connections/google/callback` |

Exact match is required. No trailing slash, no query string, `https` only.

Do not set `TBBT_SOCIAL_OAUTH_ADAPTER` or
`TBBT_SOCIAL_PUBLISHING_ADAPTER` on Production. `VERCEL_ENV=production`
refuses the fake adapters.

Observed Production project (`collpro-reno`) at the time of this
runbook: encryption key present; the six Meta/Google names above are
absent. Until they are set, Marketing shows **Not available** and hides
Connect.

## Registered callback URLs

Register only these production callbacks.

| Provider console field | Exact URL |
| --- | --- |
| Meta → Facebook Login → Valid OAuth Redirect URIs | `https://www.collproreno.com/api/marketing/connections/meta/callback` |
| Google Cloud → OAuth client (Web application) → Authorized redirect URIs | `https://www.collproreno.com/api/marketing/connections/google/callback` |

The same Meta callback is used for Facebook Page and Instagram. Google
uses its own callback. Both routes consume a hashed single-use OWNER
state and never publish.

## Approved permissions TBBT actually requests

TBBT checks granted scopes at connect time. A missing required scope
stores **Needs more permission** and does not keep a destination token.
Do not add extra permissions.

### Facebook Page (`FACEBOOK`)

Comma-separated `scope` on `https://www.facebook.com/v26.0/dialog/oauth`:

- `pages_show_list`
- `pages_manage_posts`
- `pages_read_engagement`

`pages_manage_posts` is required to **connect**, not only to publish
later. Connecting still does not post.

### Instagram professional account (`INSTAGRAM`)

Same Meta app and same redirect URI. Different Connect button. Scopes:

- `instagram_basic`
- `instagram_content_publish`
- `pages_show_list`
- `pages_read_engagement`

Use these exact Graph permission strings (Instagram API with Facebook
Login). Do not substitute `instagram_business_*` names.

`instagram_content_publish` is required to **connect**. TBBT still has
no Instagram publish path.

### Google Business Profile (`GOOGLE`)

Web-server flow (`access_type=offline`, `prompt=consent`) requests only:

- `https://www.googleapis.com/auth/business.manage`

After token exchange TBBT lists accounts and locations. It does not
create a local post.

| API TBBT calls | Host |
| --- | --- |
| Account Management `accounts.list` | `https://mybusinessaccountmanagement.googleapis.com/v1/accounts` |
| Business Information locations (`readMask=name,title`) | `https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations` |

## Meta application setup

1. [developers.facebook.com](https://developers.facebook.com/) → create
   or open a **Business** type app owned by the CollPro / TBBT Business
   Manager.
2. Add the **Facebook Login** product (Facebook Login for Business is
   acceptable). Use the manual code flow. TBBT does not use the JS SDK.
3. Facebook Login settings:
   - Client OAuth login: on
   - Web OAuth login: on
   - Strict Mode: on
   - Valid OAuth Redirect URIs: the Meta callback above
   - Allowed domains / site URL: `https://www.collproreno.com`
4. App Dashboard → Settings → Basic:
   - App ID → `META_APP_ID`
   - App Secret → `META_APP_SECRET`
   - Privacy Policy URL: `https://www.tbbtool.com/privacy`
   - Terms URL: `https://www.tbbtool.com/terms`
   - User data deletion: Meta requires a callback or instructions URL.
     TBBT has no data-deletion callback route. The current privacy page
     also does not describe Facebook Login tokens or a deletion request
     path. That is an App Review gap, not a Connect-button gap.
5. Add App Roles (Admin / Developer / Tester) for any Development-mode
   login. Standard Access only works for people with an app role.
6. Copy `META_OAUTH_REDIRECT_URI` from the table. It must equal the
   Valid OAuth Redirect URI.

Graph API version used by TBBT: **v26.0**.

## Meta App Review (blocks real customer connections)

Development mode + Standard Access can connect a tester-owned Page or
linked Instagram professional account after the Vercel Meta names are
set. A customer who is not an app role cannot grant these permissions
until each one has **Advanced Access**.

| Permission | Why TBBT requests it | App Review note |
| --- | --- | --- |
| `pages_show_list` | List Pages the OWNER manages | Required for Facebook and Instagram connect |
| `pages_read_engagement` | Page fields and linked Instagram account | Required for Facebook and Instagram connect |
| `pages_manage_posts` | Later explicit OWNER Facebook Page publish | Required at Facebook **connect**. Reviewers expect a recording of an OWNER publish click, not a post-on-connect |
| `instagram_basic` | Instagram id / username on the linked Page | Required for Instagram connect |
| `instagram_content_publish` | Required by TBBT before Instagram is stored as CONNECTED | Reviewers expect a recording of publishing to Instagram. TBBT cannot show that: Instagram publishing is not yet available |

Also required for Advanced Access:

- Meta **Business Verification**
- App mode **Live** for non-role users
- Honest use-case text: OWNER-initiated connect; no autonomous posting
- Screen recordings of TBBT sign-in → Marketing → Connect → provider
  consent → explicit destination confirm. Nothing is selected
  automatically.

Until Advanced Access is granted, a real (non-role) Facebook or
Instagram connection is blocked even if Vercel credentials are present.

Instagram App Review for `instagram_content_publish` is blocked today
because TBBT has no Instagram publish implementation. Do not invent one
here and do not enable automatic posting.

## Google application setup

1. Google Cloud Console → create or open the project that will own the
   Business Profile APIs.
2. Request **Application for Basic API Access** with the
   [GBP API contact form](https://developers.google.com/my-business/content/prereqs).
   The applicant Google Account must be owner/manager of a verified
   Business Profile that has been active 60+ days, and that profile
   must list a website.
3. Approval check: Business Profile API quota.
   - `0` QPM = not approved. Live list calls fail.
   - `300` QPM = approved.
4. After approval, enable only the APIs TBBT calls:
   - My Business Account Management API
   - My Business Business Information API
5. OAuth consent screen:
   - User type: External
   - App name / support email
   - Privacy: `https://www.tbbtool.com/privacy`
   - Scope: `https://www.googleapis.com/auth/business.manage` only
   - Keep Testing and listed test users until Google verification, if
     required for this scope, is finished
6. Credentials → OAuth client ID → **Web application**:
   - Authorized redirect URI: the Google callback above
   - Client ID → `GOOGLE_OAUTH_CLIENT_ID`
   - Client secret → `GOOGLE_OAUTH_CLIENT_SECRET`
7. Set `GOOGLE_OAUTH_REDIRECT_URI` to that same URI.

Credentials alone do not grant Business Profile API access.

## Google approvals (block a real connection)

| Approval | Blocks connect? | Why |
| --- | --- | --- |
| GBP Basic API Access (quota 300 QPM) | **Yes, everyone** | Token exchange can succeed; `accounts.list` / locations then fail with `PERMISSION_DENIED` / “Google Business Profile API access is not approved for this app.” |
| OAuth client + exact redirect URI | **Yes** | Code exchange uses `GOOGLE_OAUTH_REDIRECT_URI` |
| Consent-screen Testing vs Production | **Yes for non-test users** | `business.manage` is not a basic scope. Unpublished / Testing apps only allow listed test users |
| Google OAuth verification (if Google requires it to publish the consent screen) | **Yes for non-test users** | Same as any External production OAuth app using this scope |
| Local posts / publishing approval | No | TBBT does not create Google posts |

## What currently blocks a real Production connection

Checked against Vercel Production names (values not read) and the
merged #347 behavior.

| Destination | Blocks a real connection today | Does not block connect |
| --- | --- | --- |
| Facebook Page | Missing `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`; then Meta Advanced Access for `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`; Business Verification; Live mode; matching redirect URI; App Review materials (privacy / data-deletion gap) | Automatic posting (off). Encryption key (already set) |
| Instagram | Same missing Meta Vercel names; then Advanced Access for `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`; App Review for `instagram_content_publish` cannot be completed while Instagram publishing is not yet available | Connecting still would not publish if those approvals later land |
| Google Business Profile | Missing `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`; then GBP API access approval (0 QPM); then consent-screen / OAuth verification for non-test users | Google local-post publishing (not implemented, not required to connect) |

Tester-only Development-mode Facebook/Instagram connects become possible
after the three Meta Vercel names are set and the OWNER is an app role.
Google still needs GBP API project approval for testers.

## OWNER, isolation, and no publish-on-connect

These are already implemented. This runbook must not change them.

- Capability `CONNECT_MARKETING_DESTINATIONS` is OWNER-only. ADMIN keeps
  `MANAGE_MARKETING` for drafts and review.
- Connect, reconnect, status check, disconnect, and destination confirm
  all require OWNER. Settings does not start consent.
- Tokens are encrypted with `CONNECTION_TOKEN_ENCRYPTION_KEY` under a
  per-destination purpose and `businessId`. Tenant A cannot use tenant
  B’s state or ciphertext.
- Confirm writes `CONNECTED` and the message
  `{destination} connected. Nothing was published.`
- Instagram and Google `publishAvailable` stay false.

## Operator sequence

1. Leave `CONNECTION_TOKEN_ENCRYPTION_KEY` as it is.
2. Create the Meta app and register the Meta callback.
3. Request Meta App Review / Business Verification for the Facebook
   scopes. Treat Instagram Advanced Access as blocked until an explicit
   OWNER Instagram publish exists.
4. Create the Google Cloud project, submit GBP Basic API Access, wait
   for 300 QPM, enable the two APIs, create the Web OAuth client,
   register the Google callback.
5. Set the six Vercel Production names. Redeploy.
6. As OWNER on `www.collproreno.com`, open Marketing → Social posts.
   Connect still does not publish.
7. Do not enable automatic posting.
