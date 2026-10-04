# Marketing Connections — Meta and Google application setup

This is the operator runbook for merged marketing destination consent
(#347). It does not add a second connect path, and it does not turn on
automatic posting.

Connecting a destination never publishes. Facebook Page, Instagram, and
Google Business Profile STANDARD local-post publish stay an explicit
OWNER click after an approved package. Instagram publishing needs Meta
App Review Advanced Access. Google local posts need Business Profile
API approval before real use.

Settings → Reviews / Marketing Connections is read-only status. The OWNER
starts consent from Marketing → Social posts
(`/marketing?area=social-posts`).

## Production host and Vercel project

| Item | Value |
| --- | --- |
| Signed-in app hosts | `https://www.collproreno.com` and `https://www.tbbtool.com` |
| Not a signed-in host | Apex `collproreno.com` and `tbbtool.com`. Session cookies are host-only, so consent must start and finish on the www host that signed the OWNER in. |
| Vercel project | `collpro-reno` (`prj_7xmTwilZyg0plUHRzHgvboCusHLp`) |
| Deployment Protection | SSO on `all_except_custom_domains`. Production custom domains are reachable. Preview `*.vercel.app` URLs return 401 to the provider. Do not register preview callbacks. |

An OWNER on `www.tbbtool.com` starts Meta or Google consent and returns
to destination selection on `www.tbbtool.com`. An OWNER on
`www.collproreno.com` stays on `www.collproreno.com`. The callback
trusts only that exact Host. It does not trust `x-forwarded-host`,
`x-vercel-deployment-url`, `request.url`, a preview URL, a userinfo
host, an explicit port, or a lookalike.

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

Those two env values stay exact: no trailing slash, no query string,
`https` only. They mark the credentials present. The authorize and
token-exchange `redirect_uri` is the signed-in host's callback, so the
provider consoles must also contain the `www.tbbtool.com` URLs below.

Do not set `TBBT_SOCIAL_OAUTH_ADAPTER` or
`TBBT_SOCIAL_PUBLISHING_ADAPTER` on Production. `VERCEL_ENV=production`
refuses the fake adapters.

Observed Production project (`collpro-reno`) at the time of this
runbook: encryption key present; the six Meta/Google names above are
absent. Until they are set, Marketing shows **Not available** and hides
Connect.

## Registered callback URLs

Register all four production callbacks. Do not register apex hosts,
preview URLs, or any other origin.

| Provider console field | Exact URL |
| --- | --- |
| Meta → Facebook Login → Valid OAuth Redirect URIs | `https://www.collproreno.com/api/marketing/connections/meta/callback` |
| Meta → Facebook Login → Valid OAuth Redirect URIs | `https://www.tbbtool.com/api/marketing/connections/meta/callback` |
| Google Cloud → OAuth client (Web application) → Authorized redirect URIs | `https://www.collproreno.com/api/marketing/connections/google/callback` |
| Google Cloud → OAuth client (Web application) → Authorized redirect URIs | `https://www.tbbtool.com/api/marketing/connections/google/callback` |

The same Meta callback path is used for Facebook Page and Instagram.
Google uses its own callback path. Each path is registered on both
signed-in hosts. Both routes consume a hashed single-use OWNER state
and never publish.

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

`instagram_content_publish` is required to **connect**. Connecting
still does not publish. Real Instagram publish use still needs Meta
App Review for this permission.

### Google Business Profile (`GOOGLE`)

Web-server flow (`access_type=offline`, `prompt=consent`) requests only:

- `https://www.googleapis.com/auth/business.manage`

After token exchange TBBT lists accounts and locations. Connecting
does not create a local post. A later OWNER STANDARD local-post
publish still needs Business Profile API approval and never claims
ranking improvements.

| API TBBT calls | Host |
| --- | --- |
| Account Management `accounts.list` | `https://mybusinessaccountmanagement.googleapis.com/v1/accounts` |
| Business Information locations (`readMask=name,title`) | `https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations` |
| Google My Business `localPosts.create` (STANDARD) | `https://mybusiness.googleapis.com/v4/{location}/localPosts` |

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
   - Valid OAuth Redirect URIs: both Meta callbacks above
   - Allowed domains / site URL: `https://www.collproreno.com` and `https://www.tbbtool.com`
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
   `www.collproreno.com` Meta callback. Also register the
   `www.tbbtool.com` Meta callback. The running app sends the callback
   for the host the OWNER is signed in on.

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
| `instagram_content_publish` | Required by TBBT before Instagram is stored as CONNECTED | Required at Instagram **connect**. Reviewers expect a recording of an OWNER Instagram publish click, not a post-on-connect. That review is separate from connect credentials |

Also required for Advanced Access:

- Meta **Business Verification**
- App mode **Live** for non-role users
- Honest use-case text: OWNER-initiated connect; no autonomous posting
- Screen recordings of TBBT sign-in → Marketing → Connect → provider
  consent → explicit destination confirm. Nothing is selected
  automatically.

Until Advanced Access is granted, a real (non-role) Facebook or
Instagram connection is blocked even if Vercel credentials are present.

Instagram App Review for `instagram_content_publish` and any later
OWNER Instagram publish are separate from connect credentials. Do not
enable automatic posting.

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
   - Google My Business API (v4 `localPosts.create` for STANDARD posts)
5. OAuth consent screen:
   - User type: External
   - App name / support email
   - Privacy: `https://www.tbbtool.com/privacy`
   - Scope: `https://www.googleapis.com/auth/business.manage` only
   - Keep Testing and listed test users until Google verification, if
     required for this scope, is finished
6. Credentials → OAuth client ID → **Web application**:
   - Authorized redirect URIs: both Google callbacks above
   - Client ID → `GOOGLE_OAUTH_CLIENT_ID`
   - Client secret → `GOOGLE_OAUTH_CLIENT_SECRET`
7. Set `GOOGLE_OAUTH_REDIRECT_URI` to the `www.collproreno.com` Google
   callback. Also register the `www.tbbtool.com` Google callback.

Credentials alone do not grant Business Profile API access.

## Google approvals (block a real connection)

| Approval | Blocks connect? | Why |
| --- | --- | --- |
| GBP Basic API Access (quota 300 QPM) | **Yes, everyone** | Token exchange can succeed; `accounts.list` / locations then fail with `PERMISSION_DENIED` / “Google Business Profile API access is not approved for this app.” |
| OAuth client + both exact redirect URIs | **Yes** | Code exchange uses the signed-in host callback (`www.collproreno.com` or `www.tbbtool.com`), which must match the authorize `redirect_uri` |
| Consent-screen Testing vs Production | **Yes for non-test users** | `business.manage` is not a basic scope. Unpublished / Testing apps only allow listed test users |
| Google OAuth verification (if Google requires it to publish the consent screen) | **Yes for non-test users** | Same as any External production OAuth app using this scope |
| Local posts / publishing approval | No | Connecting a location does not create a post. Live STANDARD local-post publish uses the same GBP API approval and an explicit OWNER click. |

## What currently blocks a real Production connection

Checked against Vercel Production names (values not read) and the
merged #347 behavior.

| Destination | Blocks a real connection today | Does not block connect |
| --- | --- | --- |
| Facebook Page | Missing `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`; then Meta Advanced Access for `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`; Business Verification; Live mode; matching redirect URI; App Review materials (privacy / data-deletion gap) | Automatic posting (off). Encryption key (already set) |
| Instagram | Same missing Meta Vercel names; then Advanced Access for `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` | Connecting never publishes. Instagram publish App Review is separate and required before real Instagram publish use |
| Google Business Profile | Missing `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`; then GBP API access approval (0 QPM); then consent-screen / OAuth verification for non-test users | Connecting never creates a local post. Live STANDARD local-post publish needs that same GBP API approval and an explicit OWNER click |

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
- A later OWNER Facebook, Instagram, or Google STANDARD local-post
  publish click is a separate action and still requires that
  destination’s own App Review or API approval.

## Operator sequence

1. Leave `CONNECTION_TOKEN_ENCRYPTION_KEY` as it is.
2. Create the Meta app and register the Meta callback.
3. Request Meta App Review / Business Verification for the Facebook
   and Instagram connect scopes. Instagram publish App Review is
   separate and required before real Instagram publish use.
4. Create the Google Cloud project, submit GBP Basic API Access, wait
   for 300 QPM, enable the three APIs, create the Web OAuth client,
   register the Google callback.
5. Set the six Vercel Production names. Redeploy.
6. As OWNER on `www.collproreno.com` or `www.tbbtool.com`, open Marketing
   → Social posts. Connect still does not publish. Finish destination
   selection on that same host.
7. Do not enable automatic posting.
