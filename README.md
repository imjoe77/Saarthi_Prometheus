# PROMETHEUS — Digital Asset Command Center

Next.js frontend for the Prometheus platform: adaptive copy trading, a
zero-fee USDT exchange and EMBER tokenomics.

**Status: Modules 02–06 complete — Authentication & User, Wallet & Assets, Portfolio, then Strategy, then Risk — plus 06b, historical market data and paper simulation.**
The backend lives in [`backend/`](./backend) and has its own README.

> **Prototype boundary.** Prometheus is a college/final-year prototype. Nothing
> here is real banking, custody, USDT settlement, institutional liquidity or
> licensed exchange activity. Values are simulated and identifiable as such. No
> real money or production credentials are used.

---

## Requirements

- Node.js **20.9+**
- PostgreSQL 14+ (via the backend's Docker Compose)
- Google and/or GitHub OAuth apps, for signing in

---

## Getting started

```bash
# 1. backend - database, schema, API
cd backend
npm install
copy .env.example .env        # Windows; `cp` elsewhere
npm run prisma:generate
docker compose up -d
npm run prisma:seed        # reference assets: INR, USDT, EMBER
npm run market:seed        # 1,932 historical candles + three paper simulations

# 2. signing keys and OAuth credentials
cd ..
copy .env.example .env.local   # Windows; `cp` elsewhere
node scripts/generate-auth-keys.mjs --write --yes
```

Then fill the four OAuth values in `.env.local`:

| Variable | From |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | <https://console.cloud.google.com/apis/credentials> |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | <https://github.com/settings/developers> → OAuth Apps |

Register the callback URLs, which are **not** interchangeable:

| Provider | Authorised redirect URI |
| --- | --- |
| Google | `http://localhost:3000/api/auth/callback/google` |
| GitHub | `http://localhost:3000/api/auth/callback/github` |

Finally:

```bash
npm run dev
```

That starts both halves: the Next.js app on <http://localhost:3000> and the
NestJS API on <http://localhost:3001>, in one terminal with combined output. Use
`npm run dev:web` or `npm run dev:api` to run just one of them.

Open <http://localhost:3000>. The landing page is public; `/dashboard`,
`/portfolio`, `/wallet`, `/strategies`, `/copy-trading`, `/trading-buddy` and
`/usdt-exchange` require a session and redirect to sign-in.

Full provider-console walkthrough and the backend-side verification steps are in
[`backend/README.md`](./backend/README.md#manual-oauth-verification).

---

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Next.js on :3000 **and** the NestJS API on :3001 |
| `npm run dev:web` | Next.js only |
| `npm run dev:api` | NestJS only, from `backend/` |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Typecheck |

There is no frontend test suite yet; the type-safe claims this app makes are
enforced by `tsc` and the production build, and the authentication behaviour
itself is covered by the backend's suites.

---

## How authentication works

OAuth exists in exactly one place — [`lib/auth.ts`](./lib/auth.ts). Nothing else
in the app knows that Google or GitHub exist.

```
                    browser holds only cookies
┌──────────────────────────────────────────────────────────┐
│  Google / GitHub                                        │
│      │  redirect + code                                  │
│      ▼                                                   │
│  Next.js  Auth.js ────────► authjs.session-token (HttpOnly)│
│      │                        email + provider identity  │
│      │  POST /api/backend/*  (same origin)                │
│      ▼                                                   │
│  BFF  app/api/backend/[...path]/route.ts                 │
│      │  mints a 15-minute RS256 access token             │
│      │  prometheus_api_token (HttpOnly, Secure)          │
│      ▼                                                   │
│  NestJS  AuthGuard ──► AccessTokenVerifier ──► AuthService│
│                                                    │      │
│                                             auth_accounts│
└────────────────────────────────────────────────────┼─────┘
                                                     ▼
                                              Prometheus User.id
```

### Why a second token when Auth.js already has a session

| | Auth.js session | Access token |
| --- | --- | --- |
| Lifetime | 7 days | 15 minutes |
| Audience | this Next.js app | the NestJS API only |
| JavaScript-readable | no | no |
| Revocable | yes, by clearing the cookie | no |

The session is long-lived and broad. The access token is short-lived and scoped
to one audience. **The browser never holds a bearer token**, so an XSS bug has
nothing credential-shaped to steal — only cookies the server can invalidate.

### Why the backend is not reachable from the browser

The API's address is server-only configuration. Requests go through the BFF at
`/api/backend/*`, which is same-origin, so there is no cross-origin credential
problem and no `Authorization` header in client code. The BFF ignores any
`authorization` or `cookie` header the caller sends and always mints its own
token from the session — otherwise a caller could ask for another user's answer.

### Two session concepts, on purpose

- **`authjs.session-token`** — Auth.js, 7 days, proves the user to the frontend.
- **`prometheus_api_token`** — Prometheus, 15 minutes, proves the user to the API.

Neither is readable from JavaScript. `GET /api/auth/session` is therefore safe to
call from a client component: it returns only the email and provider the user
already supplied to an OAuth provider.

### Sign-out limitation

Signing out clears both cookies. It cannot revoke an access token that was copied
out beforehand — stateless JWTs have nothing to consult. The 15-minute TTL is the
bound. A denylist would need Redis, and Redis has no consumer that would justify
it yet.

### Where enforcement lives

| Layer | Enforces |
| --- | --- |
| [`proxy.ts`](./proxy.ts) | Which pages need a session (optimistic redirect) |
| [`lib/dal.ts`](./lib/dal.ts) | Session access inside server components |
| BFF route handler | That a token exists at all |
| NestJS `AuthGuard` | That the token is genuine — the real boundary |

`proxy.ts` and the DAL share one list from
[`lib/protected-paths.ts`](./lib/protected-paths.ts). When those two disagreed,
the symptom would be a page that renders but does not work, which is the hardest
kind of auth bug to notice.

---

## Wallet page

[`app/wallet/page.tsx`](./app/wallet/page.tsx) is the first page to render real
data instead of placeholders. It talks to the backend only through
[`lib/api-client.ts`](./lib/api-client.ts), which speaks to the BFF at
`/api/backend/*` — so it never holds a token and never knows the API's address.

| State | What the user sees |
| --- | --- |
| Loading | Spinner, no figures painted yet |
| No wallet | "No wallet yet" plus a **Create Wallet** button |
| Ready | Wallet card, balance per asset, ledger table |
| Error | The error envelope's message, with **Retry** |

`POST /api/wallets` is idempotent, so the create button is safe to press twice:
the second call returns the same wallet with `200` instead of creating another.
`GET /api/wallets/me` returning `404` is the normal "no wallet yet" answer, not
an error, so the client maps it to `null` rather than throwing.

**Money never becomes a JavaScript number.** The API sends decimals as strings,
they are rendered verbatim, and the one derived figure — `available + locked` per
asset — is added by [`lib/decimal.ts`](./lib/decimal.ts) with `BigInt` scaling
rather than `parseFloat`, which would round `0.1 + 0.2` to `0.30000000000000004`.

The ledger is keyset-paginated, so "Load more" sends the cursor the previous
page returned rather than an offset — an offset would skip or repeat rows when
new transactions land mid-scroll.

---

## Portfolio page

[`app/portfolio/page.tsx`](./app/portfolio/page.tsx) reads one endpoint,
`GET /api/backend/portfolio`, through the same
[`lib/api-client.ts`](./lib/api-client.ts) and the same BFF.

| State | What the user sees |
| --- | --- |
| Loading | Spinner, no figures painted yet |
| No wallet | "No wallet yet" plus a link to the wallet page |
| No balances | The holdings table replaced by "no balances recorded" |
| Ready | Four count cards, the holdings table, composition, ledger activity |
| Error | The error envelope's message, with **Retry** |

**It shows no invented figures.** The previous version of this page was a mock:
net worth, "unallocated USDT", copied-strategy capital, USD values, allocation
percentages, an APY, a Sharpe ratio and a 12 ms sync time. None of that is
derivable here. Prometheus stores no prices, so a monetary total across rupees,
dollars and tokens would be a number this component made up — and a Sharpe ratio
from a ledger of movements would be worse than a blank.

What replaced it:

- **`total` per holding**, as a string at the asset's own precision. The API
  derives it server-side; the browser renders it verbatim and never re-adds the
  two parts.
- **`lockedShare`** as a percentage, shown as `—` for a drained holding rather
  than as `NaN`.
- **Composition counted by category**, not by value. The bars show each
  category's share of the *number of assets*, and say so on the panel.
- **Ledger activity**: total movements, the last 30 days, a count per event type
  including the zeroes, and the span the ledger covers.

Amounts are strings end to end. The only arithmetic this page does is turning a
0–1 `lockedShare` into a percentage for display — no money is parsed, added or
divided in the browser.

---

## Strategies page

[`app/strategies/page.tsx`](./app/strategies/page.tsx) reads five endpoints
through the same [`lib/api-client.ts`](./lib/api-client.ts) and the same BFF, and
has two halves because the API does.

| Tab | Endpoints | What it does |
| --- | --- | --- |
| My Strategies | `strategies/me`, `POST`, `PATCH` | Create, rename, re-describe, publish or unpublish, archive |
| Discover | `strategies` | The public catalogue: other people's `PUBLIC`, `ACTIVE` strategies |

Each half handles loading, empty, ready and error explicitly, and each mutation
reports the API's own message on failure — a name collision comes back as a `409`
with a message that says why, not as a generic "something went wrong".

**It shows no invented figures.** No return, P&L, Sharpe, drawdown, risk level,
follower count or AUM, because this page reads none of them — even where the
backend now measures one (Module 06b simulates three seeded strategies and the
Risk Engine classifies their equity curves), nothing here calls
`/api/risk` or `/api/simulations`. A tile reading "+18.4%" would be
indistinguishable from a measured result once rendered, so those tiles are
absent rather than stubbed with dashes.

**Discovery reveals no owner.** The public response has no `ownerId`, no email and
no handle, so there is nothing here that *could* identify whose strategy it is —
the cards show a name, the owner's own words and a timestamp.

**Archiving is one-way and the UI says so.** `PATCH { "status": "ARCHIVED" }` is
the only status change the API accepts; there is no restore control to offer back,
because the backend will not accept one. An archived strategy renders as read-only
with the date it was retired.

`/strategies` is deliberately absent from the sidebar. It is reached from
**Discover Leaders** on the Copy Trading page — the one control there that now does
something — and by typing the URL. Adding a top-level nav item was not part of this
module.

---

## Environment variables

Everything lives in `.env.local`, which is gitignored. `.env.example` is the
committed template. Values are read and validated at first use
([`lib/auth-env.ts`](./lib/auth-env.ts)), not at import, so a build never fails on
a variable a given page does not need.

**Nothing here may be prefixed `NEXT_PUBLIC_`.** That prefix publishes the value
into the client bundle, which would hand the OAuth client secrets and the token
signing key to every visitor.

| Variable | Purpose |
| --- | --- |
| `AUTH_URL` | Public origin of this app |
| `AUTH_SECRET` | Encrypts the session cookie. Rotating it signs everyone out |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `AUTH_API_BASE_URL` | Where the BFF forwards authenticated requests |
| `AUTH_API_SIGNING_PRIVATE_KEY` | Signs access tokens. The backend holds only the public key |
| `AUTH_API_ISSUER` / `AUTH_API_AUDIENCE` / `AUTH_API_TOKEN_TTL_SECONDS` | Must match the backend exactly |

The private key exists **only** here. The backend holds
`AUTH_API_SIGNING_PUBLIC_KEY` and refuses to start if handed a private key or an
unparseable one.

---

## Project layout

```
prometheus/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/   # Auth.js route handlers
│   │   └── backend/[...path]/    # BFF: mints tokens, forwards to NestJS
│   ├── dashboard/ portfolio/ wallet/ …   # pages; some require a session
│   └── layout.tsx               # SessionProvider + font setup
├── components/
│   ├── AppShell.tsx             # chrome; sign-in/sign-out controls
│   └── AuthSessionProvider.tsx  # makes the session available to the client
├── lib/
│   ├── auth.ts                  # Auth.js: the only OAuth configuration
│   ├── auth-env.ts              # env validation, server-only
│   ├── api-token.ts             # mints the RS256 access token
│   ├── access-token-cookie.ts   # token cookie lifecycle
│   ├── dal.ts                   # server-side session access
│   ├── protected-paths.ts       # one list, two consumers
│   ├── auth-actions.ts          # sign-in / sign-out server actions
│   ├── api-client.ts            # typed client for /api/backend/* (Modules 03-05)
│   └── decimal.ts               # BigInt decimal string addition
├── proxy.ts                     # optimistic protected-page redirects
├── scripts/generate-auth-keys.mjs
└── backend/                     # NestJS API - see its own README
```

---

## Known limitations

1. **Sign-out is client-side.** See above.
2. **No rate limiting.** Belongs with the first module whose endpoints are worth
   throttling.
3. **No Redis client.** Nothing needs a cache yet; adding it now would be
   speculative.
4. **A wallet starts at zero.** `Create Wallet` provisions it; there is no
   deposit or withdrawal path in the browser because the backend exposes no
   INR deposit/withdrawal routes. The USDT exchange (`/usdt-exchange`) is the
   one page that moves real balances — buy/sell settle atomically against the
   wallet ledger at live market prices.
5. **No frontend test suite.** See *Scripts*.
6. **Most pages are still static mock content.** `/wallet`, `/portfolio` and
   `/strategies` are real end to end. `/dashboard`, `/ember` and the rest still
   render placeholders until the modules that produce their data arrive. The
   Copy Trading page in particular is still a mock — only its **Discover Leaders**
   button is live, and it leads to the real strategy catalogue.
7. **The portfolio cannot answer "what am I worth?".** Composition is counted
   by category and no cross-asset total is shown. The backend now holds
   historical candles (Module 06b), but they are a simulation input for three
   fixed symbols, not a price feed for whatever the wallet holds — using them
   for valuation would tie the portfolio's truth to the simulator's imports. A
   valuation module will need timestamped prices of its own rather than a value
   invented from balances.
8. **A user-created strategy is metadata only.** `/strategies` creates, names,
   describes, publishes and retires strategies; it does not run one or allocate
   money to one. The backend's Risk Engine (Module 06) now *reads* a strategy's
   equity history and classifies it, and Module 06b records real history for
   the three expert strategies seeded by `market:seed` — so those three do
   return risk figures at the API level. Nothing in this frontend calls
   `/api/risk` or `/api/simulations` yet, so no screen shows a risk figure, and
   a strategy a user creates answers `INSUFFICIENT_DATA` because nothing
   simulates it. The Copy Trading page's strategy cards remain mock data for
   the same reason: nothing user-facing backs those figures yet.
9. **The public catalogue is authenticated.** Discover requires a session, because
   the API does. It is not reachable by an anonymous visitor, and there is no
   cached public page that would leak it.
