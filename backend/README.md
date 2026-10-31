# Prometheus Backend

NestJS modular monolith for the Prometheus digital-asset platform.

**Status: Modules 00–11 complete (Foundation, Database, Authentication & User, Wallet & Assets, Portfolio, Strategy, Risk, Market Data & Simulation, Expert Paper Trading, Copy Trading, USDT Exchange, Liquidity & Order Processing, EMBER Token Accounting, EMBER Tokenomics). Module 12 (Treasury Guardrails & Dashboard) implemented and verified — owner-approved reserve floor (30% of qualifying treasury funding) enforced atomically inside Module 11's burn transaction, with demo ₹30 crore USDT capacity tracking (reporting-only); awaiting owner review. Module 13 (RBAC & Profiles) complete and verified — four server-side roles behind a global guard, a four-card login funnel (Normal User, Expert Trader, Liquidity Provider and an env-only Platform Admin) where each card scopes the session to that surface alone, a **one-privileged-role-per-Gmail** rule refused with "try a different account", self-service role requests with an admin decision queue, admin audit trail, and per-user profiles with onboarding and financial preferences.**

> **Prototype boundary.** Prometheus is a college/final-year prototype. Nothing
> here is real banking, custody, USDT settlement, institutional liquidity, CEX
> execution or a licensed exchange. Values are simulated and clearly
> identifiable as such. No real money or production credentials are used.

---

## Module status

| Module | Name | Status |
| --- | --- | --- |
| **00** | **Project Foundation** | **Complete** |
| **01** | **Database Foundation** | **Complete** |
| **02** | **Authentication & User** | **Complete** |
| **03** | **Wallet & Assets** | **Complete** |
| **03b** | **Wallet Top-ups (payments)** | **Complete** |
| **04** | **Portfolio** | **Complete** |
| **05** | **Strategy** | **Complete** |
| **06** | **Risk** | **Complete** |
| **06b** | **Historical Market Data & Simulation** | **Complete** |
| **06c** | **Live Market Data & Expert Paper Trading** | **Complete** |
| **07** | **Copy Trading** | **Complete** |
| **08** | **USDT Exchange** | **Complete** |
| **09** | **Liquidity & Order Processing** | **Complete** |
| **10** | **EMBER Token Accounting** | **Complete** |
| **11** | **EMBER Tokenomics** | **Complete** |
| **12** | **Treasury Guardrails & Dashboard** | **Implemented - awaiting owner review** |
| **13** | **Cross-cutting RBAC & Profiles** | **Complete** |
| 14-17 | Blockchain, AI, Dashboard, Notifications, E2E | Not started (the AI trade-buddy endpoint exists — delivered for the design integration, see *Design-integration API additions*) |

Module 02 delivers authentication and identity resolution only. Deliberately
**not** implemented, per the module's own "Do not implement" list: wallet
operations, portfolio, copy trading, USDT exchange, liquidity, EMBER,
tokenomics, treasury, blockchain, AI and notifications. Wallet provisioning is
deliberately absent from first login — see [Authentication](#authentication-module-02).

Module 03 delivers the accounting core: a `WalletService` that is the only code
allowed to move a balance, asset reference data, and read APIs for balances and
transaction history. It deliberately does **not** implement portfolio valuation,
strategies, copy trading, USDT pricing, order matching, liquidity, EMBER
tokenomics, blockchain, AI or payments — see [Wallet & Assets](#wallet--assets-module-03).

Module 04 delivers the portfolio read model: one endpoint that assembles
holdings, composition and activity from the wallet, and stores none of it. It
adds no table, no price source and no mutation — see
[Portfolio](#portfolio-module-04).

Module 05 delivers the strategy registry: a `strategies` table, five authenticated
endpoints, and nothing else. It stores a name, an owner's own description, a
visibility and a lifecycle state. It measures no return, holds no position, and
depends on nothing else in the codebase — see
[Strategy](#strategy-module-05).

Module 06 delivers the risk reading: one endpoint that derives maximum
drawdown and volatility from a strategy's daily equity history and classifies
it, storing none of it and writing nothing anywhere — see
[Risk](#risk-module-06).

Module 06b delivers the historical market data and the deterministic
simulation behind that reading: an offline importer over `data/market/raw`,
four new tables (`market_candles`, `strategy_simulations`, `strategy_fills`,
`strategy_daily_balance`), a signal-at-close / fill-at-next-open engine with
three shipped rules, three read-only API surfaces, an idempotent
`market:seed`, and the one approved Module 06 edit — the equity port now bound
to the persisted daily-balance series. It places no order, moves no real money
and exposes no write route — see
[Market Data & Simulation](#market-data--simulation-module-06b).

Module 06c delivers the in-memory live quote feed (behind a provider port, with
a deterministic fake provider for development and tests) and the expert paper
trading ledger: `paper_accounts`, `paper_orders`, `paper_positions`, an
immediate FILLED/REJECTED order flow with a closed reject-reason vocabulary,
and 100,000 USD of paper cash per expert strategy. It never touches the wallet
or any Module 03 balance.

Module 07 delivers the copy trading engine: `strategy_follows`,
`copy_accounts`, `copy_positions`, `copy_events`, follower-side allocation
sizing, a background worker that consumes each expert fill exactly once per
follower through a port, and simulated USD copy pots kept strictly separate
from every other ledger. It moves no wallet money.

Module 08 delivers the USDT exchange: quotes priced from live order-book
data (CoinDCX execution VWAP, driven a clear ₹1.50 better than the venue
offers by the best-price guarantee,
CoinGecko reference venues, zero explicit
brokerage), a signed savings metric, a labelled display-only fallback, and
buy/sell endpoints that refuse to execute without fresh market data while
moving real wallet balances in one atomic transaction — see
[USDT Exchange](#usdt-exchange-module-08).

Module 09 delivers simulated liquidity providers (LPs) for the USDT exchange:
an EMBER-locked commitment ledger (`liquidity_providers`,
`liquidity_commitments`, `liquidity_allocations`,
`liquidity_commitment_reductions`, `liquidity_top_up_requests`), oldest-first
allocation of every customer BUY across eligible commitments inside the order's
own transaction, and shortfall detection. BUY orders funded by LPs carry a
`liquidity` response block; a system with zero providers keeps Module 08's
legacy behaviour, and once any provider exists an order the pool cannot cover
is refused whole (`409 INSUFFICIENT_LIQUIDITY`) — there are no partial fills.
Production EMBER slab thresholds were approved 2026-10-18 and ship as the
documented `LIQUIDITY_EMBER_SLABS` default — see
[Liquidity & Order Processing](#liquidity--order-processing-module-09).

Module 10 delivers EMBER token accounting: user-to-user EMBER transfers named
by the recipient's registered email in one atomic transaction with
`(sender, clientRequestId)` idempotency, and a read-only supply endpoint whose
figures are aggregated from the existing ledger and balance tables — issued
from deposits minus withdrawals, burned summing the `BURN` legs Module 11
writes (zero until the first burn), locked summing every
wallet's locked column including Module 09's LP commitment locks. Locked EMBER
is unspendable because a transfer can only be funded from the available
column. It deliberately implements no staking, rewards, minting, burning and
no public lock/unlock route — see
[EMBER Token Accounting](#ember-token-accounting-module-10).

Module 11 delivers EMBER tokenomics: a configurable direct-burn / simulated
buyback split (default 60/40, boot-time validated), a compute-only preview, and
three idempotent record types — allocations (the split of an illustrative
reference amount), simulated buybacks (proposal → recorded simulated execution;
no market order ever exists) and burns (the only destructive step: one `BURN`
ledger leg plus one `token_burns` row in a single transaction, debiting a
lazily auto-provisioned treasury). Supply reads stay in Module 10 and
reconcile against both the ledger sum and the records table — see
[EMBER Tokenomics](#ember-tokenomics-module-11).

Module 13 delivers cross-cutting authorization and identity: a four-role model
(`USER`, `EXPERT_TRADER`, `LIQUIDITY_PROVIDER`, `PLATFORM_ADMIN`) enforced by a
global guard in front of every authenticated route, self-service role requests
with an admin decision queue, admin user/role management recorded in an
append-only audit log, and each user's own profile and financial-preference
questionnaire with a one-time onboarding flow. It grants no trading capability
of its own — it decides who may call what — see
[RBAC & Profiles](#rbac--profiles-module-13).

---

## Data model (Module 01)

```
                       1:1                1:N
   User ──────────────────────► Wallet ─────────────┐
     │                             │                 │
     │ 1:N                         │ 1:N             │ 1:N
     │                             ▼                 ▼
     │               WalletBalance              Transaction
     │                             │                 │
     │                             │  N:1           │  N:1
     │                             └────────► Asset ┘
     │
     │ 1:N   (Module 02)
     ▼
AuthAccount ──► provider + provider_account_id

   │
   │ 1:N   (Module 05)
   ▼
Strategy ──► name, description, visibility, status
```

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `users` | Application identity | unique `email`, unique nullable `auth_user_id` |
| `auth_accounts` | Links one OAuth identity to one user | unique `(provider, provider_account_id)`, unique `(user_id, provider)`, provider check |
| `strategies` | A named strategy owned by one user | unique `(owner_id, lower(btrim(name)))`, `ON DELETE RESTRICT` |
| `wallets` | Container for a user's funds | unique `user_id` (enforces 1:1) |
| `assets` | Reference data: INR, USDT, EMBER | unique `symbol` |
| `wallet_balances` | Current `available` / `locked` per asset | unique `(wallet_id, asset_id)` |
| `transactions` | Immutable movement history | indexed `(wallet_id, created_at)`, `(asset_id, created_at)` |

These are Module 01's seven tables. Module 06b added four more —
`market_candles`, `strategy_simulations`, `strategy_fills`,
`strategy_daily_balance` — documented in
[Market Data & Simulation](#market-data--simulation-module-06b), because they
serve a different question: what historical prices were, and what a paper
simulation did with them. Modules 06c, 07 and 08 added their own tables
(`paper_*`, `copy_*`, `usdt_orders`); each block is named, constrained and
justified in its own comment in `prisma/schema.prisma`, and `usdt_orders` is
documented in [USDT Exchange](#usdt-exchange-module-08) below. Module 09 added
five more (`liquidity_providers`, `liquidity_commitments`,
`liquidity_allocations`, `liquidity_commitment_reductions`,
`liquidity_top_up_requests`), documented in
[Liquidity & Order Processing](#liquidity--order-processing-module-09).
Module 10 added one (`ember_transfers`), documented in
[EMBER Token Accounting](#ember-token-accounting-module-10).


**Money is `NUMERIC(38,18)` everywhere**, surfaced as `Prisma.Decimal`. Never a
JavaScript float: binary floating point cannot represent decimal currency
exactly, so `0.1 + 0.2 !== 0.3` and balances would drift silently. The test
suite asserts the column types directly so this cannot regress.

**No total balance column.** `total = available + locked` is derived by the
modules that need it. Storing it would create two sources of truth that can
disagree, and repairing that disagreement belongs in an atomic update rather
than in a column.

### Constraints beyond Prisma's schema language

Prisma has no `CHECK` constraint syntax, so these live as hand-written SQL in
`prisma/migrations/`:

| Constraint | Rule |
| --- | --- |
| `wallet_balances_available_non_negative` | `available >= 0` |
| `wallet_balances_locked_non_negative` | `locked >= 0` |
| `transactions_amount_positive` | `amount > 0` |
| `transactions_available_after_non_negative` | snapshot `>= 0` or NULL |
| `transactions_locked_after_non_negative` | snapshot `>= 0` or NULL |
| `transactions_adjustment_requires_note` | `ADJUSTMENT` needs a non-blank `note` |
| `assets_symbol_not_blank` | `symbol` is not whitespace |
| `strategies_name_not_blank` | `name` is not whitespace |
| `strategies_name_length` | `char_length(name) <= 80` |
| `strategies_description_length` | `char_length(description) <= 1000` or NULL |

The same three rules are expressed a second time by class-validator in
`CreateStrategyDto`. That is duplication with a purpose: the DTO produces a
`400` that names the offending field, while the `CHECK` makes the rule true of
the table for every writer — including a future one, a raw script or `prisma
studio` — rather than true only of callers who happened to go through HTTP.

**Name uniqueness is not one of these, and cannot be.** Prisma's schema language
has no expression index, so "unique per owner, ignoring case and surrounding
spaces" is written by hand:

```sql
CREATE UNIQUE INDEX strategies_owner_id_lower_name_key
  ON strategies (owner_id, lower(btrim(name)));
```

It is intentionally **not** declared as `@@unique([ownerId, name])` in
`schema.prisma`. A case-sensitive unique constraint alongside it would reject
"Alpha" and "alpha" at the wrong layer and with the wrong error, and would make
`prisma migrate` want to drop an index that the schema cannot describe.
`test/schema.e2e-spec.ts` asserts the functional index directly — including that
it is `UNIQUE` and that both filter columns lead the other two indexes.

`amount` is a positive magnitude and direction comes from `type`. Allowing a
negative amount would make both `DEPOSIT -100` and `WITHDRAWAL -100`
representable, which is the sign ambiguity the design removes.

What is deliberately *not* a constraint: "`locked` is drawn from `available`".
That is a cross-column rule needing a trigger, and a trigger would move
accounting logic out of the application layer where it belongs. Module 03
enforces it atomically when it writes balances.

### Delete behaviour

`ON DELETE RESTRICT` on `wallets.user_id`, `transactions.*`,
`wallet_balances.asset_id` and `strategies.owner_id`: a user with a wallet, an
asset in use, or a strategy cannot be deleted, so financial history is never
silently destroyed and a strategy that others may act on cannot vanish with its
owner's account. `wallet_balances.wallet_id` cascades, because a balance row is
derived current state rather than audit history.

There is no HTTP route that deletes a strategy at all. Archiving is the only way
out, and it is one-way.

### Working with the schema

```bash
npx prisma validate             # schema syntax and relations
npx prisma migrate dev          # apply migrations + generate client
npx prisma migrate status       # confirm the database matches
npx prisma migrate reset        # drop everything and reapply from scratch
npx prisma studio               # browse data
```

Never `prisma db push` — it bypasses migration history.

---

## Authentication (Module 02)

The backend never sees an OAuth provider. Google and GitHub exist only in the
Next.js app; what arrives here is a short-lived RS256 access token.

```
Google / GitHub ──▶ Next.js (Auth.js) ──▶ RS256 access token ──▶ NestJS
                     session cookie                           AuthGuard
                                                                │
                                                    AccessTokenVerifier
                                                                │
                                                    auth_accounts lookup
                                                                │
                                                    AuthService ──▶ Prometheus User
```

### Why the token exists at all

Auth.js already proved who the user is, and its session cookie is already
encrypted. A second credential could look redundant. It is not:

| | Auth.js session | Access token |
| --- | --- | --- |
| Lifetime | 7 days | 15 minutes |
| Readable by JavaScript | No | No |
| Audience | the Next.js app | this API only |
| Revocable | yes, by clearing the cookie | no |

The session is long-lived and broad; the access token is short-lived and scoped to
one audience. A stolen session cookie is bounded by the 15-minute token anyway,
and the two never leave their halves: the browser holds only cookies, so an XSS
bug has no bearer token to exfiltrate.

### Access token contract

| Claim | Value | Why it is checked |
| --- | --- | --- |
| header `alg` | `RS256` only | Pinned, never read from the token |
| header `typ` | `JWT` | Refuses a non-JWT object |
| `sub` | `provider:providerAccountId` | The join key against `auth_accounts` |
| `iss` | `AUTH_API_ISSUER` | Only this app may mint a token for this API |
| `aud` | `AUTH_API_AUDIENCE` | A token for another service is refused |
| `exp` | required, finite | `jwtVerify` accepts an absent `exp`; a token with no expiry would never lapse |
| `email` | optional | Informational; never used to match accounts |
| `loginRole` | optional, `USER` / `EXPERT_TRADER` / `LIQUIDITY_PROVIDER` / `PLATFORM_ADMIN` | The persona the session signed in as (Module 13). Read leniently: anything else is treated as absent, so a bogus value degrades to an unscoped session. The claim can only ever *narrow* — `AuthService` intersects it with the roles the database holds, so it never widens one (an account without the admin row intersects to no roles at all) |

**The algorithm is pinned to RS256, and the pin is the security property.** An
unpinned verifier reads `alg` from the header and can be walked down to
`alg: none`, or handed an HMAC key that gets verified as though it were the
public key. Both attack classes are structurally impossible when only RS256 is
accepted; `token-verifier.service.spec.ts` has a test for each.

**Every failure returns the same response.** An absent token, a forged
signature, an expired token and a token for the wrong audience all produce one
identical `401` with the same message. The reason code exists in the log and
never reaches the client, because "your token expired 4 seconds ago" is free
reconnaissance.

### Key custody

The split is asymmetric and intentional:

| Side | Holds | Never holds |
| --- | --- | --- |
| Next.js | `AUTH_API_SIGNING_PRIVATE_KEY` | — |
| NestJS | `AUTH_API_SIGNING_PUBLIC_KEY` | the private key, any OAuth secret |

`AUTH_API_SIGNING_PUBLIC_KEY` is validated at boot by parsing it as a real RSA
key (`createPublicKey`), not by matching a string pattern. A regex cannot tell a
public key from a validly-formatted private key pasted into the wrong variable;
parsing can. Env validation also rejects EC keys, so a swapped key fails at boot
rather than at the first signed request.

The frontend mints tokens with `jose@6`; the backend verifies with `jose@5`. The
version difference is forced: `jose@6` is ESM-only, and Nest's CommonJS build
cannot `require()` it.

### Identity resolution

`AuthService` resolves a verified `externalIdentity` to a Prometheus user:

| Situation | Result |
| --- | --- |
| Known identity | the linked user |
| New identity | `User` + `AuthAccount` created |
| New identity, email already used by *another* user | `409 CONFLICT` |
| New identity, provider returned no email | `403 FORBIDDEN` |
| Linked user is `SUSPENDED` or `CLOSED` | `403 FORBIDDEN` |

**Providers are never linked by email.** Someone showing up with the same address
is a conflict to resolve by an operator, not an account to take over. Google lets
a user change their email, so an email-matched link would eventually hand over an
account that the address no longer proves.

**First login does not create a wallet.** `wallets` is Module 03's to provision.
`auth.e2e-spec.ts` asserts `user.wallet === null` so a regression here is caught
rather than quietly widening the module's scope.

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/me` | Bearer | The resolved Prometheus user |
| `GET` | `/api/health` | public | Health check. Also carries `providerConfigured` and `aiProvider` for the trade-buddy widget's status probe (see *Design-integration API additions*) |

Everything is authenticated by default: `AuthGuard` is registered globally and
opt-out is explicit via `@Public()`. A new controller is therefore protected by
being added, not protected by remembering to add a decorator — the failure mode
of the alternative is a new endpoint that is quietly world-readable.

---

## Wallet & Assets (Module 03)

`WalletService` is the accounting boundary. It is the only code that moves a
balance, and it does so by writing a balance row and its ledger entry in one
transaction. Future modules (Portfolio, Copy Trading, …) import this service;
they must never touch `wallet_balances` or `transactions` directly.

```
Controller ──▶ WalletService ──▶ Prisma $transaction ──▶ WalletBalance
                    │                                    Transaction
                    └── credit / debit / lock / unlock
```

### Endpoints (public surface)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/wallets` | Bearer | Create the caller's wallet. `201` on create, `200` if it exists |
| `GET` | `/api/wallets/me` | Bearer | The caller's wallet |
| `GET` | `/api/wallets/me/balances` | Bearer | Balances with their asset |
| `GET` | `/api/wallets/me/transactions` | Bearer | Keyset-paginated ledger |
| `GET` | `/api/assets` | Bearer | Active reference assets (INR, USDT, EMBER) |

Identity is always `@CurrentUser().id`. No endpoint accepts a `userId` or
`walletId`, and there is deliberately no `GET /wallets/:id`, so there is no path
to another user's wallet to authorize.

### Internal operations, not endpoints

`credit`, `debit`, `lock` and `unlock` are **service methods, not routes**. No
HTTP request can manufacture or destroy a balance. The semantics:

| Operation | `available` | `locked` | Ledger type |
| --- | --- | --- | --- |
| `credit` | `+amount` | — | `DEPOSIT` |
| `debit` | `-amount` | — | `WITHDRAWAL` |
| `lock` | `-amount` | `+amount` | `LOCK` |
| `unlock` | `+amount` | `-amount` | `UNLOCK` |

`deposit`/`withdraw` here are internal bookkeeping moves between `available` and
`locked` — **not** payment rails. `TransactionType` has no `CREDIT`/`DEBIT`
member, so the mapping above is pinned by the service and covered by tests.

### Invariants

- `amount > 0`. Zero, negative, `NaN` and `Infinity` are rejected at the DTO.
- `available` and `locked` are never negative.
- `debit` and `lock` need sufficient `available`; `unlock` needs sufficient
  `locked`.
- The wallet must be `ACTIVE`; an inactive asset cannot be mutated.
- Every successful move writes a `COMPLETED` transaction with `available_after`
  and `locked_after` snapshots.
- `total` is never stored and never returned — callers derive `available + locked`.

### Concurrency

Read-modify-write is the classic way to lose an update, so every move is a guarded
atomic `updateMany` whose `WHERE` restates the invariant. A `count === 0` means
the guard rejected the move and the transaction is aborted. The balance write and
the ledger insert share one interactive `prisma.$transaction`, so history and
state cannot disagree; `credit` additionally uses an atomic `upsert` for the
first balance. The database `CHECK` constraints are the backstop, not the plan.
When a future module mutates several assets at once it must order them by
`assetId` to avoid deadlocks.

### Money and precision

Balances are `Prisma.Decimal` (`NUMERIC(38,18)`), never JavaScript numbers, all
the way to serialization, where they leave as strings. A mutation is rejected if
it carries more decimal places than the asset declares (`decimals`), so `USDT`
cannot be credited an 18-place amount. Reads are formatted with `toFixed(decimals)`.

### Pagination

Transaction history uses keyset pagination on `(created_at, id)`, descending. The
cursor is an opaque base64url JSON token (`cursor.util.ts`, version 1); a
malformed cursor is a `400`, not a crash. Default page size 20, max 100.

### Seed data

`npm run prisma:seed` upserts three reference assets by `symbol`, so it is
idempotent:

| Symbol | Kind | Decimals | Note |
| --- | --- | --- | --- |
| `INR` | `FIAT` | 2 | |
| `USDT` | `STABLECOIN` | 6 | |
| `EMBER` | `TOKEN` | 18 | Accounting only; no tokenomics |

`AssetsService` is read-only and `GET /api/assets` returns active assets only.

### Errors

| Code | Status | Cause |
| --- | --- | --- |
| `INSUFFICIENT_BALANCE` | `409` | Not enough `available` (debit/lock) or `locked` (unlock) |
| `WALLET_FROZEN` | `409` | Wallet is not `ACTIVE` |
| `ASSET_INACTIVE` | `409` | Asset is not `ACTIVE` |
| `NOT_FOUND` | `404` | No wallet yet, or unknown asset |

---

## Wallet Top-ups (Module 03b)

A top-up is the **one** way money enters a Prometheus wallet. It exists because
every other module spends from the wallet — the USDT exchange, the EMBER hub,
the staking book — and without it a user could never trade.

The module's whole point is that **the credit is never simulated**. What the
`simulated` rail simulates is the *payment*: no bank, no UPI intent, no card.
The money that appears is a real `transactions` row of type `DEPOSIT` and a
real `wallet_balances` row, exactly as a card payment would produce, so the
balance the user sees is the ledger's own number rather than a figure invented
for the screen.

```
Browser ──▶ POST /api/payments/deposits ──▶ PaymentsService
                                                   │
                    ┌──────────────────────────────┴───────────────────┐
                    │ simulated                    razorpay            │
                    │                              Orders API ──▶ order  │
                    │                              checkout in browser  │
                    └──────────────────┬───────────────────────────────┘
                                       ▼
                            wallet_deposits row + WalletService.credit
                                       ▼
                          wallet_balances + transactions (DEPOSIT)
```

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/payments/provider` | Bearer | Which rail is active, and the largest single top-up |
| `POST` | `/api/payments/deposits` | Bearer | Start a top-up. `201` on create, `200` on a replay |
| `GET` | `/api/payments/deposits` | Bearer | The caller's top-ups, newest first |
| `POST` | `/api/payments/deposits/:id/verify` | Bearer | Confirm a Razorpay payment and credit it |
| `POST` | `/api/payments/webhooks/razorpay` | Signature | Razorpay's `payment.captured` / `payment.failed` delivery |

Identity is always `@CurrentUser().id`. There is no route that accepts a
`userId`, and `GET /api/payments/deposits` and the verify route both refuse a
deposit that is not the caller's (`404`, never `403`, so the existence of
another user's deposit is not disclosed).

### Idempotency is a key, not a flag

`(userId, clientRequestId)` is unique in the database. A replayed request finds
the original deposit and returns it **without moving a balance again**; two
racing requests with the same key both start, and the loser's insert fails with
a unique violation that rolls its whole transaction back — so the credit
applies exactly once across both. This is the same house pattern as Module 08's
USDT orders.

### The credit is exactly once, even when two confirmations arrive

A Razorpay deposit can be confirmed twice — once by the browser returning from
checkout and once by the webhook — and both may arrive at the same moment. The
credit is guarded by a compare-and-swap inside the credit transaction: only a
`PENDING` deposit may become `SUCCEEDED`, and only the request that flipped it
credits the balance. The loser reads the finished deposit back and moves
nothing.

### Switching to Razorpay

The rail is configuration, not code. Set `PAYMENTS_PROVIDER=razorpay`, drop the
keys in, restart. Both rails end in the same `creditDeposit`, so no application
logic changes:

- **Checkout signature** — `HMAC_SHA256(order_id + "|" + payment_id, key_secret)`.
  The browser hands the three values back; the backend recomputes the signature
  with the secret it holds, so a client cannot assert a payment it never made.
- **Webhook signature** — `HMAC_SHA256(raw_body, webhook_secret)`, sent as
  `X-Razorpay-Signature`. The signature is over the *exact bytes received*, so
  the raw body is preserved (`rawBody: true` in the bootstrap); a re-serialised
  JSON body would not hash to the same value.
- **Order matching** — the deposit's `providerReference` holds Razorpay's order
  id, so a webhook carrying only an order id finds its deposit without a second
  lookup table. The column is unique, so a provider callback can never be
  applied to two deposits.
- The captured amount is compared with the deposit's own amount before anything
  is credited; a mismatch is refused with `409`.

Use Razorpay **test** keys (`rzp_test_…`) while developing.

### Limits

- A single top-up may not exceed `PAYMENTS_MAX_DEPOSIT_INR` (default ₹5,00,000).
  This is an abuse rail on one request, not a cap on what a wallet may hold.
- `amountInr` is a **string**, never a JSON number: INR is stored as
  `NUMERIC(38,18)`, and a float that has already lost its precision cannot be
  recovered. At most two decimal places — a rupee is not a sub-rupee instrument.

### Errors

| Code | Status | Cause |
| --- | --- | --- |
| `VALIDATION_FAILED` | `400` | A malformed amount, a missing idempotency key, an amount above the ceiling, or a signature that does not match |
| `NOT_FOUND` | `404` | The deposit is not the caller's, or the webhook names an unknown order |
| `CONFLICT` | `409` | A payment that belongs to another order, or a captured amount that does not match the deposit |
| `SERVICE_UNAVAILABLE` | `503` | The payment provider could not be reached. No deposit was started |

---

## Portfolio (Module 04)

`GET /api/portfolio` is the whole module. It assembles a user's financial
position from the wallet and returns it. There is no `portfolios` table, no
cache and no stored total, so nothing here can drift out of step with the
ledger: a portfolio cannot become wrong, because it is never written.

```
PortfolioController ──▶ PortfolioService ──▶ WalletService.findForUser
                              │              WalletService.getBalances
                              │              Prisma.transaction aggregates (read-only)
                              └── derived: total, isFunded, lockedShare, composition
```

### Endpoint

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/portfolio` | Bearer | The caller's holdings, composition and activity |

No parameters. Identity comes from `@CurrentUser().id` and there is no
`GET /portfolio/:userId`, so there is no route that could name somebody else's
portfolio. A `?userId=` query string is ignored rather than honoured — a query
parameter that looks like an override and silently is not would be worse than one
that errors.

### Response shape

```jsonc
{
  "wallet": { "id": "…", "status": "ACTIVE", "createdAt": "2026-10-01T09:12:00.000Z" },
  "holdings": [
    {
      "asset": {
        "id": "…", "symbol": "USDT", "name": "Tether",
        "kind": "STABLECOIN", "decimals": 6, "isActive": true
      },
      "available": "500.000000",   // strings, at the asset's own scale
      "locked":    "200.000000",
      "total":     "700.000000",   // available + locked, derived
      "isFunded":  true,
      "lockedShare": 0.2857        // 0–1, or null when the total is 0
    }
  ],
  "composition": {
    "assetCount": 3,               // balance rows, including drained ones
    "fundedAssetCount": 2,         // the subset with a non-zero total
    "byKind": { "FIAT": 1, "STABLECOIN": 1, "TOKEN": 1 }
  },
  "activity": {
    "totalMovements": 5,
    "movementsLast30Days": 5,
    "byType": { "DEPOSIT": 2, "WITHDRAWAL": 1, "TRANSFER_IN": 0, "TRANSFER_OUT": 0,
                "LOCK": 1, "UNLOCK": 1, "ADJUSTMENT": 0 },
    "firstMovementAt": "2026-10-01T09:12:00.000Z",
    "lastMovementAt":  "2026-10-03T11:40:02.000Z"
  },
  "generatedAt": "2026-10-03T11:41:00.000Z"
}
```

`wallet` is `null` when the user has none. `activity` is `null` when the ledger
is empty, so a caller can say "no activity yet" instead of rendering zeroes that
read as data. Every `byType` key is present regardless, so the response shape
never depends on which movements happen to exist.

### Derived, not stored

| Field | Rule |
| --- | --- |
| `total` | `available + locked` in `Prisma.Decimal`, never persisted |
| `isFunded` | `total > 0`. A drained row is still listed — the user does hold the asset, just none of it |
| `lockedShare` | `locked / total`, rounded half-up to 4 places. `null` for a zero total, which is what keeps `NaN` and `Infinity` out of the response |
| `assetCount` | Number of balance rows, including drained ones |
| `fundedAssetCount` | Rows whose total is non-zero |
| `byKind` | Count of holdings per `AssetKind`, all three keys always present |

`lockedShare` is the only number in the response, and it is safe as one because
it is a ratio of a unit to itself — no currency is carried across.

### What it deliberately does not compute

- **Valuation or net worth.** No price source exists in this repository, so any
  monetary total across INR, USDT and EMBER would be invented.
- **Allocation percentages.** The denominator would be a sum of incompatible
  units. Composition is counted per asset *category* instead, which is what the
  counts actually mean.
- **P&L of any kind.** The ledger records movements without acquisition costs, so
  neither realised nor unrealised P&L is derivable from it.

A field that would always be `null` was left out rather than added. A permanent
`null` invites a UI to render a zero as though it were a measured result.

### Read-only, structurally

- It never calls `credit`, `debit`, `lock` or `unlock`. Portfolio is not a second
  accounting path.
- It never writes `wallets`, `wallet_balances`, `transactions` or `assets`.
  `portfolio.e2e-spec.ts` fingerprints those three tables before and after a read
  and asserts they are byte-identical.

### Relationship to the wallet

`PortfolioModule` imports `WalletModule` and reaches only its **exported**
`WalletService` API — `findForUser` and `getBalances`. It does not import
`wallet.types.ts` or `decimal.util.ts`: a feature module may depend on another
feature's public service, not on its internals. The one type it needs is derived
from the service's own signature, and the two lines of amount formatting are
reimplemented rather than imported, so a read model cannot throw a domain
exception while being read.

Ledger aggregates are read through `prisma.transaction` rather than by widening
`WalletService`. Counts over a time window are portfolio questions, not
accounting questions, and adding read methods to the one module that must stay
small would be the wrong trade.

### Cost

A fixed six statements per request: the wallet lookup, the balance read (which
resolves the wallet again — a second indexed lookup for a row this service
already holds), and three aggregates over the ledger. The count does not vary
with the number of holdings or movements, so there is no N+1.

### Assets that have been retired

A holding whose asset is no longer active is still returned, with
`isActive: false` and the balance intact. Hiding it would make money
disappear from a portfolio because a reference row changed, and the balance has
to remain auditable.

---

## Strategy (Module 05)

A strategy here is a **named record with an owner's own description of it** —
nothing else. There is no code, no rules, no schedule and no connection to a
wallet. Modules 06–07 will decide what a strategy may *do*; this one only
decides what a user is allowed to call something and who may see it.

```
StrategyController ──▶ StrategyService ──▶ prisma.strategy
                             │                prisma.user (RESTRICT)
                             └── no imports from any other feature module
```

`StrategyModule` imports no other feature module. It needs no wallet, no
portfolio and no auth service beyond the global guard and the `@CurrentUser()`
decorator, so there is no dependency to freeze and no way for this module to
reach money.

### Endpoints

All five require authentication; the global guard is default-deny and nothing
here opts out.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/strategies` | Create one of the caller's strategies |
| `GET` | `/api/strategies` | Browse the public catalogue |
| `GET` | `/api/strategies/me` | The caller's own strategies, newest first |
| `GET` | `/api/strategies/:id` | One strategy, in the shape the caller may see |
| `PATCH` | `/api/strategies/:id` | Rename, re-describe, publish/unpublish, archive |

There is no `DELETE`, and no route anywhere that names an owner. `me` is
declared before `:id` so the literal path wins over the parameter.

### Shape

```jsonc
// owner view
{ "id": "…", "name": "EMBER momentum", "description": "Holds EMBER through momentum swings.",
  "visibility": "PUBLIC", "status": "ACTIVE",
  "createdAt": "2026-10-05T09:12:00.000Z", "updatedAt": "2026-10-05T09:12:00.000Z" }

// discovery view — deliberately narrower
{ "id": "…", "name": "EMBER momentum", "description": "Holds EMBER through momentum swings.",
  "createdAt": "2026-10-05T09:12:00.000Z", "updatedAt": "2026-10-05T09:12:00.000Z" }
```

`PublicStrategyDto` drops `ownerId` (which would turn a catalogue into a
directory of user ids), every owner identifier — Prometheus has no display-name
field to expose even if one were wanted — and `status`/`visibility`, which are
constants in that set and would suggest a filter the client cannot use.

Both listings return the same envelope, so one client code path paginates both:

```jsonc
{ "items": [ … ], "page": 1, "limit": 20, "total": 34, "totalPages": 2 }
```

### Rules the code enforces

| Rule | Where |
| --- | --- |
| The owner is the token. No DTO, path or query parameter can name one | `CreateStrategyDto` has no owner field; a client that sends one is rejected, not ignored |
| Names are unique per owner, ignoring case and surrounding spaces | functional index; `P2002` → `409 CONFLICT` inside the service |
| A private strategy is invisible to everyone else, including by id | service resolves visibility; an invisible row is `404`, never `403` |
| An archived strategy cannot be edited, republished or unarchived | `updateOwned` refuses it; `status` accepts `ARCHIVED` alone via `@Equals`, so `ACTIVE` is a `400` at the boundary rather than a `409` that depends on the row |
| Discovery shows `PUBLIC` + `ACTIVE` only, newest first | pinned in the query; `?status=`/`?visibility=` are accepted and ignored there, so they cannot be used to widen it |
| `PATCH` may carry any one field alone | every DTO field is optional; an empty description clears to `null` |

`P2002` is caught in `StrategyService`, not in the global exception filter, so
the translation to a 409 with this project's error code belongs to the module
that understands what the collision means.

### Pagination

Offset, 1-based, `page`/`limit` (default 20, max 100) — not a cursor. Module
03's keyset cursor is right for a ledger that only grows at one end, and reusing
it would reach into a frozen module's internals. A strategy list is short,
changes rarely and is re-read and re-filtered from the first page far more often
than it is paged through. The honest cost: a row created or archived between two
requests can shift an offset, so a page boundary may repeat or skip a row.
Nothing here is money and nothing here is cumulative, so that is a cosmetic
artefact rather than a correctness problem.

### What this module has no idea about

No ROI, APY, Sharpe, drawdown, P&L, win rate, risk score, follower count, AUM,
category or tags. Not "not yet implemented" — the table has eight columns and the
schema suite fingerprints the catalog to prove no speculative column has been
added. Those figures need modules that do not exist; a column typed as a number
would be rendered as a measured result.

A strategy also cannot move money, hold an allocation or be copied. `StrategyModule`
imports no wallet code, and the e2e suite asserts that a strategy exists and is
visible without a wallet existing at all.

---

## Risk (Module 06)

`GET /api/risk/strategies/:strategyId` is the whole module. It reads a
strategy's daily equity history through a port, derives three risk
measurements from it, and classifies the strategy as `LOW`, `MEDIUM` or
`HIGH`. It stores nothing and writes nothing.

### Endpoint

| Method | Path | Auth | Success |
| --- | --- | --- | --- |
| `GET` | `/api/risk/strategies/:strategyId` | bearer token | `200` |

| Status | When |
| --- | --- |
| `200` | Any strategy the caller may see — including one with no history at all |
| `400` | The id is not a UUID |
| `401` | No token, or a token that is not an `ACTIVE` user |
| `404` | Unknown strategy, or one the caller may not see — never `403` |

A batch shape, `GET /api/risk/strategies?ids=…`, is documented rather than
built: an id list is a second contract to secure, page and test, and nothing
needs it yet. The route does not exist, and the suite asserts it returns `404`.

### Two states, and why there is no third

```json
{
  "strategyId": "…",
  "status": "INSUFFICIENT_DATA",
  "reason": "NO_HISTORY",
  "riskLevel": null,
  "metrics": null,
  "evidence": {
    "observations": 0,
    "firstObservedAt": null,
    "lastObservedAt": null,
    "requiredObservations": 30,
    "sampleDescription": "daily equity points"
  },
  "evaluatedAt": "2026-10-07T12:00:00.000Z"
}
```

`INSUFFICIENT_DATA` is a successful answer and returns `200`, because the
request was well formed and the strategy was visible — refusing it would tell a
client that a brand-new strategy is malformed. Exactly one reason is returned,
chosen by this precedence:

| Reason | Means |
| --- | --- |
| `INVALID_SERIES` | The series broke the contract: a bad date, a duplicate day, a gap, or non-positive equity |
| `NO_HISTORY` | No observations at all |
| `INSUFFICIENT_HISTORY` | 1–29 observations |
| `NO_ACTIVITY` | 30 or more observations, none of which moved |

Validation runs before counting because a series with a hole in it describes a
history it does not contain; counting runs before flatness because "not enough
evidence" outranks "the evidence showed nothing".

There is deliberately **no third state** that renders a placeholder estimate. A
number standing in for an absent measurement is indistinguishable from a
measured one once it reaches a screen, so `riskLevel` and `metrics` are null
together and are never defaulted to `LOW` or `0`.

### Measurements

| Metric | Definition |
| --- | --- |
| `maxDrawdown` | `max((peak_t − E_t) / peak_t)` over the series, on `[0, 1]` |
| `dailyVolatility` | Sample standard deviation of daily simple returns `r_t = (E_t − E_{t−1}) / E_{t−1}` |
| `annualisedVolatility` | `dailyVolatility × 15.8745078664` (√252) |

| Level | Reached when either |
| --- | --- |
| `HIGH` | `maxDrawdown ≥ 0.10` **or** `annualisedVolatility ≥ 0.40` |
| `MEDIUM` | `maxDrawdown ≥ 0.05` **or** `annualisedVolatility ≥ 0.20` |
| `LOW` | neither |

Both inputs can reach a level on their own: a calm strategy with one
catastrophic collapse is `HIGH` on drawdown, and a strategy that never drops
far but whips constantly is `HIGH` on volatility.

**Precision.** Equity, returns, mean, variance and drawdown are computed in
`Prisma.Decimal`; only the dimensionless variance crosses to a number for the
square root. The sample divisor is `n − 2` observations (`returns.length − 1`),
not the population divisor — substituting the familiar one would quietly
understate every strategy's volatility. Classification reads **unrounded**
values; rounding happens once, at the output boundary, to four decimal places
`ROUND_HALF_UP`. A drawdown of `0.0999999` displays as `0.1` and is still not
`HIGH`, so the level can never contradict the numbers printed beside it.

Only risk is reported. No return, P&L, Sharpe, win rate, price or equity
balance appears in the response — those answer a separate question and belong
to the simulation's own endpoints (`/api/simulations/…`), where they are
labelled as paper results rather than worn by a risk figure.

### Evidence

`evidence` says what the statement was made from, so a client can explain an
empty state in words: `0 of 30 daily equity points`. `requiredObservations` and
`sampleDescription` are echoed rather than hard-coded so that explanation stays
true if the policy changes. The dates are null when there are no observations,
and stay null when the series was refused — reporting dates from data we
declined to trust would imply we trusted it.

### The equity port, and why today's answer is honest

`EQUITY_SERIES_PORT` is injected into `RiskService` as the only source of
history. Before Module 06b it resolved to `EmptyEquitySeries`, which returned
`[]` — every response then read `NO_HISTORY`, an honest report of absent
evidence.

Module 06b changed the registered provider, and nothing else in this module:
`SimulationModule` now exports `PersistedDailyValueSeries`, and `risk.module.ts`
binds it with `useExisting`. The Risk Engine therefore measures what a
simulation actually stored in `strategy_daily_balance`, with no formula, no
service, no controller and no response field touched. A strategy that was never
simulated still answers `INSUFFICIENT_DATA / NO_HISTORY`, because its series is
still empty — the same answer for the same reason as before, and the guard suite
(`test/market-guard.e2e-spec.ts`) pins both directions: the swap makes a
simulated curve measurable and leaves an unsimulated one refused.

The port remains the boundary rather than a stub: a later module that records
equity differently supplies another `EquitySeriesPort` and the risk reading
follows it, again without changing risk code.

### Read-only, structurally

`RiskService` depends on `StrategyService` — for visibility — and on
`EquitySeriesPort` — for history. It has no Prisma client, no repository and no
write path of any kind, so nothing it does *can* move a row. It never
reimplements visibility: `findVisibleTo` resolves the strategy and throws
`404`, never `403`, so a stranger cannot learn that a private strategy exists.

There is no risk table, no risk column on `strategies`, no cache, no snapshot
and no audit row. Two requests can return different answers as history arrives,
which is the point: the response describes what is true now, where a stored one
would describe what was true when it was written.

---

## Market Data & Simulation (Module 06b)

Everything the Risk Engine now measures, and the only place historical prices
enter the product: an offline importer, a deterministic simulation engine, four
tables and three read-only API surfaces. It is deliberately read-only over
HTTP — nothing here places an order, moves a wallet balance or is reachable by
a caller wanting to change something.

### The dataset

`data/market/raw/` (repository root, committed) holds 81 ZIP archives — three
symbols × 27 daily files — whose CSVs contain 1,932 rows: **644 UTC days per
symbol, `2025-01-01 → 2026-10-06`, for `BTCUSDT`, `ETHUSDT` and `SOLUSDT`**, a
single contiguous window with no gaps, duplicates or ordering faults.

Each CSV row has 12 fields and no header: a 16-digit microsecond open time, a
close time exactly `open + 86,399,999,999µs`, OHLC, volume, quote volume, and
a taker-count field the importer requires to be `0`. Prices carry at most 8
decimal places. All 81 archives are DEFLATE; the reader also supports STORE and
refuses anything else by name.

### The importer

`importMarketData()` reads a symbol directory, opens each archive, parses every
row and writes with `ON CONFLICT DO NOTHING`, so a re-run inserts 0 and changes
nothing (`npm run market:verify` proves exactly that). The report it returns is
the diagnosis: per-symbol counts, and a list of issues with stable codes rather
than prose.

- **Fatal, one per problem row:** `CSV_COUNT`, `CSV_PATH`, `CSV_NAME_MISMATCH`,
  `CSV_BLANK_LINE`, `DUPLICATE_DAY`, `OUT_OF_ORDER`, `GAP`, and the kline rules
  `KLINE_FIELD_COUNT`, `KLINE_OPEN_TIME_FORMAT`, `KLINE_OPEN_TIME_NOT_MILLISECOND`,
  `KLINE_OPEN_TIME_OUT_OF_RANGE`, `KLINE_OPEN_TIME_NOT_MIDNIGHT`,
  `KLINE_PRICE_FORMAT`, `KLINE_PRICE_NOT_POSITIVE`, `KLINE_OHLC_ORDER`,
  `KLINE_VOLUME_FORMAT`, `KLINE_VOLUME_NEGATIVE`.
- **Warnings (recorded, never fatal):** `KLINE_CLOSE_TIME_FORMAT`,
  `KLINE_CLOSE_TIME_MISMATCH`, `KLINE_TRADES_FORMAT`, `KLINE_TAKER_FORMAT`,
  `KLINE_IGNORE_FIELD`, `KLINE_PRECISION`.
- **Archive-level:** `NO_ARCHIVES`, `SYMBOL_DIR_MISSING`, `DATA_DIR_MISSING`,
  `NO_SYMBOLS`, `ZIP_FORMAT`, `ZIP64_UNSUPPORTED`, `ZIP_TRUNCATED`,
  `ZIP_METHOD_UNSUPPORTED`, `ZIP_DEFLATE_FAILED`, `ZIP_SIZE_MISMATCH`,
  `ZIP_CRC32`.

A symbol is imported atomically: one bad row fails that symbol's import and
leaves no partial window behind. Importing is an **offline operation** — there
is no HTTP route for it, because an endpoint that reads the filesystem on
request would be a long, cancellable, unauthenticated-looking job wearing the
clothes of an API.

### The engine

One rule, one symbol, one window. For each day `t` the rule reads closes
**through `t` and nothing later** and returns a `Desire` — `long`, `flat` or
`hold`. The engine then fills that desire at the **next day's open**, and only
if the next candle exists: the last day of the window can form an opinion it
can never act on. This signal-at-close / fill-at-next-open split is what keeps
the curves free of look-ahead bias.

Money is exact, never floating point:

- quantity is truncated to 8 decimal places (round down) *before* computing the
  gross;
- `fee = roundMoney(gross × feeRate)`;
- cash is rounded to 18 places (half-up) after every fill;
- a buy that would drive cash below zero is skipped rather than financed;
- `value = round(cash + positionValue, 18)`, so every balance row reconciles by
  arithmetic a reader can do by hand.

The three shipped rules (`src/modules/simulation/rules/rule-catalog.ts`) and
their stable reason notes:

| Rule key | Symbol | Behaviour | Notes |
| --- | --- | --- | --- |
| `buyhold-btc` | BTCUSDT | Buys once on the first day and never sells | `initial_allocation`, `never_exits` |
| `sma-cross-eth` | ETHUSDT | Long while SMA(20) > SMA(50), flat otherwise; starts after day 49 | `sma_cross_up`, `sma_cross_down` |
| `donchian-sol` | SOLUSDT | Long on a 20-day ceiling breakout, flat on a 10-day floor breakdown; holds until day 20 | `donchian_breakout_up`, `donchian_breakout_down` |

The assumptions are inputs, not measurements: **`initialCash = 100000` paper
USDT, `feeRate = 0.001`, long only, no leverage, no slippage**. The dataset has
no fee column, so the rate is stated on every response as `assumption` beside
`feeRate`, and no figure can be quoted without the sentence that explains it.

### What is stored

| Table | Holds |
| --- | --- |
| `market_candles` | One row per symbol per UTC day: OHLC, volume, quote volume |
| `strategy_simulations` | One row per simulated strategy: rule, version, window, cash, fee rate, row counts |
| `strategy_fills` | Simulated orders, 1-based `sequence_no`, with `cash_after` and the rule's note |
| `strategy_daily_balance` | One row per calendar day: cash, position qty, position value, total value |

Money columns are `NUMERIC(38,18)`; days are UTC midnights. `strategy_simulations.strategy_id`
is the primary key *and* a foreign key to `strategies` (`ON DELETE RESTRICT`),
so a strategy can never accumulate two curves, and its fills and balances
cascade with it. `strategies` itself is untouched: the simulation appears as a
Prisma back-relation only — no column, no migration on the frozen table.

**Replace-all is the whole re-run policy.** Re-running a simulation deletes its
previous curve and writes the new one in the same transaction, so a reader sees
either the old curve or the new one, never a half-written one. There is no run
history, because nothing yet compares two runs.

### Endpoints

| Route | Answers |
| --- | --- |
| `GET /api/market/candles` | Paged candles. `symbol` required (alphanumeric), `from`/`to` as `YYYY-MM-DD` inclusive, `page ≥ 1`, `limit ≤ 100`. An empty window for a known symbol is `200` with `total: 0`; an unknown symbol is `404`; `from > to` is `400` |
| `GET /api/simulations/:strategyId` | Summary: rule, symbol, window, cash, fee rate, counts, `simulated: true`, `notRealTrades: true`, `assumption` |
| `GET /api/simulations/:strategyId/fills` | Paged fills, ascending by `sequence_no` |
| `GET /api/simulations/:strategyId/balance` | Paged daily balances, ascending by day — the series the Risk Engine measures |

All four are authenticated and go through strategy visibility first: a
strategy the caller may not see, or one that was never simulated, is `404`.
Money and days are exact decimal strings everywhere; `computedAt` is the only
timestamp. There is **no write route** — simulations run from the seed, where
the rule, the candles and the fee assumption are all visible together.

### Seed

```bash
npm run market:seed     # import + three simulations, idempotent
npm run market:verify   # dry run: reports what a seed would do, writes nothing
```

`seedMarketData()` (exported from `src/`, not a script-only file) upserts a
system owner (`system@prometheus.local`, no sign-in identity), upserts the
three expert strategies by exact name under it as `PUBLIC` + `ACTIVE` — every
description opens with the word "Paper" and states "Simulated trades only" —
imports the candles, then simulates each rule. Each step is independent: if the
import fails, the strategies still exist and are simply unsimulated until the
data is fixed. `prisma/seed.ts` (Module 03's asset catalogue) is untouched and
the two seeds run in either order.

### What this module does not do

- **No execution, no money.** Fills are paper rows; no wallet, balance or
  transaction is read or written anywhere in the module.
- **No prices for valuation.** Candles are reference data for simulation only;
  Module 04's portfolio still has no price source, and this module does not
  quietly become one.
- **No HTTP trigger for a simulation**, and no run history.
- **No frontend work.** The read APIs exist for a later screen; the shipped UI
  calls none of them.

---

## USDT Exchange (Module 08)

The USDT quote/order flow with live market pricing, zero explicit brokerage,
a best-price guarantee that holds every quote at least ₹1.50 better than the
market on both sides, and simulated internal
balance updates. Nothing here is real custody,
settlement or exchange execution: the "live" prices come from public
market-data endpoints behind a port — the CoinDCX USDT/INR order book for
execution and CoinGecko for the reference — and a deterministic fake provider
serves the automated suites.

The module adds exactly one table, `usdt_orders`, and four authenticated
endpoints. It is the first module whose orders move **real Module 03 money**:
the INR and USDT legs run through `WalletService`, never around it.

### Live pricing

| Role | Source | Behaviour |
| --- | --- | --- |
| Execution price | CoinDCX USDT/INR order book (`I-USDT_INR`) | BUY walks asks (lowest first), SELL walks bids (highest first); the VWAP of the consumed levels is the starting price. **Zero explicit brokerage:** no fee, spread or markup field exists; the customer pays exactly `volume × price`. A book that cannot fill the whole quantity is insufficient depth, not a partial price. |
| Best-price guarantee | The same fresh CoinGecko venues the reference uses | The book VWAP is then capped (BUY) or floored (SELL) so it sits **at least ₹1.50 inside the best *executable* offer among them** — BUY `floor(bestAsk − 1.50)`, SELL `ceil(bestBid + 1.50)`, `MIN_MARKET_ADVANTAGE_INR = 1.50` — and rounded one paise **in the customer's favour**, so the two-decimal figure the API returns can never give a paisa of that margin back. The ₹1.50 is a *minimum advantage, never a levy*: a book already more than ₹1.50 better passes through untouched, and a book already better but by less than ₹1.50 is still driven to the margin. It only ever moves a price toward the customer; with no fresh venues it changes nothing. A result that would leave the sanity band is abandoned instead, with reason `best_price_guarantee_out_of_band`. |
| Venue executable price | Each venue's CoinGecko ticker: last print + half its own reported bid/ask spread | The ask on a BUY, the bid on a SELL — what a customer could actually deal at there. Where no spread is reported (ZebPay) or it is implausible, the raw last print is used and flagged `venuePriceBasis: "last_price"`; a print is a floor on a venue's ask and a ceiling on its bid, so that is the *most generous* reading available for the venue, never an invented bargain. This is the figure the guarantee matches and the page compares against — never a trade print, which nobody can transact at. |
| Savings reference | CoinGecko USDT/INR venue tickers (CoinDCX, WazirX, ZebPay, BitBNS) | Stale-flagged or aged-out venues are excluded. Two or more fresh venues → `average_of_N_venues(...)`; one → `single_venue(...)`; zero → the CoinGecko INR-converted aggregate, labelled as an aggregate and never presented as an Indian venue price; nothing fresh → savings is `null`, never guessed. |
| Sanity anchor | CoinGecko aggregate, else the configured fallback | A VWAP further than `USDT_PRICE_SANITY_MAX_DEV_PCT` (20%) from this independent anchor is refused — a mis-parsed or wild book cannot price an order just because it is self-consistent. The guarantee is re-checked against the same anchor before it is applied. |
| Display-only fallback | `USDT_FALLBACK_PRICE_INR` (e.g. `99.90`) | When execution data is missing, stale or insane, `GET quote` serves a labelled `fallback` quote at this configured price with savings `null` and an explicit note. It is a configured value, not a market observation, and **orders never execute at it**. |

**Why the guarantee exists.** Zero markup is necessary but not sufficient:
against a lagging last-trade print an honest ask always looks high, and a thin
top of book makes it look worse. Prometheus therefore publishes three figures
per quote so the claim is auditable rather than asserted —
`execution.bookVwap` (what the raw book said), `guarantee` (what changed,
which venue, and why, or that nothing needed to) and each competitor's
`venuePrice` (the exact figure the guarantee measured itself against). The
invariant both directions share: **the price the API returns is at least
₹1.50 better than every venue on the screen**, and the SELL direction gains
from it symmetrically — a bid book below the venues is lifted to the best bid
plus the same margin. The exchange screen renders that same competitor list
side by side (three rows whenever three or more venues reported a price) so
the advantage can be read off rather than taken on trust.

**Execution policy.** An order settles only with a live execution VWAP *and*
a fresh reference, both verified in the same request, with the best-price
guarantee applied inside that same pass so the figure charged is the figure
shown. The book timestamp must be within `USDT_PRICE_MAX_AGE_MS` (30s
default) and references within
`USDT_REFERENCE_MAX_AGE_MS` (15 min — CoinGecko refreshes on a minutes
cadence), with future timestamps beyond clock skew rejected. Anything else is
**503 `PRICING_UNAVAILABLE`** before any wallet or persistence work: fallback
and stale prices never move money, and a customer is never charged a price the
response did not show as live. A replay is exempt — it returns the original
order without re-pricing, so an idempotent retry can never 503.

**Transient upstream failures reuse the last good reading.** A CoinDCX or
CoinGecko fetch that times out or errors mid-window does not empty the screen:
the provider keeps the last good book and the last good reference list
independently, and serves either one back while it is still inside its own
window (30s for the book, 15 min for the reference). The reused book keeps its
original `fetchedAt` — "Book captured" stays honest about when the data was
really seen — and the quote carries a provenance reason first in the
`reasons` array: `execution_reused_last_good` and/or
`reference_reused_last_good`. Past the window the slot is refused rather than
replayed, so reuse can soften a blip but never resurrect a stale market; only
when nothing usable remains does the quote fall back to the configured
display price (or 503 an order).

**Configuration** (validated at boot; see `.env.example` for the documented
block): `USDT_PRICING_PROVIDER` (`live` | `fake`; defaults to `fake` under
`NODE_ENV=test` so the suites never require network access),
`COIN_GECKO_API` (optional; travels only in an HTTP header — never in a URL,
log or error), `COINGECKO_BASE_URL`, `COINDCX_TICKER_URL`,
`COINDCX_ORDERBOOK_URL`, `USDT_FETCH_TIMEOUT_MS` (3000),
`USDT_PRICE_CACHE_TTL_MS` (5000, single-entry), `USDT_PRICE_MAX_AGE_MS`
(30000), `USDT_REFERENCE_MAX_AGE_MS` (900000),
`USDT_PRICE_SANITY_MAX_DEV_PCT` (20), `USDT_FALLBACK_PRICE_INR`, and
`USDT_FAKE_PRICING_SCENARIO` (`live` | `stale` | `down` | `no-reference`;
tests only, read per request so a suite can flip the market between calls).

**Savings = volume × (reference − execution) on a BUY, volume × (execution −
reference) on a SELL**, rounded HALF_UP to the paise. Positive always means
"the customer is better off than the reference for the same direction and
quantity". Because the reference is an average of the venues and the guarantee
has already moved execution to the best of them, a fresh SELL normally lands
positive too; should the book and the guarantee still sit below the reference,
the metric is reported negative, never dressed up as a saving. The metric is a
**reference-price comparison only** — never cash, never revenue — and it is
snapshotted onto the order row so history still explains what was measured.

**INR exactness.** `inrAmount = volume × price` (the guaranteed price, not the
raw VWAP) is rounded HALF_UP to two
decimal places — the currency's granularity (paise), not a fee; the same rule
applies in both directions and retains no value for Prometheus. A conversion
that rounds below ₹0.01 (for example `0.000001 USDT`) is **refused with 400,
never charged as zero**, so a dust order can never move a balance the quote
never showed.

### Endpoints

All four require a bearer token (`401` without one); the caller is always
resolved from `@CurrentUser`, so no route can quote for, place for, or list
another user's orders.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/usdt/quote?side=&usdtAmount=` | Pure pricing: inr amount, the guaranteed execution price, signed savings and the full `pricing` provenance block (status, execution timestamps and `bookVwap`, the `guarantee` verdict, competitors with their `venuePrice`/`venuePriceBasis`, aggregate, fallback, machine-readable `reasons`). Touches no wallet and no table, so a quote works before a wallet exists. A `fallback`-status quote is labelled, carries `savings: null` and no guarantee (`guarantee: null` — there is no live market to guarantee against); if nothing at all can be shown it is 503. |
| `POST` | `/api/usdt/buy` | Body `{ clientRequestId, usdtAmount, maxExecutionPrice? }`. Debits INR at the fresh guaranteed price, credits USDT, records the order. `201` on acceptance (response carries the live `pricing` provenance), `200` on replay (no `pricing` block — the original order is the truth). |
| `POST` | `/api/usdt/sell` | Same body with `minExecutionPrice?`; debits USDT, credits INR. |
| `GET` | `/api/usdt/orders?cursor=&limit=` | The caller's order history, newest first, keyset-paginated. Rows carry the recorded snapshot numbers, not a re-priced provenance block. |

**Price guards (the explicit slippage rule).** `maxExecutionPrice` (BUY) and
`minExecutionPrice` (SELL) are optional customer limits: the order settles at
the fresh guaranteed price computed in the same request, and the guard is
checked against *that* final figure — what the customer would actually pay or
receive — not the raw VWAP beneath it. If the price has moved through the
guard the order is refused with `409 CONFLICT` before any wallet
or persistence work — a price shown earlier is never silently replaced by a
worse one. Supplying the wrong side's guard is a `400` client bug. Omitted,
the order executes at whatever fresh price the response then reports.

### Order flow and atomicity

A buy/sell runs as **one database transaction**: the debit leg, the credit leg
(both via `WalletService`, passing the transaction client through a
backward-compatible optional parameter — the only Module 03 change this module
required) and the `usdt_orders` insert commit together or not at all. A row
therefore exists *if and only if* both balance legs moved, and a failure can
never leave a customer paid without their asset.

- **Insufficient balance** → `409 INSUFFICIENT_BALANCE`, transaction rolled
  back, no order row, no ledger row.
- **Frozen wallet** → `409 WALLET_FROZEN`. **No wallet** → `404`.
- **No live pricing** → `503 PRICING_UNAVAILABLE`, nothing settled (see the
  execution policy above).
- **Breached price guard** → `409 CONFLICT`, nothing settled.
- **Concurrency** is the database's job, exactly as in Module 03: each leg is a
  guarded `UPDATE ... WHERE available >= amount`, so two racing buys that share
  one balance settle exactly one (asserted in `test/usdt.e2e-spec.ts`).
- **Idempotency is a key, not a flag**: `(user_id, client_request_id)` is
  unique. A replay returns the original order with `200` and moves nothing —
  even if it carries a different amount, and even if the market has since gone
  stale; a *racing* replay loses the insert, which rolls its whole transaction
  back, so the balance legs apply once across both requests.

**There is no status or reject-reason column on `usdt_orders`.** Execution is
synchronous and atomic, so every stored row is by construction a settled order;
a validation, pricing or balance failure leaves no row at all. A second state
vocabulary would only describe a state no row can hold.

### Validation

- `usdtAmount` is a string, validated at the USDT scale (6 places) through
  Module 03's `normaliseAmount`: zero, negative, malformed and 7-place values
  are `400 VALIDATION_FAILED`.
- `clientRequestId` is a required UUID; unknown body/query properties are `400`
  (the global whitelist), never silently dropped.
- `maxExecutionPrice` / `minExecutionPrice` are optional positive decimal
  strings (max 8 places); the wrong side's guard is `400`.
- Orders are recorded with the executed snapshot prices, the inr amount, the
  signed savings, `placed_at` and `filled_at` (equal — settlement is
  synchronous), and the client request id.

### Pagination

`GET /api/usdt/orders` uses the same opaque keyset cursor as the wallet's
transaction history, keyed on `(placed_at, order_id)` descending: `limit`
defaults to 20 (max 100), and the returned `nextCursor` is passed back as
`?cursor=`. A malformed cursor is `400`, never a restart of the list.

### Tests

| Requirement (Module 08) | Covered by |
| --- | --- |
| Order-book VWAP quote (walk, depth, rounding) with full pricing provenance | `domain/usdt-pricing.spec.ts`, `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` (→ *quote calculation*) |
| Best-price guarantee: BUY capped at least ₹1.50 below the cheapest venue ask, SELL floored at least ₹1.50 above the best bid (margin is a floor, not a levy), paise rounding in the customer's favour, sanity-band abandonment, no-venue passthrough | `domain/usdt-pricing.spec.ts`, `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` |
| Three comparison venues on every quote, each published at its executable price next to the guarantee's bound | `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` (→ *quote calculation*) |
| Failed upstream fetch reuses the last good book/reference inside its window, labelled `execution_reused_last_good` / `reference_reused_last_good`, and refuses reuse past the window | `providers/live-usdt-pricing.provider.spec.ts`, `usdt-pricing.service.spec.ts` (→ *reused upstream readings*) |
| Venue executable price derived from each venue's spread, with the `last_price` fallback and its label | `domain/usdt-pricing.spec.ts`, `test/usdt.e2e-spec.ts` (→ *quote calculation*) |
| Savings sign (positive = the customer is better off than the reference), fractional exactness, HALF_UP edges | `usdt-pricing.spec.ts`, `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` (→ *savings calculation*) |
| Buy moves both legs and records the order with live snapshot prices | `test/usdt.e2e-spec.ts` (→ *buy*) |
| Sell moves both legs at the guaranteed price, above the reference | `test/usdt.e2e-spec.ts` (→ *sell*) |
| Price guards: breached → 409 CONFLICT, within → settles, wrong side → 400 | `test/usdt.e2e-spec.ts` (→ *price guards*) |
| Stale/down market → labelled fallback quote, 503 on execution, nothing settled | `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` (→ *live pricing policy*) |
| No fresh reference → live quote with `savings: null`, order refused 503 | `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` |
| Insufficient depth refuses to execute | `test/usdt.e2e-spec.ts` (→ *live pricing policy*) |
| Provider parsing: ms-vs-seconds timestamps, object-map book levels, staleness flags, malformed payloads | `providers/market-parsing.spec.ts`, `providers/coindcx-market-data.spec.ts`, `providers/coingecko-market-data.spec.ts` |
| Guarded fetch: timeout, HTTP status, non-JSON, header key transport | `providers/http-fetch.util.spec.ts` |
| Insufficient balance refuses with 409 and no side effects | `test/usdt.e2e-spec.ts` (→ *insufficient balance*) |
| Invalid / zero / negative / below-minimum-settlement amounts refused | `usdt-pricing.spec.ts`, `test/usdt.e2e-spec.ts` |
| Order lifecycle (newest-first listing, keyset paging, isolation) | `test/usdt.e2e-spec.ts` (→ *order lifecycle*) |
| Atomic state update (racing buys, racing replays, rollback) | `test/usdt.e2e-spec.ts` (→ *atomic state update*) |
| Idempotent replay cannot double-spend and never re-prices | `test/usdt.e2e-spec.ts` (→ *idempotent replay*, *live pricing policy*) |

Run them with `npm run test:usdt` (e2e) and `npx jest src/modules/usdt`
(unit).

---

## Liquidity & Order Processing (Module 09)

Simulated liquidity providers (LPs) that fund customer BUY orders on the
Module 08 exchange. Everything here is prototype-simulated: LPs are ordinary
users who pledge USDT from their own wallet under an EMBER lock, and every
"market-making" leg is a real Module 03 balance movement through
`WalletService` — never a mint, never a shortcut. There is no external LP
integration, no real order flow, and no frontend yet; the module is
backend-only by approval.

The module adds five tables and six authenticated endpoints, and edits one
Module 08 behaviour: a funded BUY's response carries a `liquidity` block
describing which commitments paid for it.

### Tables

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `liquidity_providers` | One LP registration per user | unique `user_id`, status `ACTIVE` \| `SUSPENDED` |
| `liquidity_commitments` | The LP's single USDT pledge and its EMBER lock | one per LP (unique `lp_id`), `usdt_consumed` never withdrawable, `client_request_id` for idempotent create/increase replay, index `(status, committed_at)` |
| `liquidity_allocations` | One row per order slice: which commitment funded which BUY, at what price | FK → `usdt_orders` `RESTRICT`, unique `(order_id, commitment_id)` |
| `liquidity_commitment_reductions` | Idempotency ledger for withdrawals | unique `(commitment_id, client_request_id)` |
| `liquidity_top_up_requests` | Shortfall notices opened by the overview | at most one `OPEN` at a time (application-enforced under an advisory lock) |

No table carries a frozen `id`/`created_at`/`updated_at` triple: event
timestamps are named (`committed_at`, `allocated_at`, `opened_at`, …), money is
`NUMERIC(38,18)`, and `liquidity_allocations.order_id` is a real foreign key —
an allocation exists if and only if the order it funded committed.

### Commitments, slabs and the EMBER lock

Opening a commitment auto-registers the caller as an LP (upsert, so concurrent
first-requests cannot double-register), pledges USDT from their wallet, and
locks EMBER against the **flat-cliff slab** requirement: the configured
`LIQUIDITY_EMBER_SLABS` list of `{ minUsdt, requiredEmber }` thresholds; the
lock for a commitment is the `requiredEmber` of the highest slab the total
pledge reaches, held in full. Increases lock only the delta; reductions
recompute the requirement and unlock only the surplus, so consumed liquidity
(never withdrawable) keeps its share of the lock until the commitment closes.
Closing to zero releases the lock entirely, with no time locks and no
penalties.

**Ember slab thresholds (approved 2026-10-18).** The configured
`LIQUIDITY_EMBER_SLABS` flat-cliff table is:

| Slab (`minUsdt`) | EMBER lock (`requiredEmber`) |
| --- | --- |
| 0 | 1,000 |
| 100,000 | 20,000 |
| 250,000 | 45,000 |
| 500,000 | 80,000 |

The zero-floor slab means any positive pledge qualifies, so commitments work
out of the box with the shipped `.env.example` value. `LIQUIDITY_EMBER_SLABS`
left unset is the off-switch: create and reduce then answer `503`
(`liquidity_ember_slabs_not_configured`) rather than accepting a commitment
they cannot gate, and reads (`commitments/me`, `overview`, `topups`,
`allocations`) always work and report `commitmentsEnabled: false`. The e2e
suites exercise exactly this approved table through a labelled TEST-only
fixture (`test/liquidity-test-fixture.ts`), so the tested behaviour and the
deployed behaviour are the same numbers. A pledge below the lowest configured
slab is `400` — the server never invents a zero lock.

`LIQUIDITY_MIN_AVAILABLE_USDT` (default `200000`) is the shortfall threshold
used by the overview: detection only, it moves no funds and names no LP.

### BUY allocation

`UsdtService.place` calls `LiquidityAllocationService.allocateBuy` **inside the
order's own transaction**, after the customer's legs and the order row (its
`order_id` is a foreign key) and before commit:

- **Legacy fallback.** Zero `liquidity_providers` rows → the call is a no-op
  and the BUY settles exactly as Module 08 always did (minted USDT). This is
  the world until the first LP registers.
- **Mandatory once any provider exists.** Eligible liquidity (commitments with
  `usdt_available > 0` whose provider is `ACTIVE`) short of the order is
  `409 INSUFFICIENT_LIQUIDITY` with details `requested_usdt:X` /
  `available_usdt:Y`; the whole order — customer legs included — rolls back.
  There are no partial fills.
- **Oldest first.** Slices are planned deterministically:
  `committed_at ASC, commitment_id ASC`, guarded at application time with
  `UPDATE … WHERE usdt_available >= slice`, so a concurrent order that
  consumed the liquidity between plan and apply cannot produce a
  half-allocated order.
- **Conservation.** LP USDT debits sum to the order volume; LP INR credits sum
  to the customer's debit exactly — non-final slices floor to whole paisa and
  the final slice absorbs the remainder — so the ledger adds up with no
  rounding drift. Every leg carries a citable note (`Liquidity outflow order
  …` / `Liquidity inflow order …`).

SELL never touches liquidity. A funded BUY's response carries the block:

```json
"liquidity": {
  "slices": [{ "commitmentId": "…", "lpId": "…", "usdtAmount": "1000.000000", "inrAmount": "100100.00", "priceInr": "100.10" }],
  "totalUsdt": "1000.000000",
  "totalInr": "100100.00"
}
```

Omitted on SELL, replays, history pages and legacy orders. The same slices are
readable later through `GET /api/liquidity/allocations/:orderId` — the caller
must own the order, and anyone else's id is a `404`, never a disclosure.

### Concurrency

Commitment writes serialize per user through a Postgres advisory lock
(`pg_advisory_xact_lock` on `liquidity_commitment:<userId>`), and top-up
notice upkeep through `liquidity_topup`. Combined with the guarded commitment
updates and Module 03's guarded balance legs, two racing BUYs that share the
last liquidity settle exactly one (asserted end to end).

### Endpoints

All six require a bearer token; the caller is always `@CurrentUser`, so no
route can read or mutate another LP's commitment, and the allocations route
only ever exposes the caller's own orders.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/liquidity/commitments` | Body `{ clientRequestId, usdtAmount }`. Auto-registers the caller, pledges USDT and locks the slab delta. `201` on first create, `200` on increase or idempotent replay (same `clientRequestId` stored on the row). `503` only when slabs are unset (the off-switch); below the lowest slab is `400`. |
| `POST` | `/api/liquidity/commitments/reduce` | Body `{ commitmentId, usdtAmount, clientRequestId }`. Withdraws down to what orders consumed; recomputes the EMBER lock and unlocks only the surplus; closing to zero releases the lock entirely. Idempotent on `(commitmentId, clientRequestId)`. `201` on first application, `200` on replay. |
| `GET` | `/api/liquidity/commitments/me` | The caller's provider row and commitment (both `null` until first commit), plus `commitmentsEnabled`. |
| `GET` | `/api/liquidity/overview` | Aggregate `usdt_available` across ACTIVE commitments of ACTIVE providers against the threshold; opens at most one `OPEN` shortfall notice below it, fulfils it once liquidity recovers. Detection moves no funds. |
| `GET` | `/api/liquidity/topups` | The 100 most recent shortfall notices, newest opened first. |
| `GET` | `/api/liquidity/allocations/:orderId` | The caller's own order's allocation slices, oldest first. Another user's id is `404`. |

### Demo LP seed

`npm run seed:liquidity` (idempotent) provisions three clearly-labelled
**simulated** LPs (150k/300k/600k USDT pledges) so a development browser can
trade against a funded pool. It only funds wallets and pledges commitments —
it moves no customer money — and it does nothing unless slabs are configured.

### Tests

| Requirement (Module 09) | Covered by |
| --- | --- |
| Wallet `lock`/`unlock` accept an optional transaction client | `wallet.service.spec.ts` |
| Slab parsing, flat-cliff lock, lock delta (incl. zero-delta and below-lowest-slab) | `domain/ember-slabs.spec.ts` |
| Oldest-first allocation planning, zero-slice filtering, total shortfall | `domain/allocation.spec.ts` |
| Create/reduce refuse 503 without slabs, before touching the database | `liquidity.service.spec.ts` |
| Legacy no-op when no providers exist; plan-time and guard-time 409s roll the order back whole | `liquidity-allocation.service.spec.ts`, `test/liquidity.e2e-spec.ts` (→ *legacy behaviour*, *allocation of customer BUY orders*) |
| Auto-registration, slab lock, idempotent first-create replay, per-caller `commitments/me` | `test/liquidity.e2e-spec.ts` (→ *commitment registration*) |
| Single-slice and spanning allocation; LP wallet legs; allocations endpoint with owner-only access | `test/liquidity.e2e-spec.ts` (→ *allocation of customer BUY orders*) |
| Racing BUYs on the last liquidity settle exactly one; starvation refuses with `INSUFFICIENT_LIQUIDITY` and moves nothing | `test/liquidity.e2e-spec.ts` |
| Shortfall notice: at most one OPEN, reused on re-read, fulfilled on recovery | `test/liquidity.e2e-spec.ts` (→ *overview and top-up notices*) |
| Reductions: close-and-release, replay, over-reduce refusal, slab-crossing surplus unlock, floor-at-consumed | `test/liquidity.e2e-spec.ts` (→ *commitment reductions*) |
| SELL never touches liquidity | `test/liquidity.e2e-spec.ts`, `test/usdt.e2e-spec.ts` (→ *liquidity funding*) |
| Funded BUY carries a `liquidity` block summing to the order; suspended provider → 409 | `test/usdt.e2e-spec.ts` (→ *liquidity funding (Module 09)*) |

Run them with `npm run test:liquidity` and `npm run test:usdt` (e2e) and
`npx jest src/modules/liquidity` (unit). The e2e config runs files serially
(`maxWorkers: 1`) because Module 09 makes BUY eligibility depend on global
`liquidity_providers` rows: each liquidity-touching suite resets the Module 09
tables in `beforeAll` and purges them in `afterAll`, which is only complete
isolation when one file runs at a time.

---

## EMBER Token Accounting (Module 10)

Two responsibilities, both built on Module 03's accounting boundary — the
`WalletService` remains the only code that moves a balance, and this module
adds no second ledger and no supply table.

### Tables

| Table | Purpose |
| --- | --- |
| `ember_transfers` | One row per successful transfer: `transfer_id` (surrogate), `sender_user_id`, `recipient_user_id`, `amount`, `client_request_id`, `transferred_at`. Unique on `(sender_user_id, client_request_id)` — idempotency is a key, not a flag. Two descending indexes serve per-side history. Both user relations are `Restrict`, so a transfer with history cannot be orphaned by deleting either party. |

The wallet, balance and `transactions` tables are unchanged; every transfer
also writes its two legs there (`TRANSFER_OUT` on the sender, `TRANSFER_IN`
on the recipient).

### Transfers

`POST /api/ember/transfers` moves EMBER from the caller to the recipient
named by their **registered email** (unique on `users`; the lookup normalises
case the same way auth stores it). One database transaction:

1. `debit` the sender with `TRANSFER_OUT` — refused unless the **available**
   balance covers the amount, so locked EMBER (which lives in the locked
   column) is unspendable by construction;
2. `credit` the recipient with `TRANSFER_IN` — provisioning their wallet
   lazily on first receipt, exactly as Module 03 provisions the caller's own;
3. insert the `ember_transfers` row, claiming the idempotency key.

All three commit or none do — the legs-first, key-second order is Module 08's.
A frozen recipient wallet fails step 2 and rolls the sender's debit back.

Refusals: `404 NOT_FOUND` for an unknown recipient email, `400
VALIDATION_FAILED` for a self-transfer or a non-positive amount, `409
INSUFFICIENT_BALANCE` when the available column cannot fund it, `409
WALLET_FROZEN` when either wallet is frozen, `409 CONFLICT` on a reused key
(see below). There are **no transfer fees**: the debit and credit are the same
number.

### Idempotency

`(senderUserId, clientRequestId)` is unique. On a replay the original row is
found, its payload compared (same recipient, same amount) and returned
**without touching a balance** — `200` instead of `201`, same `transferId`.
The same key describing a *different* transfer is `409 CONFLICT` rather than a
silent lie. Two racing requests with one key both start; the loser's insert
fails on the unique constraint, its whole transaction rolls back, and the
winner is re-read — so balances apply exactly once across both. Keys are
scoped per sender: two users may present the same `clientRequestId`.

### Supply

`GET /api/ember/supply` aggregates figures from existing accounting records
(`transactions` groupBy type, `wallet_balances` aggregate); nothing is stored
and nothing invented:

| Figure | Definition |
| --- | --- |
| `totalIssuedSupply` | `SUM(DEPOSIT) − SUM(WITHDRAWAL)` for EMBER. Exact because `TRANSFER_IN`/`OUT` net to zero across wallets and `LOCK`/`UNLOCK` only move value between the two columns of one balance — neither issues nor destroys. |
| `burnedSupply` | `SUM(BURN)` over EMBER ledger legs — one leg per Module 11 burn record, written in the same transaction as the record so the two cannot diverge. Zero while no burns are recorded; nothing else in the vocabulary destroys EMBER. |
| `circulatingSupply` | `totalIssued − burned`, i.e. equal to issued while no burns are recorded. |
| `lockedSupply` | `SUM(locked)` over all wallet balances — **includes Module 09 LP commitment locks**. |
| `availableSupply` | `SUM(available)` over all wallet balances. |

Application-level ledger figures, not on-chain supply. The reconciliation
`available + locked = circulating = issued − burned` holds by construction (see
limitation 24 for the one row type that would break it).

### Deliberately absent

Per the module's scope: **no staking, no APY, no rewards, no minting, no
burning, no new issuance, and no public lock/unlock endpoint.** Locking
remains Module 09's internal `WalletService` path; this module only respects
it (debits cannot spend locked value) and reports it (`lockedSupply` includes
LP locks). Module 09's approved slabs, commitment logic and endpoints are
untouched — the e2e suite registers a real commitment to prove it.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/ember/transfers` | Body `{ recipientEmail, amount, clientRequestId }`. `201` on create, `200` on idempotent replay of the identical payload. Response is `{ transferId, amount, transferredAt }` — no counterparty user or wallet ids. |
| `GET` | `/api/ember/supply` | The five ledger-derived figures above, each an 18-place decimal string. |

### Tests

| Requirement (Module 10) | Covered by |
| --- | --- |
| Refusals before any write: unknown recipient, self-transfer, zero/negative amount | `ember.service.spec.ts`, `test/ember.e2e-spec.ts` (→ *authentication and request validation*) |
| Replay returns the original without moving a balance; amount and recipient conflicts; per-sender key scoping | `ember.service.spec.ts`, `test/ember.e2e-spec.ts` (→ *idempotency*) |
| Legs-first transaction: `TRANSFER_OUT` + `TRANSFER_IN`, one row, response leaks no counterparty ids | `test/ember.e2e-spec.ts` (→ *moving EMBER*) |
| Locked EMBER is unspendable; the available remainder still transfers and the lock is untouched | `test/ember.e2e-spec.ts` (→ *moving EMBER*) |
| Lost unique race returns the winner; a differently-payloaded loser is refused | `ember.service.spec.ts` |
| Two racing identical requests settle on exactly one transfer; two different keys over one balance let exactly one win and never go negative | `test/ember.e2e-spec.ts` (→ *idempotency*) |
| Frozen recipient wallet rolls the sender's debit back: balance unchanged, no transfer row | `test/ember.e2e-spec.ts` (→ *idempotency*) |
| Lazy recipient-wallet provisioning; mixed-case recipient email resolves | `test/ember.e2e-spec.ts` (→ *moving EMBER*) |
| Supply arithmetic: issued = deposits − withdrawals, transfers/locks are movement only, burned derives from BURN legs (zero with none), deltas not absolutes | `ember.service.spec.ts`, `test/ember.e2e-spec.ts` (→ *ledger-derived figures*) |
| Module 09 LP locks appear in `lockedSupply`, are not spendable, and a transfer leaves the commitment untouched | `test/ember.e2e-spec.ts` (→ *ledger-derived figures*) |
| Shared-ledger reconciliation: circulating = issued, available + locked = circulating | `test/ember.e2e-spec.ts` (→ *ledger-derived figures*) |
| 401 without a token on both routes; body validation (email, string amount, UUID key) | `test/ember.e2e-spec.ts` (→ *authentication and request validation*) |

Run them with `npx jest src/modules/ember` (unit) and
`npm run test:e2e -- --testPathPatterns ember`.

---

## EMBER Tokenomics (Module 11)

Three responsibilities, all built on Module 03's accounting boundary — the
`WalletService` remains the only code that moves a balance, this module adds no
second ledger and no supply table, and the supply endpoint stays Module 10's.
The reference amount is an **illustrative reference-price metric** (the module's
₹80,000 worked example) — never cash, never funding. Nothing here mints,
issues, stakes or rewards EMBER.

### Configuration

| Env | Default | Rule |
| --- | --- | --- |
| `TOKENOMICS_DIRECT_BURN_PCT` | `60` | Integer 0–100. |
| `TOKENOMICS_BUYBACK_PCT` | `40` | Integer 0–100. |

Both are validated at boot (`TokenomicsConfig`): non-integers, out-of-range
values or a sum other than 100 throw before the app starts, so the split cannot
drift into nonsense at runtime. `GET /api/tokenomics/config` reports the
resolved values; every record freezes the percentages it was computed under.

### Tables

| Table | Purpose |
| --- | --- |
| `token_allocations` | One row per recorded split: `allocation_id` (surrogate), `user_id`, `reference_amount` (2dp), `ember_price` (18dp), the frozen `direct_burn_pct`/`buyback_pct`, both portions (`direct_burn_inr`, `buyback_inr`), both floored quantities, `client_request_id`, `allocated_at`. Unique on `(user_id, client_request_id)`. |
| `token_buybacks` | One row per simulated buyback: `buyback_id`, `user_id`, `allocation_id`, `buyback_inr`, the allocation's `ember_price`, `ember_quantity`, `status` (`SIMULATED` → `RECORDED_SIMULATED_EXECUTION`), nullable `executed_price`/`executed_ember`/`executed_at`, `simulated_at`, `client_request_id`. Unique on `(user_id, client_request_id)` **and** on `allocation_id` — one buyback per allocation. |
| `token_burns` | One row per burn: `burn_id`, `user_id`, `source` (`DIRECT` \| `BUYBACK`), nullable `buyback_id`, `amount`, `client_request_id`, `burned_at`. Unique on `(user_id, client_request_id)` **and** on `buyback_id` — a buyback is burned at most once. |

All three use surrogate UUID keys (no `id`/`created_at`/`updated_at` columns),
`Decimal(38,18)` for money/quantity columns and `Restrict` relations, so a
record with history cannot be orphaned by deleting its owner. The wallet
`transactions` table is unchanged; each burn additionally writes its `BURN`
leg there.

### The split

Inputs are validated, never rounded: reference amounts are positive with at
most 2dp, prices positive with at most 18dp, amounts positive at 18dp. The
direct portion is the reference amount × `directBurnPct%` rounded **half-up to
2dp**; the buyback portion is the **exact remainder**, so both portions always
sum to the reference amount at every scale. Quantities are portions ÷ price,
divided at 60 significant digits and **floored to 18dp**, so the recorded EMBER
never exceeds what its portion funds at that price.

### Preview (computation only)

`POST /api/tokenomics/preview` runs exactly the arithmetic a record would run
and returns it — `200`, no row written, no state touched. The frontend's split
calculator posts here; a record exists only when the user asks for one.

### Allocations

`POST /api/tokenomics/allocations` persists the split (frozen percentages,
portions, quantities, price) and moves nothing. `201` on create, `200` on an
idempotent replay of the identical payload.

### Simulated buybacks — two stages, neither moving anything

1. `POST /api/tokenomics/buybacks` proposes the buyback of an owned allocation
   (`SIMULATED`). One buyback per allocation — the second is `409 CONFLICT`
   even under a fresh key.
2. `POST /api/tokenomics/buybacks/:buybackId/execute` records the simulated
   execution at an illustrative price: status
   `RECORDED_SIMULATED_EXECUTION`, `executed_price`/`executed_ember`/`executed_at`
   written. **No market order is ever placed** — execution is recorded, not
   performed; actual buyback execution is deliberately not a state.

The execute route is one-way: a guarded `updateMany` on
`status = SIMULATED` is its idempotency. Replaying the same price returns the
original record `200`; a different price is `409 CONFLICT` and never
overwrites; a losing race re-reads the winner. A price at which the buyback
portion floors to a quantity of zero is `400` rather than a burnable record of
nothing; a non-UUID parameter is `400`. **Neither stage moves any balance or
any supply** — a buyback without a burn changes nothing.

### Burns — the only operation that destroys EMBER

`POST /api/tokenomics/burns` with `source`:

| Source | Requires | Refuses with |
| --- | --- | --- |
| `DIRECT` | `amount` (18dp); `buybackId` must be absent | `400` for a stated `buybackId` or a missing/zero/negative amount |
| `BUYBACK` | `buybackId` of an owned, executed, never-burned buyback; `amount` must be absent (the burned quantity **is** `executedEmber`, exactly) | `400` for a stated amount or missing id, `404` for unknown/foreign, `409 CONFLICT` before execution is recorded or when already burned |

The treasury (`treasury@prometheus.local`, Module 09's auto-register pattern)
is provisioned lazily on the first burn attempt and is **funded only by tests
and seeds** — there is no API that credits it. One database transaction:

1. `debit` the treasury's available EMBER with a `BURN` ledger leg
   (`note: "EMBER burn <burnId>"`) — refused `409 INSUFFICIENT_BALANCE`
   unless the available column covers the amount, writing no record;
2. insert the `token_burns` row, claiming the idempotency key (and the
   `buybackId` uniqueness for BUYBACK burns).

Both commit or none do — legs-first, record-second, the same order Module 10
transfers use. A refused burn writes nothing at all.

### Idempotency

Each table is unique on `(user_id, client_request_id)` and keys are **scoped
per caller**: two users may present the same `clientRequestId`. The service
pre-checks the key, then catches the unique violation in the transaction
(everything rolls back), and either replays the original (`200`, same
surrogate id, payload compared — a differently-payloaded loser is `409
CONFLICT`) or, for an unused key, reports the state conflict it collided with
(already burned / one-buyback-per-allocation). Racing identical requests settle
on exactly one record and one debit. Unknown or foreign ids are `404`, never
`403` — Module 05's posture.

### Supply reconciliation

Supply is read from Module 10's `GET /api/ember/supply` — this module adds no
supply route. Three views must agree, and the e2e proves it:

| View | Source |
| --- | --- |
| `burnedSupply` | `SUM(BURN)` over the ledger (the approved Module 10 calculation) |
| Burn records | `SUM(token_burns.amount)` |
| Record count | one `token_burns` row and one `BURN` leg per burn, same transaction |

The e2e additionally re-asserts `available + locked = circulating` after burns.
Buybacks change none of these until burned; a BUYBACK burn's amount equals its
execution's quantity and is counted exactly once.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tokenomics/config` | The resolved split `{ directBurnPct, buybackPct }`. |
| `POST` | `/api/tokenomics/preview` | Body `{ referenceAmount, emberPrice }` → the computed split incl. `potentialBurnEmber`. Persists nothing. |
| `POST` | `/api/tokenomics/allocations` | Record the split. `201` create / `200` replay. |
| `POST` | `/api/tokenomics/buybacks` | Propose a SIMULATED buyback. `201` / `200`. |
| `POST` | `/api/tokenomics/buybacks/:buybackId/execute` | Record the simulated execution. `201` / `200`. |
| `POST` | `/api/tokenomics/burns` | Record a burn (`source: DIRECT` + `amount`, or `source: BUYBACK` + `buybackId`). `201` / `200`. |
| `GET` | `/api/tokenomics/records` | The caller's own allocations, buybacks and burns — 50 newest per type. |

All routes require a bearer token (401 without one); responses reuse the
existing error vocabulary (`VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`,
`INSUFFICIENT_BALANCE`, `ASSET_INACTIVE`). Supply reads stay on
`GET /api/ember/supply`.

### Frontend

`app/tokenomics/page.tsx` is a real page: configured split (SVG donut),
ledger-derived supply cards, a server-side preview calculator, and
record/replay actions for all three record types — every figure comes from the
BFF, nothing is fabricated, and empty/loading/error states are explicit.
"Record" actions pin a `clientRequestId` until success so a retry replays
instead of duplicating. `app/ember/page.tsx` re-exports the same page, so the
`/ember` alias keeps working. Illustrative/simulated labels and the module's
limitations are on the page itself.

### Tests

| Requirement (Module 11) | Covered by |
| --- | --- |
| 60/40 split of the ₹80,000 worked example; portions sum to the reference at every scale; configurable 70/30 and 80/20 | `domain/allocation-math.spec.ts`, `tokenomics.e2e-spec.ts` (→ *preview*) |
| Different prices derive different quantities; 18dp flooring at 60-digit precision; 2dp INR boundary | `domain/allocation-math.spec.ts`, `tokenomics.e2e-spec.ts` (→ *preview*) |
| Zero/negative/over-precision inputs refused, before any write | `domain/allocation-math.spec.ts`, `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` (→ *preview* / *validation*) |
| Config percentages that do not sum to 100 or are non-integer/ out of range refuse at boot | `app.config.spec.ts` |
| Preview agrees exactly with the record it would write; preview persists nothing | `tokenomics.e2e-spec.ts` (→ *preview*) |
| Allocation create + idempotent replay; payload-conflict; per-caller key scoping; lost race replays the winner | `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` (→ *allocations*) |
| Buyback lifecycle: proposal → execution, supply and balances unchanged at both stages (buyback-without-burn) | `tokenomics.e2e-spec.ts` (→ *simulated buybacks*) |
| Execute idempotency: same price 200, different price 409, race has exactly one winner, zero-floor quantity 400 | `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` (→ *simulated buybacks*) |
| One buyback per allocation; one burn per buyback; replay and race settle on one record/one debit | `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` |
| DIRECT burn: one BURN leg + one record in one transaction, supply down exactly once; insufficient treasury refuses with nothing written (atomic rollback) | `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` (→ *burns*) |
| BUYBACK burn: exactly the executed quantity, no stated amount, burned once; burn before execution refused 409 | `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` (→ *burns*) |
| Treasury auto-provisioned on first burn, never funded by any API | `tokenomics.service.spec.ts`, `tokenomics.e2e-spec.ts` (→ *burns*) |
| Three-way supply reconciliation: ledger `SUM(BURN)` = `token_burns` sum = records; `available + locked = circulating` | `tokenomics.e2e-spec.ts` (→ *burns*) |
| Simulated vs actual separation (no market movement) and no minting/staking/rewards | `tokenomics.e2e-spec.ts`, plus the documented scope |
| Per-caller records, newest first; foreign/unknown ids 404 never 403; 401 on every route without a token | `tokenomics.e2e-spec.ts` (→ *records*, *authentication*) |
| Module 10 regression: burned figure derives from BURN legs; Module 03/04 fallout (BURN activity type) | `ember.service.spec.ts`, `portfolio.service.spec.ts`, `test/portfolio.e2e-spec.ts`, `test/ember.e2e-spec.ts` |

Run them with `npx jest src/modules/tokenomics` (unit) and
`npm run test:tokenomics` (e2e).

### Deliberately absent / limitations

- **Actual buyback execution is not implemented.** Buybacks are records of a
  simulated lifecycle (proposal, recorded simulated execution); no market
  order, settlement or treasury spend exists, by design for this module.
- No minting, issuance, staking or rewards of any kind — burns are the only
  supply-reducing operation.
- The `GET /records` listing is bounded at the 50 newest rows per type — no
  cursor pagination yet.
- No RBAC layer: every authenticated caller manages only their own records
  (keys are per-user, foreign ids are 404).
- Treasury guardrails, funding flows and the tokenomics dashboard are the
  **next module** (12); the treasury is provisioned here but only tests and
  seeds can fund it.

---

## Treasury Guardrails & Dashboard (Module 12)

The platform treasury's read-only balance/health API, the owner-approved 30%
EMBER reserve floor over cumulative qualifying treasury funding (enforced
atomically inside Module 11's burn transaction), the demo ₹30 crore monthly
USDT capacity with a display-only conversion, and the dashboard at `/treasury`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TREASURY_MONTHLY_CAPACITY_INR` | `300000000` | Approved demo monthly capacity for the platform treasury, in INR (₹30 crore). Converted to a USDT display ceiling at `USDT_FALLBACK_PRICE_INR` and reported as `capacityInr` / `capacity` / `remaining`; tracking is reporting-only and blocks nothing. Unset/invalid falls back to the default. |
| `USDT_FALLBACK_PRICE_INR` | `99.90` | Display-only INR-per-USDT fallback used solely for the summary's capacity conversion. Never a market rate, never used for pricing, quoting or settlement, and never invented when absent (the conversion reports `CONVERSION_RATE_UNAVAILABLE`). |

The 30% reserve percentage and its calculation base are policy constants in
`treasury-policy.ts` (owner-approved round-2 decision), not environment
configuration: a configurable percentage or base would let the protected floor
be silently redefined outside review.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/treasury/summary` | The whole snapshot: treasury account/wallet state, EMBER and USDT balances, lifetime EMBER inflows (informational), the computed reserve policy block, USDT capacity tracking with its conversion source, and platform-wide recorded burn/buyback/allocation counts. Auth required (global guard); answers 401 without a token. Writes nothing. |
| `POST` | `/api/tokenomics/burns` (Module 11) | The one write path the reserve guard protects: a discretionary EMBER burn is refused atomically (409 `TREASURY_RESERVE_BREACH`) when it would project the treasury below the protected floor, before any debit or record is written. |

### The reserve policy (computed, enforced)

- **Base**: cumulative qualifying EMBER funding of the treasury wallet -
  `DEPOSIT` ledger legs with `status: COMPLETED`, aggregated with
  `Prisma.Decimal` at 60-digit precision (`reserveFloor` = base x 30 / 100).
  `emberLifetimeFundedIn` remains the broader `DEPOSIT` + `TRANSFER_IN`
  informational history and is explicitly **not** the base.
- **Floor state** (`reserve.status`): `UNPROVISIONED` (no treasury account),
  `OK` (available - requested >= floor), `AT_FLOOR` (exactly on the floor),
  `BELOW_FLOOR` (the treasury's own available balance is under the floor).
  `discretionaryCapacity` = available - floor, floored at zero.
- **Enforcement** (`TreasuryReserveGuard`, called inside Module 11's
  `createBurn` transaction before the debit): a transaction-scoped
  `pg_advisory_xact_lock` serialises concurrent burns per treasury wallet;
  the projected balance (`available - amount`) is compared to the floor;
  a breach throws `DomainException.treasuryReserveBreach` -> 409
  `TREASURY_RESERVE_BREACH` with details `reserve_floor`, `treasury_available`
  and `requested`. Nothing is written on refusal (atomic rollback of the
  Module 11 transaction).
- **Precedence**: the guard runs after the existing balance check inside
  `createBurn`, so `INSUFFICIENT_BALANCE` retains precedence when the
  treasury simply lacks the amount; the frozen Module 11 e2e suite passes
  unmodified.
- **Funding is never blocked**: the guard only gates discretionary debits;
  any qualifying deposit restores capacity and the floor together.

### The summary's honesty contract

- `reserve` reports the computed policy: `floorPercent: 30`,
  `floorBase: "QUALIFYING_TREASURY_FUNDING"`, `floorBaseAmount`,
  `floorAmount`, `discretionaryCapacity` and the floor-relative `status`.
- `usdtCapacity` reports `capacityInr` (₹30 crore demo), the USDT
  `capacity`/`remaining` converted at the display-only fallback, the
  `conversion` source (`USDT_FALLBACK_PRICE_INR`, or
  `CONVERSION_RATE_UNAVAILABLE` when no rate is configured) and
  `exhaustion` (`AVAILABLE`/`EXHAUSTED`/`UNAVAILABLE`/`NOT_CONFIGURED`).
  It is **reporting-only**: no treasury USDT spending operation enforces
  it, so the response never claims spending is blocked.
- `usdtCapacity.utilization` sums `WITHDRAWAL` + `TRANSFER_OUT` USDT legs on
  the **treasury wallet only** (`status: COMPLETED`) within the current UTC
  calendar month (reported as `YYYY-MM` with `timezone: "UTC"`). Individual
  users' transactions can never contribute: the aggregate is scoped by the
  treasury `walletId`.
- `activity` holds **record** aggregates over Module 11's tables
  (`token_burns` / `token_buybacks` / `token_allocations`, all callers). That
  is a read-model count for display - Module 04's cross-module-read precedent -
  never a supply calculation: Module 10 owns supply, and Module 11's own
  `GET /tokenomics/records` remains the per-caller view.

### Frontend

`/treasury` (additive AppShell entry "Treasury Guardrails") composes
`GET /treasury/summary` with Module 10's public `GET /ember/supply` - supply
figures come from Module 10's own endpoint because `EmberModule` does not
export its service and Module 10 stays frozen. `/tokenomics` and `/ember`
behavior is untouched. The page reads, refreshes and labels limitations; it
computes no financial value and offers no mutating action.

### Tests

| Guarantee | Tests | Where |
| --- | --- | --- |
| Policy arithmetic: floor, projected balance, discretionary capacity, floor-relative status, INR->USDT conversion (exact decimal strings), null-price conversion fallback | 15 | `treasury-policy.spec.ts` |
| Guard: advisory-lock SQL, qualifying-basis aggregation, insufficient-balance deferral, breach throw with exact details, no-read on unprovisioned | 9 | `treasury-reserve.guard.spec.ts` |
| UTC month window bounds and year-boundary label | 2 | `treasury.service.spec.ts` |
| Unprovisioned treasury: null blocks, zero utilization, no ledger query | 1 | `treasury.service.spec.ts` |
| Provisioned balances, funded-in legs, treasury-scoped utilization, computed reserve reporting | 4 | `treasury.service.spec.ts` |
| Capacity arithmetic in INR and converted USDT (Decimal remaining, never a default) | 2 | `treasury.service.spec.ts` |
| Activity aggregate mapping | 1 | `treasury.service.spec.ts` |
| M11 integration: guard called inside the burn transaction before the debit; a breach writes nothing | 2 | `tokenomics.service.spec.ts` |
| 401 unauthenticated; exact response key contract; unprovisioned reserve; zero-activity start-purge cross-check | 2 | `test/treasury.e2e-spec.ts` |
| Funded treasury: provisioned state, computed 30% floor, wallet `ACTIVE`, lifetime inflows | 1 | `test/treasury.e2e-spec.ts` |
| USDT utilization from treasury outflow legs only (a second user's outflows do not move it) | 1 | `test/treasury.e2e-spec.ts` |
| Summary mutates nothing (row snapshots identical around a read) | 1 | `test/treasury.e2e-spec.ts` |
| Sits on Module 11's real API without owning it; a DIRECT burn moves no USDT figure; burns never shrink the floor base (base is DEPOSIT-only) | 1 | `test/treasury.e2e-spec.ts` |
| Breach refused with 409 `TREASURY_RESERVE_BREACH` and zero side effects (no debit leg, no burn record) | 1 | `test/treasury.e2e-spec.ts` |
| At-the-floor burn is allowed exactly; the next (wei) burn is refused; funding restores capacity | 2 | `test/treasury.e2e-spec.ts` |
| `INSUFFICIENT_BALANCE` retains precedence over the reserve refusal | 1 | `test/treasury.e2e-spec.ts` |
| Concurrent burns serialise on the advisory lock - the floor can never be overdrawn | 1 | `test/treasury.e2e-spec.ts` |
| USDT capacity hits `EXHAUSTED` at the demo limit - reporting-only, nothing blocked | 1 | `test/treasury.e2e-spec.ts` |

Run in isolation with `npm run test:treasury` (e2e). Isolation: the suite
purges token tables, `BURN` legs and the treasury user at start **and** end -
the same footprint Module 11's suite purges - so a crashed run cannot leave
inflated activity counts here or absolute-zero-violating `BURN` legs for
Module 10, whichever order the serial e2e runner uses them in.

### Deliberately absent / limitations

- **No funding route**: no HTTP credit/mint endpoint exists; tests and seeds
  fund the treasury through `walletService.credit` only.
- **No mutations on the summary**: every read leaves balances, wallet status
  and supply byte-identical (proven in e2e); this module never sets `FROZEN`
  on any wallet, and individual users' wallets are out of scope for
  guardrails. Wallet status is deliberately not read for the floor this
  round - the guard checks balances, not status.
- **USDT capacity is reporting-only**: the ₹30 crore demo figure and its
  display-only conversion never block an operation, because no treasury USDT
  spending operation exists to enforce them.
- The summary is system state, not caller-scoped data: it contains no
  individual user's balances or transactions (utilization is treasury-scoped).

---

## RBAC & Profiles (Module 13)

Module 13 is cross-cutting: it adds no trading capability of its own and
changes no frozen contract. It decides *who may call what* — four roles
enforced server-side in front of every authenticated route — plus the
self-service and administrative flows that produce those roles, an append-only
audit trail of privileged actions, and each user's own profile with a one-time
onboarding and a financial-preference questionnaire.

Migration `20261021053538_add_rbac_profiles` adds two enums (`Role`,
`RoleRequestStatus`) and four tables (`user_roles`, `role_requests`,
`user_profiles`, `admin_audit_logs`), and backfills the `USER` baseline onto
every account that already existed.

### Roles

| Role | Meaning | How it is obtained |
| --- | --- | --- |
| `USER` | The baseline every account holds | Granted with the auth account on first login; **cannot be revoked** (400 `VALIDATION_FAILED`) |
| `EXPERT_TRADER` | Publishes and manages strategies | Self-request + admin approval, admin grant, or CLI |
| `LIQUIDITY_PROVIDER` | Manages EMBER liquidity commitments | Self-request + admin approval, admin grant, or CLI |
| `PLATFORM_ADMIN` | Operator: admin surface, treasury dashboard | **Configuration only** — listed in `PLATFORM_ADMIN_EMAILS` (granted at first use through the login funnel) or CLI (`npm run grant:role -- <email> PLATFORM_ADMIN`) |

Design rules, in the code rather than in a wiki:

- **Roles live in `user_roles`**, unique per `(user, role)`, so a re-grant is a
  no-op and a role can never exist twice. `granted_by` / `granted_at` record
  provenance; the row cascades away with its user.
- **`PLATFORM_ADMIN` has no HTTP *grant* path.** `GrantRoleDto` accepts only the
  two requestable roles (anything else → 400 `VALIDATION_FAILED`), and
  `RbacService.grantRole` refuses `PLATFORM_ADMIN` a second time as defence in
  depth, so a future controller cannot accidentally open it. Bootstrap and
  later admin grants run through `npm run grant:role -- <email> <ROLE>`
  (idempotent, exit 0/1) — a server-side process an operator runs, not an
  authenticated request. The one API path that can produce an admin row is the
  login funnel auto-approving an address that `PLATFORM_ADMIN_EMAILS` lists
  (configuration, not a person); a `PLATFORM_ADMIN` request from any other
  address is refused outright (403) and is **never queued** — the approval
  queue must never become the way an account becomes an admin, and
  `decideRequest` refuses to approve a stray admin request as defence in
  depth.
- **Only `EXPERT_TRADER` and `LIQUIDITY_PROVIDER` are requestable**
  (`REQUESTABLE_ROLES`); asking for `USER` through the request flow is a 400.
  `PLATFORM_ADMIN` passes validation so the *service* can answer it with the
  configuration-only refusal above instead of a generic validation error.
- **One privileged role per account.** An account that already holds an
  elevated role (`ELEVATED_ROLES` = EXPERT_TRADER, LIQUIDITY_PROVIDER,
  PLATFORM_ADMIN) may not acquire a different one: `GET /rbac/authorize`
  returns `authorized: false` with a `reason`, and `requestRole` throws 403
  FORBIDDEN, both carrying "…one Gmail address may hold only one privileged
  role. Try a different account for …". The check runs *before* the allowlist
  so the refusal names the real reason; `USER` never counts, and holding the
  requested role itself is the ordinary 409 conflict, not this rule.
- **Roles are resolved from the database on every request.** `AuthGuard` calls
  `resolveIdentity` per request and `loadRoles` reads `user_roles` into the
  `AuthContext` it attaches — no role claim is ever taken from the token, a
  header, the body or the query string, so a revoked role stops working
  immediately.

### Enforcement

`RolesGuard` is bound with `APP_GUARD` inside `RbacModule`, running after the
global `AuthGuard`. The decision, in order:

1. Unauthenticated → 401 (unchanged, Module 02).
2. Handler declares no `@Roles()` (or an empty list) → any authenticated
   caller passes. This is the pre-RBAC default, preserved so every frozen
   endpoint keeps its exact contract.
3. Handler declares `@Roles(...)` → the caller must hold at least one. There is
   no implicit bypass: `PLATFORM_ADMIN` gets no special case and must be listed
   explicitly (unit-tested). Denial is 403 `FORBIDDEN` with one generic message
   that never names the required role.

Routes gated today:

| Route | Required roles |
| --- | --- |
| `POST /api/strategies`, `GET /api/strategies/me`, `PATCH /api/strategies/:id` | `EXPERT_TRADER` or `PLATFORM_ADMIN` |
| `GET /api/treasury/summary` | `PLATFORM_ADMIN` |
| Every `/api/admin/*` route | `PLATFORM_ADMIN` |

Everything else (wallet, portfolio, risk, market/simulation, paper, copy,
USDT, liquidity, EMBER, tokenomics) remains reachable by any authenticated
caller — Module 13 gates where roles exist and deliberately does not
re-litigate frozen contracts.

**Known limitation (deliberate):** Module 11's tokenomics write routes are not
guarded server-side, because their contract is frozen; the tokenomics UI hides
record actions from non-admins. As with the admin UI, hiding is a convenience —
for those particular routes the backend boundary does not exist yet.

### Endpoints

Self-service (`/api/rbac`, any authenticated caller):

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/rbac/me` | `{ userId, roles, heldRoles, activeRole, requestable }` — `roles` is the session's `activeRole` (the `loginRole` claim) intersected with `heldRoles`: a strict intersection, so clicking one login card opens exactly that persona's surface and nothing else (`null` = every held role); `heldRoles` is the full grant set, `requestable` = the two requestable roles minus those **held** |
| `GET` | `/rbac/authorize?role=` | `{ role, authorized, reason? }` — allowlist answer for EXPERT/LIQUIDITY/PLATFORM_ADMIN (env-read at the backend), plus the one-privileged-role refusal as `reason` when the account already holds a different elevated role. `USER` and unknown roles answer `authorized: false` |
| `POST` | `/rbac/role-requests` | `{ role, note? }` → 201 `{ id }`. 400 if the role is not requestable and not `PLATFORM_ADMIN`; 409 if the role is already held or a PENDING request exists; 403 for the one-role rule or an admin request from an address `PLATFORM_ADMIN_EMAILS` does not list (never queued). Allowlisted addresses approve and grant inside one transaction |
| `GET` | `/rbac/role-requests/me` | Own history, newest first |

Administration (`/api/admin`, all `@Roles(PLATFORM_ADMIN)`):

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/admin/users` | Users with sorted role lists (max 500, newest first) |
| `POST` | `/admin/users/:id/roles` | Grant `EXPERT_TRADER` / `LIQUIDITY_PROVIDER` → 204 + audit row; `PLATFORM_ADMIN` or `USER` → 400 |
| `DELETE` | `/admin/users/:id/roles/:role` | Revoke → 204 + audit row; `USER` cannot be revoked (400); unknown role → 404 |
| `GET` | `/admin/role-requests?status=` | The decision queue (max 200, newest first) |
| `POST` | `/admin/role-requests/:id/decision` | `{ decision: 'APPROVED' \| 'REJECTED' }` → 204. Approval upserts the role, stamps `decided_by` / `decided_at` and writes the audit row in one transaction; already decided → 409, unknown id → 404 |
| `GET` | `/admin/audit-logs` | 200 most recent audit records, newest first, with actor email |

Profile (`/api/profile`, own row only):

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/profile/me` | Profile + questionnaire answers |
| `PUT` | `/profile/me` | Partial update of the same fields |
| `POST` | `/profile/me/onboarding/complete` | 200, idempotent, requires the core answers; sets `onboarding_completed_at`, which never returns to null |

There is deliberately **no cross-user profile endpoint** — a public expert
profile is a future feature and must not be pre-wired through this controller.

`GET /api/health` stays `@Public()` (the Module 00 operational probe); the
admin health page reads it inside a `RoleGate`, which is UI convenience only.

### Audit trail

Every admin API mutation — grant, revoke, approve, reject — writes one
`admin_audit_logs` row **inside the same transaction** as the state change, so
the authorization trail cannot drift from the state it describes. Fields:
acting user, verb-style action (`role.grant`, `role.revoke`,
`role_request.approve`, `role_request.reject`), optional target user, a small
structured `detail` (role names, request id — never secrets), and `created_at`
indexed descending. Financial mutations keep their own ledger rows; this table
is the authorization-and-intent trail beside them. The CLI writes `granted_by`
on the row it creates but no audit record — it has no authenticated actor — so
the audit trail covers exactly the HTTP admin surface.

`/admin/activity` renders this table and `/admin/health` renders dependency
health; neither mutates anything.

### Profile & onboarding (frontend)

`user_profiles` is 1:1 with the user and stores display preferences (display
name, country, display currency), experience and capital answers (experience
level, investment capital range, capital availability), the risk trio (risk
tolerance, drawdown comfort, volatility comfort), the goal set (primary goal,
time horizon, expected return range, holding period) and behaviour answers
(loss reaction, liquidity needs, contribution frequency). All of it is
self-reported preference data: **nothing in the trading or financial paths
consumes it** — it exists so onboarding and the preferences screen have
somewhere honest to put the answers.

- `/onboarding` — the questionnaire flow, completing via
  `POST /profile/me/onboarding/complete`.
- `/preferences` — re-editing the same answers later.

### Frontend surface

`RoleProvider` (root layout) fetches `/rbac/me` and `/profile/me` and exposes
`{ roles, heldRoles, activeRole, requestable, loading, error, isAdmin, isExpert,
isLiquidityProvider, hasRole, refresh }`. `roles` is the session-scoped set —
the account's roles narrowed to the persona it signed in as — so every gate
below follows the login intent automatically; `heldRoles` / `activeRole` are
the full grant set and the chosen persona, used where UI speaks about what the
account owns rather than what this session acts as. Consumers:

- `AppShell` — role-aware navigation through `visibleNavSections(roles)`:
  admin sees only the admin surface, expert/liquidity entries appear only for
  holders, and the pre-RBAC base set renders while the role fetch is in flight.
- `RoleGate` — wraps whole pages: `/admin`, `/admin/users`, `/admin/activity`,
  `/admin/health` and `/treasury` (`PLATFORM_ADMIN`); `/liquidity`
  (`LIQUIDITY_PROVIDER` or `PLATFORM_ADMIN`).
- `/discover` — open to everyone; the "My Strategies" tab and the
  create/manage affordances appear only for `EXPERT_TRADER` / `PLATFORM_ADMIN`.
- `/expert`, `/expert/strategies`, `/expert/strategies/new` — expert surfaces.
- Tokenomics write actions — hidden without `isAdmin` (limitation above).

Hiding navigation and pages is a convenience; every boundary above is enforced
again by `RolesGuard` on the server.

### Tests

| What | Count | File |
| --- | --- | --- |
| Guard semantics: no-decorator allow, empty-list allow, one-of match, no implicit `PLATFORM_ADMIN` bypass, listed-admin allow, generic 403, zero roles, missing `request.user`, handler+class metadata | 9 | `roles.guard.spec.ts` |
| Login-intent narrowing rule: unscoped fallback, persona intersection (all four personas incl. PLATFORM_ADMIN), never-widens, strict intersection with no admin preservation, fails-closed empty set, input immutability | 11 | `auth.service.spec.ts` |
| `loginRole` claim parsing: every persona accepted (incl. PLATFORM_ADMIN), garbage/non-string read as absent, absent claim = unscoped | 8 (in 43) | `token-verifier.service.spec.ts` |
| One-privileged-role rule: elevated set composition, requestable ⊂ elevated, conflict matrix (incl. admin occupying the slot), USER never counts, refusal wording without an email | 11 | `rbac.service.spec.ts` |
| Roles read/request flow, admin grant/revoke/decide/queue/audit, gated strategy routes, self-promotion refusal, **session scoping over HTTP** (narrowed `/rbac/me`, guard refuses an expert route for a USER-scoped session, admin persona-scoped to USER loses the admin surface, PLATFORM_ADMIN persona yields the admin surface alone, a non-admin's admin claim intersects to nothing, forged/garbage claims buy nothing, pre-scoping sessions unchanged), **env-only admin + one-role rule over HTTP** (admin request refused unless env-listed, env-listed address auto-granted, authorize carries the refusal reason) | 53 | `test/rbac.e2e-spec.ts` |

Run with `npm test` (guard and narrowing-rule unit tests) and
`npm run test:e2e -- --testPathPatterns rbac`. E2E isolation notes:

- `test/setup-env.ts` sets `RBAC_TEST_DEFAULT_ROLES=EXPERT_TRADER`, which
  `AuthService.testFixtureRole()` honours on **every** `resolveIdentity` so the
  frozen `POST /api/strategies` call sites in older suites keep working. RBAC's
  own negative paths suspend it with the spec-local `withoutFixture()` (delete
  env → call → restore in `finally`); any future 403-after-revoke test must do
  the same.
- The suite deletes its strategies before its users (`strategies.owner` is
  `Restrict`).
- `schema.e2e-spec.ts` pins moved with the migration, not weakened: 11 tables
  with an `id` column (+`admin_audit_logs`, `role_requests`, `user_profiles`,
  `user_roles`) and 18 `created_at` / `updated_at` columns (was 14).

### Deliberately absent / limitations

- **No HTTP *grant* path to `PLATFORM_ADMIN`** — an admin row can only come
  from the operator CLI or from the `PLATFORM_ADMIN_EMAILS` configuration
  being exercised through the login funnel (never from the approval queue or
  the admin grant API), and no self-service role revocation: users can request
  roles, never take them away.
- **Tokenomics writes unguarded server-side** (frozen contract) — frontend-only
  gating, recorded here and in `TEST_FAILURES.md`.
- **No cross-user profile endpoint**, no public expert profile.
- **No role expiry, quotas or approval SLAs** — decisions are manual.
- **Health stays public** (operational probe); only its admin UI is gated.

---

## Design-integration API additions

Three read/answer surfaces were added behind the designer's ported pages
(`designs/*.html` → `app/**`). They are grouped here because they were added for
one reason: a page could not be wired honestly without them.

### 1. AI trade-buddy — `POST /api/ai-doubt-solver`

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/ai-doubt-solver` | public | Answer one doubt for the trade-buddy widget |

Contract (the widget validates it, so it is the contract, not a suggestion):

```
request  { query ≤ 1000, elementContext?, pageContext?, history[≤ 8] }
response { concept ≤ 120, sections: { what, simple, howItWorks, example, remember } ≤ 1800 each }
```

Validation failures use the standard error envelope
(`{ code, message, path, requestId, timestamp }`). The Next BFF route
`app/api/ai-doubt-solver/route.ts` re-shapes any non-2xx into `{ error: message }`
and an unreachable backend into a 502 with an honest sentence, because
`public/ai-doubt-solver.js` reads `data.error` for its chat message.

Two answer sources, chosen by configuration:

- **Knowledge base (default).** ~24 curated entries in `knowledge-base.ts`,
  matched on whole-word keywords with the inspected element as a tie-break, and
  an explicit "no entry yet" fallback instead of an invented explanation.
- **Model.** `AI_MODEL_URL` (see *Environment variables*) is POSTed the same
  payload with a 20s timeout; a 5xx, a timeout or a malformed answer falls back
  to the knowledge base rather than failing the widget's request. This is the
  swap-in point for a locally trained model.

It is `@Public()` deliberately: explaining a concept leaks no user data, and the
widget runs on pages an anonymous visitor can reach.

### 2. Health flags — `providerConfigured` / `aiProvider`

`GET /api/health` now also returns:

| Field | Meaning |
| --- | --- |
| `providerConfigured` | `true` whenever the endpoint can answer. Always `true` today — the knowledge base is part of the build, so "no API key" is never the truth |
| `aiProvider` | `knowledge-base` \| `model` — which source would actually answer under the current configuration |

The widget's status probe derives `/api/health` from its answer endpoint and reads
`providerConfigured` to show **AI ready**. The BFF's `app/api/health/route.ts`
answers `200` with a `null` body when the backend is down, so the widget shows
"Backend offline" instead of mislabelling an outage as a missing key.

### 3. Staking program config — `GET /api/ember-staking/config`

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/ember-staking/config` | Bearer | `{ aprPercent, lockDays }` — the configured lock period and APR |

The staking design offers four lock periods; the platform has exactly one. The
page reads this endpoint so it can mark the configured period as the real choice
and label the other three illustrative, and so the APR it displays is the same
number the reward simulation uses. It reads no user data — authentication only.

Tests: `ai-doubt-solver.service.spec.ts` (unit, 23),
`test/ai-doubt-solver.e2e-spec.ts` (14), and the config rows in
`test/ember-ecosystem.e2e-spec.ts`. Run with `npm test` and
`npm run test:e2e -- --testPathPatterns ai-doubt-solver`.

---

## Requirements

- Node.js **20.9+** (developed on 24.x)
- npm 10+
- PostgreSQL 14+ (16 used in development)
- Docker, only for the local database

---

## Setup

```bash
cd backend
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run prisma:generate
```

### Database

```bash
docker compose up -d      # start PostgreSQL on :5432
```

If a container named `prometheus-postgres` already exists, Docker will refuse to
create another. Start the existing one instead:

```bash
docker start prometheus-postgres
```

`DATABASE_URL` in `.env` must match the credentials your database actually uses.

To use Supabase instead, swap in the commented `DATABASE_URL` in `.env.example`.
No code changes are required.

Seed the reference assets the wallet reads:

```bash
npm run prisma:seed     # INR, USDT, EMBER - idempotent, safe to re-run
```

Until this has run, `GET /api/assets` returns an empty list and any credit to an
unknown symbol is a `404`.

Seed the historical market data and the three paper simulations:

```bash
npm run market:seed     # 1,932 candles + one simulation per expert rule, idempotent
npm run market:verify   # same check without writing
```

Until this has run, `GET /api/market/candles` reports an empty catalogue and
`GET /api/simulations/:id` answers `404` — the honest state for data nobody has
imported yet.

### Run

```bash
npm run start:dev     # watch mode on http://localhost:3001
```

| URL | Purpose |
| --- | --- |
| `http://localhost:3001/api/health` | Health check |
| `http://localhost:3001/docs` | Swagger UI |
| `http://localhost:3001/docs/openapi.json` | OpenAPI document |

The global route prefix comes from `API_PREFIX` (`api` by default).

---

## Environment variables

Every variable is validated at boot by `src/config/env.validation.ts`. **The
process refuses to start on invalid configuration** and prints exactly which
variable is wrong:

```
Invalid environment configuration. Prometheus cannot start.

  - DATABASE_URL: "DATABASE_URL" is required

Fix the variables above in your .env file, or copy .env.example as a starting point.
```

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `staging` \| `production` |
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | |
| `API_PREFIX` | `api` | Empty string disables the prefix |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated exact origins. **No wildcards by design.** |
| `LOG_LEVEL` | `log` | `error`\|`warn`\|`log`\|`debug`\|`verbose`\|`silent` |
| `SWAGGER_ENABLED` | `true` | |
| `DATABASE_URL` | *(required)* | PostgreSQL URI. Must start `postgres://` or `postgresql://` |
| `DATABASE_POOL_MAX` | `10` | 1–100. See *Pool sizing* below |
| `DATABASE_CONNECT_TIMEOUT_MS` | `10000` | 500–120000 |
| `DATABASE_FAIL_FAST` | `false` | See *Startup policy* below |
| `AUTH_API_SIGNING_PUBLIC_KEY` | *(required)* | SPKI PEM, RSA. Parsed at boot. **Public key only** |
| `AUTH_API_ISSUER` | `prometheus-web` | Must match the frontend's issuer |
| `AUTH_API_AUDIENCE` | `prometheus-api` | Must match the frontend's audience |
| `AUTH_API_TOKEN_TTL_SECONDS` | `900` | Informational: the expiry is set by the signer |
| `PAYMENTS_PROVIDER` | `simulated` | `simulated` = no external provider, the credit is real; `razorpay` = the deposit is credited only after Razorpay confirms it. See *Wallet Top-ups (Module 03b)* |
| `RAZORPAY_KEY_ID` | *(optional)* | Publishable key id. Handed to the browser because Razorpay's checkout script needs it. Required when `PAYMENTS_PROVIDER=razorpay` |
| `RAZORPAY_KEY_SECRET` | *(optional)* | Server-side only. Signs the checkout signature and authorises the Orders API. Required when `PAYMENTS_PROVIDER=razorpay` |
| `RAZORPAY_WEBHOOK_SECRET` | *(optional)* | Verifies `X-Razorpay-Signature` on inbound webhooks. Without it every delivery is refused |
| `PAYMENTS_MAX_DEPOSIT_INR` | `500000` | Largest single top-up accepted, in INR. An abuse rail on one request, not a cap on a wallet's balance |
| `PAYMENTS_REQUEST_TIMEOUT_MS` | `10000` | Timeout for each outbound payment-provider HTTP call (1000–30000) |
| `USDT_PRICING_PROVIDER` | `live` (`fake` under `NODE_ENV=test`) | `live` = CoinDCX + CoinGecko; `fake` = deterministic market for suites |
| `COIN_GECKO_API` | *(optional)* | Demo/key header for CoinGecko; never logged, never in a URL |
| `USDT_FALLBACK_PRICE_INR` | *(optional)* | Display-only indicative quote when live data is missing; never executes |
| `USDT_PRICE_MAX_AGE_MS` | `30000` | Execution book freshness window |
| `USDT_REFERENCE_MAX_AGE_MS` | `900000` | Reference venue/aggregate freshness window |
| `USDT_FETCH_TIMEOUT_MS` | `3000` | Per-provider HTTP timeout |
| `USDT_PRICE_CACHE_TTL_MS` | `5000` | Snapshot cache TTL (single entry) |
| `USDT_PRICE_SANITY_MAX_DEV_PCT` | `20` | Max VWAP deviation from the independent anchor |
| `USDT_FAKE_PRICING_SCENARIO` | *(tests)* | `live` \| `stale` \| `down` \| `no-reference` |
| `LIQUIDITY_MIN_AVAILABLE_USDT` | `200000` | Shortfall threshold for the liquidity overview (detection only) |
| `LIQUIDITY_EMBER_SLABS` | `[{"minUsdt":"0","requiredEmber":"1000"},{"minUsdt":"100000","requiredEmber":"20000"},{"minUsdt":"250000","requiredEmber":"45000"},{"minUsdt":"500000","requiredEmber":"80000"}]` | JSON `[{ "minUsdt", "requiredEmber" }, …]` flat-cliff EMBER lock slabs (approved 2026-10-18). Unset disables commitments: create/reduce answer 503 (`liquidity_ember_slabs_not_configured`) |
| `AI_MODEL_URL` | *(optional)* | POST endpoint of a model answering the trade-buddy payload (see *Design-integration API additions*). Unset = the built-in knowledge base answers alone, which is a valid configuration, not a degraded one. On error or a 20s timeout the endpoint falls back to the knowledge base |

`.env` is gitignored. `.env.example` is committed and contains no secrets.

Generate a matching keypair with `node ../scripts/generate-auth-keys.mjs
--write --yes`, from the repository root. The generator writes the private key to
the frontend's `.env.local` and the public key here; it never prints either.

---

## Manual OAuth verification

Automated tests never contact Google or GitHub. To verify a real consent flow:

1. `npm run start:dev` in `backend`, then `npm run dev` at the repository root.
2. In `../.env.local`, set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` from the provider consoles.
3. Register these redirect URIs with each provider:

   | Provider | URI |
   | --- | --- |
   | Google | `http://localhost:3000/api/auth/callback/google` |
   | GitHub | `http://localhost:3000/api/auth/callback/github` |

4. Open <http://localhost:3000/wallet>. Expect a redirect to
   `/api/auth/signin?callbackUrl=%2Fwallet`.
5. Sign in with either provider. Expect to land back on `/wallet`, with the
   email visible in the header.
6. `curl http://localhost:3001/api/auth/me` with no token returns `401`.
7. Check the backend picked up the identity:

   ```bash
   npx prisma studio   # users row exists, auth_accounts row links to it,
                       # wallets row for that user is empty
   ```

8. Sign in again with the same provider. Expect the **same** `users.id` and no
   duplicate rows.
9. Sign in with the other provider using the **same email**. Expect `409
   CONFLICT` — providers are never linked by email.
10. Sign out. Expect the header controls to return to signed-out, and
    `prometheus_api_token` to be cleared from the browser's cookies.

---

## Startup policy

By default the service **starts even when PostgreSQL is unreachable**, logs a
warning, and reports the database as `down` from `/health`:

```json
{ "status": "error", "checks": [{ "name": "database", "status": "down" }] }
```

Rationale: liveness should not depend on a dependency. A process that cannot
reach its database is still able to answer a health probe, and that answer is
the diagnostic an operator needs. Killing the container instead would replace a
useful signal with a restart loop.

Set `DATABASE_FAIL_FAST=true` where a hard boot failure is preferable — for
example a migration step that should not run against a broken database.

---

## Error format

Every failure returns the same envelope:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "verbose must be a boolean value (true or false).",
  "timestamp": "2026-10-01T11:45:47.900Z",
  "path": "/api/health?verbose=maybe",
  "requestId": "0f8a...-...",
  "details": ["..."]
}
```

`code` is stable and machine-readable — clients branch on it, never on
`message`. `requestId` is echoed in the `x-request-id` header and appears in the
server log for the same request, so a user-reported error is traceable to
specific log lines. Internal exception details are never sent to clients.

---

## Pool sizing

`DATABASE_POOL_MAX` is appended to the datasource URL as Prisma's
`connection_limit`. Two caveats worth knowing:

- **An explicit `connection_limit` in `DATABASE_URL` always wins.** This is
  required for Supabase's transaction-mode pooler, which needs
  `connection_limit=1` alongside `pgbouncer=true`. Appending a default would
  override a value the operator set deliberately and exhaust the pooler. See
  `src/database/datasource-url.ts`.
- **Default 10, not Prisma's own default.** Prisma sizes its pool at
  `physical_cpus × 2 + 1`, which on a many-core development machine opens far
  more connections than a local database needs. 10 is a deliberate, conservative
  floor for a single-instance app.

---

## Project layout

```
backend/
├── prisma/
│   ├── schema.prisma        # the 11 entities, constraints, enums
│   ├── seed.ts              # idempotent asset seed (INR, USDT, EMBER)
│   ├── market-seed.ts       # idempotent market data + simulation seed (06b)
│   └── migrations/          # immutable migration history + CHECK constraints
├── src/
│   ├── main.ts              # entrypoint; bootstrap failure exits non-zero
│   ├── bootstrap.ts         # createApp(): one app definition used by prod AND tests
│   ├── app.module.ts        # root composition - register modules here only
│   ├── config/              # env validation + typed AppConfig
│   ├── common/              # cross-cutting: filters, interceptors, pipes, errors
│   ├── database/            # PrismaService lifecycle + datasource URL handling
│   └── modules/
│       ├── health/          # public health probe
│       ├── auth/            # token verification + identity resolution
│       ├── assets/          # read-only asset reference data + GET /api/assets
│       ├── wallet/          # accounting boundary + wallet read APIs
│       ├── payments/        # wallet top-ups: the one way money enters (03b)
│       ├── portfolio/       # derived read model + GET /api/portfolio (no writes)
│       ├── strategy/        # owner CRUD + public discovery (no dependencies)
│       ├── market-data/     # candle catalogue + offline ZIP/CSV importer (06b)
│       ├── simulation/      # engine, rules, store, seed + simulations read API (06b)
│       └── risk/            # derived risk reading + GET /api/risk (no writes, no table)
└── test/                    # integration suites (see Scripts)
```

**Layering rules, enforced by structure:**

- `AppConfigModule` and `DatabaseModule` are `@Global()`. Configuration and the
  DB client are cross-cutting, not feature-specific.
- A feature module may depend on another feature's **explicitly exported
  service API** when a real domain dependency exists. `PortfolioModule` imports
  `WalletModule` for `WalletService`; that is the whole of its contact.
  Everything else — a feature's types, its helpers, its internals — stays
  private to it.
- `common`, `config` and `database` never import from `modules`. Dependencies
  point inward only.
- Controllers stay thin; rules belong in services.

New modules are added one at a time and registered in `app.module.ts` only after
being tested and frozen.

---

## Scripts

| Script | Purpose | Needs DB |
| --- | --- | --- |
| `npm run start:dev` | Watch mode | no |
| `npm run build` | Compile to `dist/` | no |
| `npm run start:prod` | Run the compiled build | yes |
| `npm test` | Unit tests (`src/**/*.spec.ts`) | no |
| `npm run test:e2e` | Integration suites (`test/*.e2e-spec.ts`) | yes |
| `npm run test:db` | Database connectivity only | yes |
| `npm run test:schema` | Schema/constraint suites only | yes |
| `npm run test:auth` | Authentication suites only | yes |
| `npm run test:wallet` | Wallet & assets suites only | yes |
| `npm run test:payments` | Wallet top-up suite only | yes |
| `npm run test:portfolio` | Portfolio suites only | yes |
| `npm run test:strategy` | Strategy suites only | yes |
| `npm run test:risk` | Risk suites only | yes |
| `npm run test:market` | Market data + market-guard suites only | yes |
| `npm run test:simulation` | Simulation suite only | yes |
| `npm run test:usdt` | USDT exchange suite only | yes |
| `npm run test:liquidity` | Liquidity & order-processing suite only | yes |
| `npm run test:tokenomics` | EMBER tokenomics suite only | yes |
| `npm run test:treasury` | Treasury guardrails suite only | yes |
| `npm run market:seed` | Import candles + simulate the three expert strategies (idempotent) | yes |
| `npm run market:verify` | Report what `market:seed` would do; write nothing | yes |
| `npm run seed:liquidity` | Seed three demo simulated LPs with USDT/EMBER pledges (idempotent; needs configured slabs) | yes |
| `npm run lint` | ESLint, zero warnings tolerated | no |
| `npm run typecheck` | `tsc --noEmit` | no |
| `npm run format` | Prettier | no |
| `npm run prisma:migrate` | Create/apply a migration | yes |
| `npm run prisma:generate` | Regenerate the client after a schema change | no |
| `npm run prisma:studio` | Prisma Studio | yes |
| `npm run prisma:seed` | Seed reference assets (idempotent) | yes |

`npm test` deliberately does **not** require a database, so it stays fast and
usable in CI before any infrastructure exists. Database assertions live in
`test/*.e2e-spec.ts`.

---

## Tests

```bash
npm test              # unit
npm run test:e2e      # integration + schema, needs PostgreSQL
npm run test:schema   # schema/constraint suites only
```

| Requirement (Module 00) | Covered by |
| --- | --- |
| Application boots | `test/app.e2e-spec.ts` |
| `/health` succeeds | `test/app.e2e-spec.ts` |
| Invalid environment configuration fails clearly | `src/config/env.validation.spec.ts` |
| Invalid DTO is rejected | `test/app.e2e-spec.ts` |
| Baseline automated test passes | all suites |
| Database connectivity verified | `test/database.e2e-spec.ts` (live PostgreSQL) |

| Requirement (Module 01) | Covered by |
| --- | --- |
| Migrations apply cleanly | `prisma migrate dev` / `migrate reset`, verified manually |
| Relationships enforce foreign keys | `test/schema.e2e-spec.ts` → *relationships* |
| Invalid/duplicate data is rejected | `test/schema.e2e-spec.ts` → *uniqueness*, *integrity constraints* |
| Rollback/reapply works | `prisma migrate reset --force`, verified manually |
| A transaction rollback test passes | `test/schema.e2e-spec.ts` → *atomicity* |
| Indexes exist for justified lookup paths | `test/schema.e2e-spec.ts` → *structure* |
| `auth_accounts` link one provider identity to one user | `test/schema.e2e-spec.ts` → *authentication tables* |

| Requirement (Module 02) | Covered by |
| --- | --- |
| Missing/invalid token returns a generic `401` | `test/auth.e2e-spec.ts`, `token-verifier.service.spec.ts` |
| Forged signature is refused | `token-verifier.service.spec.ts` |
| `alg: none` and HMAC-confusion are refused | `token-verifier.service.spec.ts` |
| Wrong `iss` / `aud` / `exp` is refused | `token-verifier.service.spec.ts` |
| First login creates a user, with no wallet | `test/auth.e2e-spec.ts` |
| Repeat login resolves the same user, no duplicates | `test/auth.e2e-spec.ts` |
| Unlinked provider sharing an email is a `409` | `test/auth.e2e-spec.ts` |
| `SUSPENDED` / `CLOSED` users are refused identically | `test/auth.e2e-spec.ts` |
| A valid token cannot read another user's data | `test/auth.e2e-spec.ts` |
| No token or credential appears in a response | `test/auth.e2e-spec.ts` |
| A bad public key fails at boot, not at first request | `src/config/env.validation.spec.ts` |

| Requirement (Module 03) | Covered by |
| --- | --- |
| A wallet is created once, idempotently | `test/wallet.e2e-spec.ts` |
| Concurrent creation yields a single wallet | `test/wallet.e2e-spec.ts` |
| No public endpoint can move a balance | `test/wallet.e2e-spec.ts` |
| One user cannot read or touch another's wallet | `test/wallet.e2e-spec.ts` |
| `credit`/`debit`/`lock`/`unlock` apply the exact deltas | `test/wallet.e2e-spec.ts` |
| Insufficient funds, frozen wallet and inactive asset are refused | `test/wallet.e2e-spec.ts` |
| Zero, negative and over-precise amounts are rejected | `test/wallet.e2e-spec.ts`, `decimal.util.spec.ts` |
| A failed ledger insert rolls the balance back | `test/wallet.e2e-spec.ts` (forces a real transaction failure) |
| Cursors round-trip and reject tampering | `cursor.util.spec.ts`, `test/wallet.e2e-spec.ts` |
| Every successful move writes a `COMPLETED` transaction | `test/wallet.e2e-spec.ts`, `wallet.service.spec.ts` |
| `GET /api/assets` returns only active assets | `test/wallet.e2e-spec.ts` |

| Requirement (Module 03b) | Covered by |
| --- | --- |
| Every route requires a token | `test/payments.e2e-spec.ts` → *route surface* |
| A top-up credits the wallet with real INR | `test/payments.e2e-spec.ts` → *the top-up itself* |
| The credit is a real `DEPOSIT` ledger row | `test/payments.e2e-spec.ts` → *the credited INR is the ledger's own number* |
| A replayed key moves no balance again | `test/payments.e2e-spec.ts` → *idempotent replay* |
| Two racing requests with one key credit once | `test/payments.e2e-spec.ts` → *idempotent replay* |
| An amount above the ceiling is refused, and writes nothing | `test/payments.e2e-spec.ts` → *the top-up ceiling* |
| Zero, negative, malformed and over-precise amounts are refused | `test/payments.e2e-spec.ts` → *refused amounts and bodies* |
| One user cannot see or verify another's top-up | `test/payments.e2e-spec.ts` → *listing*, *verification* |
| A forged checkout signature credits nothing | `src/modules/payments/payments.service.spec.ts` |
| A captured amount that does not match is refused | `src/modules/payments/payments.service.spec.ts` |
| A webhook with a bad signature is refused | `src/modules/payments/payments.service.spec.ts` |
| A repeated webhook delivery credits once | `src/modules/payments/payments.service.spec.ts` |
| The deposit row and the ledger credit commit together | `src/modules/payments/payments.service.spec.ts` |
| `wallet_deposits` enforces its own constraints | `test/schema.e2e-spec.ts` → *integrity constraints* |

| Requirement (Module 04) | Covered by |
| --- | --- |
| Unauthenticated access is refused | `test/portfolio.e2e-spec.ts` → *route surface* |
| No route names another user; `?userId=` is ignored | `test/portfolio.e2e-spec.ts` |
| No route can write | `test/portfolio.e2e-spec.ts` |
| A user with no wallet gets `200` and an empty portfolio | `test/portfolio.e2e-spec.ts` |
| A wallet with no balances reports no holdings and no activity | `test/portfolio.e2e-spec.ts` |
| `available`, `locked` and `total` are correct | `test/portfolio.e2e-spec.ts`, `portfolio.service.spec.ts` |
| Each asset renders at its own precision, as strings | `test/portfolio.e2e-spec.ts` |
| Decimal arithmetic is exact, never floating point | `portfolio.service.spec.ts` |
| A drained row is listed but not counted as funded | `test/portfolio.e2e-spec.ts` |
| A holding in a retired asset is still returned | `test/portfolio.e2e-spec.ts` |
| `lockedShare` is 0–1, four places, `null` when zero | `portfolio.service.spec.ts` |
| Composition counts categories, never value | `portfolio.service.spec.ts`, `test/portfolio.e2e-spec.ts` |
| Activity counts, window, per-type counts and span are right | `test/portfolio.e2e-spec.ts` |
| Every ledger read is scoped to the caller's wallet | `portfolio.service.spec.ts` → *query shape* |
| One user cannot read another's balances | `test/portfolio.e2e-spec.ts` |
| Reading a portfolio changes no financial row | `test/portfolio.e2e-spec.ts` (table fingerprint) |
| No valuation, P&L or allocation is invented | `test/portfolio.e2e-spec.ts` |
| No `NaN`, `Infinity` or negative derived value | `portfolio.service.spec.ts`, `test/portfolio.e2e-spec.ts` |
| Query count does not grow with holdings | `portfolio.service.spec.ts` |

| Requirement (Module 05) | Covered by |
| --- | --- |
| Every route requires a token, discovery included | `test/strategy.e2e-spec.ts` → *route surface* |
| No route or body field can name another owner | `test/strategy.e2e-spec.ts` |
| `strategies` has exactly the eight approved columns | `test/schema.e2e-spec.ts` → *strategies* |
| Name uniqueness is per owner, case- and whitespace-insensitive | `test/schema.e2e-spec.ts`, `test/strategy.e2e-spec.ts` |
| Two owners may hold the same name | `test/schema.e2e-spec.ts` |
| Blank and over-long names, over-long descriptions are refused | `test/schema.e2e-spec.ts`, `test/strategy.e2e-spec.ts` |
| Defaults are `PRIVATE` and `ACTIVE` | `test/schema.e2e-spec.ts`, `strategy.service.spec.ts` |
| `owner_id` is `ON DELETE RESTRICT` | `test/schema.e2e-spec.ts` |
| A duplicate name is a `409 CONFLICT`, not a `500` | `strategy.service.spec.ts`, `test/strategy.e2e-spec.ts` |
| A private strategy is invisible to others, by list and by id | `test/strategy.e2e-spec.ts` |
| An invisible strategy is `404`, never `403` | `test/strategy.e2e-spec.ts` |
| Discovery returns `PUBLIC` + `ACTIVE` only | `test/strategy.e2e-spec.ts` |
| `?status=`/`?visibility=` cannot widen discovery | `test/strategy.e2e-spec.ts` |
| The public DTO exposes no owner identity, and no status | `test/strategy.e2e-spec.ts` |
| Archiving is accepted; `ACTIVE` is a `400` | `test/strategy.e2e-spec.ts` |
| An archived strategy refuses every further change | `strategy.service.spec.ts`, `test/strategy.e2e-spec.ts` |
| No route can delete a strategy | `test/strategy.e2e-spec.ts`, openapi document |
| Pagination is 1-based and reports consistent totals | `test/strategy.e2e-spec.ts` |
| No performance figure, risk score or follower count exists | `test/strategy.e2e-spec.ts`, `test/schema.e2e-spec.ts` |
| A strategy needs no wallet and moves no money | `test/strategy.e2e-spec.ts`, `test/schema.e2e-spec.ts` |

| Requirement (Module 06) | Covered by |
| --- | --- |
| The only risk route requires a token | `test/risk.e2e-spec.ts` → *route surface* |
| No batch endpoint exists | `test/risk.e2e-spec.ts` → *route surface* |
| A non-UUID id is `400`, before it reaches the database | `test/risk.e2e-spec.ts` |
| An unknown id is `404` | `test/risk.e2e-spec.ts` |
| Another user's private strategy is `404`, never `403` | `test/risk.e2e-spec.ts`, `risk.service.spec.ts` |
| The owner sees their own active, public and archived strategies | `test/risk.e2e-spec.ts` |
| `INSUFFICIENT_DATA` carries one reason, never a guessed figure | `risk.service.spec.ts`, `test/risk.e2e-spec.ts` |
| Validation runs before counting, counting before flatness | `risk.service.spec.ts` |
| Exactly 30 observations is the boundary | `risk.service.spec.ts` |
| Fixture series produce the published metrics and level | `risk.service.spec.ts`, `volatility.spec.ts`, `drawdown.spec.ts` |
| Sample divisor is `n − 2`, not `n − 1` | `volatility.spec.ts` |
| Classification reads unrounded values at every threshold | `risk-level.spec.ts` |
| A series with a gap, a duplicate day or bad equity is refused | `series.spec.ts` |
| `riskLevel` and `metrics` are null together | `risk.service.spec.ts`, `test/risk.e2e-spec.ts` |
| No return, price, equity or P&L is reported | `test/risk.e2e-spec.ts` |
| `requiredObservations` is 30 and `sampleDescription` is stated | `test/risk.e2e-spec.ts` |
| Reading risk changes no row | `test/risk.e2e-spec.ts` (table fingerprint) |
| No risk, equity or trade table is created | `test/risk.e2e-spec.ts`, `test/schema.e2e-spec.ts` |
| Visibility is delegated, never re-implemented | `risk.service.spec.ts` |
| The port now reads persisted history; an unsimulated strategy still reads `NO_HISTORY` | `test/market-guard.e2e-spec.ts` |

| Requirement (Module 06b) | Covered by |
| --- | --- |
| Importing the committed dataset inserts 0 and changes nothing on a re-run | `test/market.e2e-spec.ts` (beforeAll report), `market-data-importer.spec.ts` |
| A bad row, a bad archive or a broken window is refused with a stable code | `market-data-importer.spec.ts`, `zip-archive.spec.ts`, `kline-row.spec.ts`, `validation.spec.ts` |
| An unparseable time, price, volume or OHLC order is fatal, not skipped | `kline-row.spec.ts`, `validation.spec.ts` |
| A close-time/trades/extra-field discrepancy is a warning, not a failure | `validation.spec.ts`, `kline-row.spec.ts` |
| One bad symbol fails atomically; other symbols still import | `market-data-importer.spec.ts` |
| Pinned first/last candles equal the committed CSV, exactly | `test/market.e2e-spec.ts` |
| Money and days are exact strings in the response; provenance never leaks | `test/market.e2e-spec.ts` |
| `symbol` is required and alphanumeric; unknown symbol `404`; empty window `200` with `total: 0` | `test/market.e2e-spec.ts` |
| `from`/`to` are inclusive `YYYY-MM-DD`; `from > to`, bad dates and bad paging are `400` | `test/market.e2e-spec.ts` |
| No import or write route exists over HTTP | `test/market.e2e-spec.ts` → *route surface* |
| Signal at close, fill at next open; the last day never trades | `simulation-engine.spec.ts`, `rule-catalog.spec.ts` |
| Quantity truncation, fee rounding and cash rounding are exact | `simulation-engine.spec.ts`, `decimal-string.spec.ts` |
| Each rule fires only its own branch, with its own note | `rule-catalog.spec.ts` |
| Every simulations route requires a token; non-UUID `400`; unknown `404` | `test/simulation.e2e-spec.ts` → *route surface* |
| A visible strategy that was never simulated is `404` | `test/simulation.e2e-spec.ts` |
| The summary carries the provenance and both `simulated` / `notRealTrades` flags | `test/simulation.e2e-spec.ts` |
| Fills are exact to the last digit and ascend by `sequence_no` | `test/simulation.e2e-spec.ts` (pinned first/last fills for all three rules) |
| Every balance row satisfies `cash + positionValue = value`, all 644 of them | `test/simulation.e2e-spec.ts` |
| Paging past the end keeps the totals standing; bad paging is `400` | `test/simulation.e2e-spec.ts` |
| No write route: a caller cannot trigger a simulation | `test/simulation.e2e-spec.ts` → *route surface* |
| A series with a missing day, or one extending before the window, is refused | `test/market-guard.e2e-spec.ts` (→ `INVALID_SERIES`) |
| An unsimulated strategy still reads `NO_HISTORY` with zero evidence | `test/market-guard.e2e-spec.ts` |
| Evaluating moves no row, on the accepted path and the refused one | `test/market-guard.e2e-spec.ts` (fingerprint before/after) |
| A stranger still gets `404` for another user's simulated curve | `test/market-guard.e2e-spec.ts`, `test/simulation.e2e-spec.ts` |

| Requirement (Module 08) | Covered by |
| --- | --- |
| Quote is the order-book VWAP, guaranteed against the venue offers, with provenance (status, `bookVwap`, `guarantee`, competitors' `venuePrice`, aggregate, basis) | `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` → *quote calculation* |
| Savings sign is positive on BUY, negative on SELL, exact for fractions, null without reference | `usdt-pricing.spec.ts`, `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` → *savings calculation* |
| Buy debits INR, credits USDT, records the order with live snapshot prices | `test/usdt.e2e-spec.ts` → *buy* |
| Both ledger legs cite the order id and are COMPLETED | `test/usdt.e2e-spec.ts` → *buy* |
| Sell debits USDT, credits INR, records the negative shortfall | `test/usdt.e2e-spec.ts` → *sell* |
| Price guard breach is 409 with nothing settled; wrong-side guard is 400 | `test/usdt.e2e-spec.ts` → *price guards* |
| Stale/down market serves a labelled fallback quote but refuses execution with 503 | `usdt-pricing.service.spec.ts`, `test/usdt.e2e-spec.ts` → *live pricing policy* |
| Insufficient balance is 409 with no order, no ledger row, no balance change | `test/usdt.e2e-spec.ts` → *insufficient balance* |
| Zero, negative, malformed, over-scale and below-minimum-settlement amounts are 400 | `usdt-pricing.spec.ts`, `test/usdt.e2e-spec.ts` |
| Order lifecycle: newest-first list, keyset paging, cross-user isolation | `test/usdt.e2e-spec.ts` → *order lifecycle* |
| Atomic state update: racing buys settle exactly one; replays apply once | `test/usdt.e2e-spec.ts` → *atomic state update* |
| Every route refuses without a token; unknown properties are 400 | `test/usdt.e2e-spec.ts` → *route surface* |
| Provider parsing and the guarded fetch reject malformed/stale/timeout data | `providers/*.spec.ts` |

| Requirement (design-integration additions) | Covered by |
| --- | --- |
| Knowledge-base answers honour the widget contract (concept ≤120, sections ≤1800) for every entry | `ai-doubt-solver.service.spec.ts` |
| Generic questions use the inspected element; unmatched questions fall back honestly | `ai-doubt-solver.service.spec.ts`, `test/ai-doubt-solver.e2e-spec.ts` |
| A configured model receives the widget payload (history trimmed to 8) and errors/timeouts/malformed answers fall back to the knowledge base | `ai-doubt-solver.service.spec.ts` |
| `POST /api/ai-doubt-solver` is public, POST-only, and rejects missing/empty/over-long queries, >8 history turns, non-object context and unknown properties with the standard envelope | `test/ai-doubt-solver.e2e-spec.ts` |
| Health reports `providerConfigured: true` and names `aiProvider` | `test/ai-doubt-solver.e2e-spec.ts` |
| `GET /api/ember-staking/config` returns `{ aprPercent, lockDays }` and requires a session | `test/ember-ecosystem.e2e-spec.ts` |

Beyond the checklists, the suites pin down that error responses never leak
driver messages or credentials, that correlation ids are honoured, that the
service still boots when the database is down, that no floating-point column
exists, and that each balance is non-negative at the database level rather than
only in application code.

### Test isolation

`test/schema.e2e-spec.ts` runs each assertion inside a transaction that is
discarded afterwards, so it leaves no rows behind and never truncates shared
tables. Two consequences:

- Assertions must use the `tx` handle. A query on the root `prisma` handle runs
  outside the transaction and sees committed state.
- PostgreSQL aborts a transaction on its first constraint violation
  (SQLSTATE 25P02), so two *expected* rejections cannot share one transaction.
  Those cases are split deliberately.

The atomicity tests are the exception: observing what was committed is their
whole purpose, so they seed and clean up explicitly.

The Module 06b suites (`test/market.e2e-spec.ts`, `test/simulation.e2e-spec.ts`,
`test/market-guard.e2e-spec.ts`) follow a different rule: they boot the whole
app from `createApp()`, mint their own tokens through `test/token-minting.ts`,
import the committed dataset in an idempotent `beforeAll`, create only
owner-scoped rows (`system@prometheus.local` for the seed pins, a per-suite
temp owner for anything mutable) and delete exactly what they created. They run
concurrently with every other suite against the same database, which is why no
suite truncates a shared table and why the guard suite compares table
fingerprints taken immediately before and after each evaluation instead of
assuming stillness. None of them holds a transaction open: replace-all and
store-and-replace are the behaviour under test, so their writes must be
committed to be observable.

Module 09 changed the e2e config to run files **serially** (`maxWorkers: 1`):
BUY eligibility now depends on global `liquidity_providers` rows, so two
suites placing orders in parallel could see each other's providers. The three
liquidity-touching suites (`test/liquidity.e2e-spec.ts`,
`test/usdt.e2e-spec.ts`, `test/ember.e2e-spec.ts` — the last registers a real
commitment to prove LP locks are reported and respected) reset the Module 09
tables in `beforeAll` and purge them in `afterAll`, which is only complete
isolation when one file runs at a time. Unit tests still run in parallel —
they never touch a shared database.

`test/tokenomics.e2e-spec.ts` purges in `beforeAll` **and** `afterAll`: the
three `token_*` tables, every `BURN` ledger row globally, and the treasury
user. Two reasons, both about other suites: `test/ember.e2e-spec.ts` asserts
an *absolute* `burnedSupply` of zero at three points (its suite runs with no
burns of its own, so any surviving `BURN` leg from another suite would fail
it), and the tokenomics suite creates the `treasury@prometheus.local` user
that a later suite might otherwise encounter. Serial execution plus
start-and-end purging is what keeps both statements true regardless of file
order.

---

## Known limitations

Carried forward deliberately, not oversights:

1. **Balances cannot be topped up from outside.** `credit`/`debit` exist as
   service methods for later modules, and no HTTP route credits a balance
   (Module 11's burn *debits* the treasury, but nothing ever funds it over
   HTTP), so a user can only ever start from a zero balance. Real deposits and
   withdrawals belong to whichever module builds a payment rail, and
   pretending otherwise would mean faking one. Module 04 added no such route
   either.
2. **A portfolio is empty for every real user.** With no way to credit a balance
   over HTTP, a signed-in browser will always see the zero state until a later
   module provides funding. The portfolio itself is complete; its input is not.
3. **A wallet is created by request, not on sign-up.** First login still creates no
   wallet; `POST /api/wallets` does. This keeps the auth module's surface narrow
   and makes provisioning an explicit, idempotent action.
4. **No liveness/readiness split.** `/health` reports aggregate state and always
   returns 200. Separate `/health/live` and `/health/ready` endpoints arrive with
   deployment.
5. **No rate limiting.** Per-identity throttling would be meaningful now that
   identities exist, but it belongs with the first module whose endpoints are
   worth throttling.
6. **No Redis client, so access tokens cannot be revoked before expiry.** The 15
   minute TTL is the bound. A denylist needs Redis, and Redis has no consumer yet
   that would justify it.
 7. **Role authorization exists, per-resource authorization does not.**
   Module 13's `RolesGuard` answers *may this kind of caller reach this route*
   (403 with a generic message), but `AuthGuard` still only proves *who* the
   caller is and row-level ownership stays enforced per-resource: Modules 03
   and 04 need little of it because every route is scoped to `/me`, and Module
   05 resolved its arbitrary-id case locally — a row the caller may not see is
   reported as `404`, never `403`, so the existence of another user's private
   strategy is not disclosed. A shared ownership service is still not warranted
   by the modules that need it.
8. **`locked <= available` is not a database constraint.** It needs a trigger,
   which would move accounting logic out of the application layer. Module 03
   enforces it atomically at write time with a guarded `updateMany`.
9. **Pool sizing is capped, not tuned against load.** `DATABASE_POOL_MAX` is
   applied to the datasource URL as `connection_limit`. Choosing a value from
   real traffic belongs to a later module.
10. **PostgreSQL 16, not 17.** Matches the development environment. Nothing in the
    code depends on a 17-only feature.
11. **`jose@5` on the backend.** `jose@6` is ESM-only and cannot be `require()`d
    from Nest's CommonJS build. Revisit when the backend is ESM.
12. **The portfolio has no valuation, so it cannot answer "what am I worth?".**
    That needs a price source for *holdings*, and Module 06b's candles are not
    it: they are a simulation input for three fixed symbols, not a general
    quote feed, and answering this question from them would silently tie the
    portfolio's truth to whatever the simulator happens to import. A valuation
    belongs in its own module, with its own timestamped price history — not as a
    column on this read model.
13. **A user-created strategy still does nothing.** It is a name, a description,
    a visibility and a state. No route lets a caller pick a rule, start a
    simulation or allocate money to a strategy, and `strategies` carries no
    performance or risk column that would let a caller infer one — Module 06
    derives a risk reading per request instead of storing it. What Module 06b
    added is narrow and seed-only: three *expert* strategies created by
    `market:seed` each carry exactly one paper simulation (replace-all, no run
    history), read back through `/api/simulations/…`. Copy behaviour belongs to
    Module 07.
14. **Archiving cannot be undone, by design.** There is no restore route and no
    `ACTIVE` transition. If an archived strategy must come back, that is a new
    decision and a new migration — not an un-done `PATCH`.
15. **Discovery ignores `?status=` and `?visibility=`.** They are accepted and
    dropped, because the query is pinned to `PUBLIC` + `ACTIVE`. Honouring them
    would let a client widen the set; rejecting them would make `GET
    /strategies` and `GET /strategies/me` share a DTO that behaves differently
    from how it reads.
16. **The uniqueness rule is an expression index, so the schema cannot see it.**
    Prisma will not describe, generate or migrate `lower(btrim(name))`. The
    database enforces it and `test/schema.e2e-spec.ts` asserts it, but a future
    `prisma migrate` will neither warn about it nor preserve it in the generated
    SQL — it survives because the migration file is hand-edited and appended
    to, and that habit is worth remembering.
17. **Risk figures exist only where a simulation does.** The port now resolves
    to `strategy_daily_balance`, so the three seeded expert strategies answer
    with real classifications built from their 644-day simulated curves, and
    the same code answers `INSUFFICIENT_DATA / NO_HISTORY` for every strategy
    that was never simulated — including every strategy a user creates. That is
    still the honest report of absent evidence; a strategy that "runs" only in
    the sense that a seed wrote rows for it is not a strategy that is running.
18. **A simulation cannot be started over HTTP, and there is no run history.**
    `market:seed` is the only trigger, chosen so the rule, the candles and the
    fee assumption are all visible in one reviewed command rather than spread
    across an endpoint's parameters. Re-running replaces a strategy's single
    curve atomically; nothing records what a previous run looked like, because
    no product decision yet needs to compare two runs.
19. **The simulation is paper by construction.** No fill touches a wallet, no
    balance moves, and slippage, leverage and funding are absent rather than
    modelled — the fee rate is a stated assumption on every response, not a
    measured cost. Importing candles, too, remains an offline operation with no
    route, because reading the filesystem on request is a job, not an API.
20. **A USDT order cannot be funded over HTTP either.** The exchange (Module 08)
    moves real wallet balances, but limitation 1 still holds: no route credits
    INR or USDT, so every order in a signed-in browser starts from a zero
    balance until a deposit rail exists. The e2e suite funds wallets through
    `WalletService` directly — the only sanctioned way — and no exchange
    endpoint can mint money for the same reason no wallet endpoint can.
21. **The exchange's price source is public market data, not a venue
    integration.** Execution prices are the CoinDCX public order book and
    references are CoinGecko venue tickers, fetched per request with strict
    freshness, sanity and timeout rules; there is no order placement with any
    real venue, no custody, and no deposit rail (see limitation 20). When live
    data is unavailable the quote degrades to a labelled configured fallback
    and orders refuse with `503 PRICING_UNAVAILABLE` rather than settling at a
    stale or invented price.
22. **The EMBER slab table is static configuration, not a risk model.**
    Thresholds were approved 2026-10-18 and ship as the `LIQUIDITY_EMBER_SLABS`
    default (`0→1,000`, `100k→20,000`, `250k→45,000`, `500k→80,000`); changing
    them requires an env change and a restart, and the e2e suites exercise
    exactly this table via a labelled TEST-only fixture. Leaving the variable
    unset is the deliberate off-switch (create/reduce answer `503`), in which
    case the pool is always empty in a real deployment and every BUY takes the
    legacy minted path — Module 08's exact behaviour, so nothing regresses.
23. **LPs are simulated users, not integrations.** A provider is an ordinary
    user who pledges their own (test-funded) wallet balances; there is no
    external market-maker integration, no real money, and — per approval — no
    frontend for registering or reducing commitments. `npm run seed:liquidity`
    provisions three labelled demo LPs for development only.
24. **The ledger cannot classify an `ADJUSTMENT` row as issuance or
    destruction from the row alone.** EMBER's `totalIssuedSupply` is
    `SUM(DEPOSIT) − SUM(WITHDRAWAL)`, which is exact while adjustment rows
    never touch EMBER — no code path creates one today. An adjustment carries
    a positive magnitude with its direction implied by the surrounding balance
    chain, so if one ever appears it would be invisible to the supply
    aggregation and the issued figure must be revisited before
    `GET /api/ember/supply` is trusted. Transfers and locks are *not* issuance
    or burns and are excluded by construction; BURN legs *are* destruction and
    are summed explicitly; the e2e reconciliation
    (`available + locked = circulating = issued − burned`) fails loudly the
    moment this assumption stops holding.
25. **Tokenomics write routes are not role-guarded on the server.** Module 13
    gated strategy creation and the treasury summary, but Module 11's record
    endpoints keep their frozen contract — no `@Roles()` was added — so the
    tokenomics screen's admin-only actions are a frontend convenience, not a
    boundary. Anyone who can authenticate can still POST a preview/record; the
    routes move nothing without valid balances and the e2e suites pin their
    behaviour, but the server-side gap is real and is the first thing to close
    when the frozen contract is next opened (one decorator per route).
