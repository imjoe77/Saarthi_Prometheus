# Test Failures — Working Ledger

Purpose: every test case that has failed and has **not** been fixed yet, gathered
in one place so they can all be fixed at the end of the project. Anything listed
under `OPEN` must be fixed before the project is called complete; anything under
`RESOLVED` is history and needs no action.

Last updated: **2026-10-28** (full-suite run after the role/auth rework: the
login page now offers a fourth, env-only **Platform Admin** card; every persona
card scopes the session to its own surface ("one click, one surface"); and a
Gmail address may hold only **one** privileged role, refused through the
existing denial flow with a "try a different account" message).

---

## Snapshot at last full run

| Suite | Command | Result |
|---|---|---|
| Backend unit | `cd backend && npx jest --silent` | **945 / 945 passed** in 61 suites (was 932; +13 covering the one-privileged-role rule (`rbac.service.spec.ts`, 11 new) and the persona-narrowing rule now treating `PLATFORM_ADMIN` as an ordinary persona (`auth.service.spec.ts`, 9 → 11)) |
| Backend typecheck | `cd backend && npm run typecheck` | **clean** |
| Backend e2e | `cd backend && npm run test:e2e` | **635 / 638 passed** — 638 because `rbac.e2e-spec.ts` grew 50 → 53. The three failures are OPEN-1 below (**failed as predicted**: this run happened ~15:30 UTC, inside the US cash session), OPEN-2 below, and one sentinel expiry test that flaked on its 15s timeout under full-run load — re-run alone it is **25 / 25 green**, i.e. contention, not a defect. The rbac suite itself passed inside this run. The USDT suites pass in the full run (they were **61 / 61** and liquidity **13 / 13** when run alone on 2026-10-27) |
| Frontend | `npm test`, `npx tsc --noEmit`, `npx eslint .`, `npx next build` | **`npm test` 15/15; tsc clean; build green**. Repo-wide lint reports **6 errors, 36 warnings**, **none in a file this task touched**: 2 are the known `no-require-imports` in `blockchain/scripts/derive-address.js`; 4 are `react-hooks` findings in `app/copy-trading/page.tsx` (2 × `set-state-in-effect`) and `components/CopyActivityChart.tsx` (2 × `refs`), outside the role/auth, USDT and design work. `app/page.tsx` — edited here to mount the denial notice — is **not** among them, and lint is clean on every file this task touched (`LoginForm`, `LoginContinue`, `AccessDeniedNotice`, `app/page.tsx`, `lib/login-flow`, `lib/auth`, `lib/api-token`, `lib/api-client`, `types/next-auth.d.ts`). `public/**` is an explicit ignore (browser-shipped widget scripts — see `eslint.config.mjs`).

Backend lint (`cd backend && npm run lint`) reports **141 pre-existing
errors**, all in `sentinel/**`, `ember-*`, `blockchain/**` and their specs — no
`usdt/**` or `test/usdt*` file appears in that list, so Module 08 is lint-clean.

Live check of the guarantee (2026-10-27, `USDT_PRICING_PROVIDER=live`,
depth-aware probe of 1,000 USDT, three fresh venues): BUY book VWAP **101.70**
→ guaranteed **99.75**, a clear **1.505** inside the cheapest ask (CoinDCX
**101.2550625**), beside WazirX 101.444960253 and ZebPay 101.485 (`last only`);
SELL book VWAP **101.25** → guaranteed **102.99**, 1.505 above the best bid
(ZebPay 101.485). Reference `average_of_3_venues(CoinDCX, WazirX, ZebPay)`,
savings positive in both directions, `reasons: []`.

Same day, rendered in a browser on `/usdt-exchange` (session as a wallet-holding
user): the venue table shows Prometheus **plus three competitor rows** — BUY
Prometheus 99.81 against CoinDCX 101.3150655 / WazirX 101.444960253 / ZebPay
101.537 (advantages +1.508% / +1.638% / +1.730%), SELL Prometheus 103.04 against
the same three bids (floored at ZebPay 101.537, advantages +1.713% / +1.662% /
+1.480%) — with `Status live`, `Venues compared 3`, reference
`average_of_3_venues(...)` and the **"Guarantee rule · at least ₹1.50 better
than the best venue"** status row present in both directions. One transient
upstream blip during the same session rendered `Status fallback` carrying
`reference_reused_last_good`, i.e. the reuse path visibly labelled rather than
silently replayed.

Note on the e2e total: the 2026-10-18, 2026-10-20, 2026-10-21 and 2026-10-26
runs happened **outside** the US cash session, so OPEN-1 below passed
incidentally (`MARKET_CLOSED` is allow-listed). The 2026-10-27/28 run happened
**inside** it, so OPEN-1 failed exactly as its trigger table predicts. OPEN-1 is
**not fixed** — it will fail again on any weekday between 13:30–20:00 UTC until
option A, B or C is applied. Do not read a green e2e run as OPEN-1 being
resolved.

No test is skipped, `xit`, `only` or `todo` anywhere in the repository
(searched 2026-10-12): the two OPEN entries below are the only outstanding
**failures**; the sentinel timeout noted in the snapshot is a load flake
(reproduced green in isolation), not a third open defect.

Module 13 baseline moves (all additive, no old assertions weakened):

- `schema.e2e-spec.ts` pins updated to match the migration, not relaxed: table
  list now 11 entries (+`admin_audit_logs`, `role_requests`, `user_profiles`,
  `user_roles`) and timestamptz count 14 → 18 (+`admin_audit_logs.created_at`,
  `role_requests.created_at`, both columns on `user_profiles`).
- `rbac.e2e-spec.ts` negative-path HTTP sequences run inside `withoutFixture()`
  (see caveat 3) so the e2e role fixture cannot undo a `revokeExpert()` before
  the guard runs; assertions themselves are unchanged.

---

## OPEN-1 — `paper.e2e-spec.ts`: "rejects an order whose symbol has no quote with MARKET_DATA_UNAVAILABLE"

**Status:** OPEN — deferred to the end because fixing it requires editing frozen
Module 06c files (test or provider), which is not permitted without approval.

**Location:** `backend/test/paper.e2e-spec.ts:474` (suite `Paper Trading (e2e)`
→ block `rejections`)

**Exact failure (2026-10-14 13:33 UTC, same assertion as 2026-10-13 and
2026-10-12):**

```
● Paper Trading (e2e) › rejections › rejects an order whose symbol has no quote with MARKET_DATA_UNAVAILABLE
  expect(received).toBe(expected) // Object.is equality
  Expected: "REJECTED"
  Received: "FILLED"
    at test/paper.e2e-spec.ts:485  expect(order.status).toBe('REJECTED');
```

**Trigger condition — TIME OF DAY.** The test passes or fails depending on the
US cash session (13:30–20:00 UTC, Mon–Fri):

| Run window | Outcome |
|---|---|
| US session OPEN (e.g. 16:58 UTC) | **FAILS** — order FILLEDs, status is not `REJECTED` |
| US session CLOSED | passes — order rejects `MARKET_CLOSED`, which the test's allow-list accepts |

**Root cause.** The test's premise is false:

- The test orders `AMZN` on the comment *"a known instrument the fake provider
  has no price for"* (`paper.e2e-spec.ts:478`).
- But `FakeMarketDataProvider.basePrice` **does** contain AMZN:
  `src/modules/live-data/providers/fake-market-data-provider.ts:44` → `AMZN: 198.0`.
- `latestQuote()` (same file, line 97) therefore always derives a quote for AMZN.
  Only a symbol missing from `basePrice` returns `null` → `MARKET_DATA_UNAVAILABLE`.
- The order pipeline checks the session rule *before* the price lookup, so:
  - session **closed** → `REJECTED / MARKET_CLOSED` → allow-list at line 486 passes;
  - session **open**  → price found → `FILLED` → line 485 fails.

**Evidence it is not caused by Modules 06b/07 work:**

- Fails in isolation (`npm run test:e2e -- --runInBand --testPathPatterns=paper`
  → 23/24) with the same assertion, during session hours.
- `paper.e2e-spec.ts` and `fake-market-data-provider.ts` mtimes are **Oct 10** —
  untouched by Module 07 (which changed only `src/modules/copy/**`, schema,
  migrations, `app.module.ts`, env config and frontend files).
- Every other test in the suite passes at the same timestamp; only this one
  depends on wall-clock time (404 passing at the 2026-10-13 Module 08 run).

**Repro:**

```powershell
# Fails any time between 13:30 and 20:00 UTC on a weekday:
cd backend
npm run test:e2e -- --runInBand --testPathPatterns=paper
# Expect: 23 passed, 1 failed (the AMZN test above)

# Outside those hours the same command passes 24/24.
```

**Fix options (decide when fixing):**

| # | Option | Touches | Trade-off |
|---|---|---|---|
| **A (recommended)** | Remove `AMZN: 198.0` from `basePrice` in `fake-market-data-provider.ts:44` | 06c provider, 1 line | Test passes deterministically in **any** session (`MARKET_DATA_UNAVAILABLE` when open, `MARKET_CLOSED` when closed — both already allow-listed). Side effect: the dev-mode fake feed shows AMZN as unavailable. No other test asserts an AMZN quote (grep: only the catalogue-existence test and this one). |
| B | Add an explicit test hook to the provider, e.g. `seedUnpriceable(symbol)`, checked before `basePrice` | 06c provider + test | Keeps AMZN priced in dev; makes "no quote" a first-class programmable state. Slightly more code; still a 06c source edit. |
| C | Change the test to stage a stale quote (`asOf` hours old) so it always rejects `STALE_MARKET_DATA` | 06c test only | Always green, but the test name/premise becomes wrong and it duplicates the existing STALE_MARKET_DATA test at line 453 — the "genuinely unpriceable symbol" case would lose coverage. **Not recommended.** |

**Why deferred instead of fixed:** Modules 00–06c are frozen — their behavior,
tests and files may not be modified. Options A and B edit 06c source; option C
weakens a 06c assertion. All three need explicit approval, which is why the
failure is parked here.

---

## OPEN-2 — `ember-ecosystem.e2e-spec.ts`: "refuses a mint broadcast with 503 and creates no request row"

**Status:** OPEN — a leftover row in the **development database**, not a code
defect. Observed failing from 2026-10-23 onwards (confirmed again 2026-10-26).

**Location:** `backend/test/ember-ecosystem.e2e-spec.ts:487` (suite
`EMBER ecosystem - hub, staking, blockchain admin (e2e)` → block
`Blockchain admin with BLOCKCHAIN_ENABLED=false`; moved from `:472` by the
design-integration additions to that file)

**Exact failure (2026-10-25):**

```
● refuses a mint broadcast with 503 and creates no request row
    expect(list.body.items).toHaveLength(0);
    Expected length: 0
    Received length: 1
    Received: [{ status: "CONFIRMED", network: "sepolia", chainId: 11155111,
                 txHash: "0xcd1cfca1…", requestedAt: "2026-10-23T08:16:29.846Z", … }]
```

**Root cause.** The assertion proves a *broadcast refusal under
`BLOCKCHAIN_ENABLED=false` creates no row* by listing
`GET /api/admin/blockchain/mints` and expecting an empty list — but the list is
not scoped to the test's own request, and the shared dev database still holds a
`CONFIRMED` Sepolia mint created by a real broadcast two days earlier. The
guard under test still behaves correctly (the broadcast itself is refused with
503 and writes nothing); only the "list is empty" premise is stale.

**Not caused by** the session-scoped-role work or any module change: the
operator token still authenticates (200), and the offending row predates the
change.

**Repro:**

```powershell
cd backend
npm run test:e2e -- --testPathPatterns=ember-ecosystem
# Fails while that 2026-10-23 CONFIRMED mint row exists.
```

**Fix options (decide when fixing):**

| # | Option | Touches | Trade-off |
|---|---|---|---|
| **A (recommended)** | Delete the stale dev row (the `CONFIRMED` mint with `txHash 0xcd1cfca1…`), or reset the dev database | database only | Restores the test's premise with no code change. Test remains green until the next real broadcast pollutes it again. |
| B | Scope the test's list assertion to rows it created (filter by its own request/user id) | test file | Makes the assertion immune to unrelated rows; slightly weaker as a "nothing was created" proof (it would no longer notice a row created under another id). |
| C | Run the suite against a freshly seeded database (test DB reset in e2e setup) | e2e harness | Deterministic everywhere, but a bigger harness change. |

**Why deferred:** choosing between "clean the dev database" and "scope the
assertion" is a project decision, and neither is required for correctness —
the 503 refusal path itself passes.

---

## Known caveats locked into PASSING tests (not failures, but worth revisiting)

These pass today and need no fix; they are recorded so nobody mistakes them for
bugs later.

1. **`INSUFFICIENT_COPY_CASH` is unreachable through the API alone** — with the
   mirror-price model and equal 100,000 seeds, a follower can always afford the
   expert's fill. `backend/test/copy.e2e-spec.ts` (case `copy-poor`) sets
   `copyAccount.cash = '0'` **directly in the database** to exercise the branch,
   with an explanatory comment. If copy cash seeding ever changes (unequal
   seeds, configurable initial cash), revisit whether the API can reach this
   path naturally.
2. **Benign unit-runner warning:** `npm test` prints *"A worker process has
   failed to exit gracefully…"*. Pre-existing, exit code is 0, all tests pass;
   caused by a teardown timer (`.unref()` candidates live in the copy
   worker and market-data pollers). Cosmetic only.
3. **The e2e role fixture re-grants `EXPERT_TRADER` on every login** — when
   `NODE_ENV=test` and `RBAC_TEST_DEFAULT_ROLES=EXPERT_TRADER` (set in
   `test/setup-env.ts`), `AuthService.loadRoles` upserts the fixture role during
   `resolveIdentity`, i.e. on **every** authenticated request. This keeps the 21
   frozen `POST /api/strategies` call sites in older suites green, but it
   silently undoes a `revokeExpert()` mid-test. `rbac.e2e-spec.ts` therefore
   wraps negative-path HTTP sequences in its local `withoutFixture()` helper
   (deletes the env vars for the duration of the call, restores them in
   `finally`). Any future test asserting 403 on a gated route after revoking a
   role must do the same. Read `auth.service.ts` `testFixtureRole()` for the
   exact gate.

4. **A sentinel expiry test flakes under full-run load.** In the 2026-10-27/28
   full e2e run one sentinel expiry case timed out on its 15s budget while every
   other suite was competing for the database; re-run in isolation
   (`npm run test:e2e -- --testPathPatterns=sentinel`) it is **25 / 25 green**.
   Same contention signature as the USDT idempotent-replay flake recorded on
   2026-10-27 — timeout budget vs. parallel load, not a defect. If it recurs
   often, raise that test's timeout rather than loosening its assertion.

---

## RESOLVED during Module 07 development (history — no action needed)

Failures that appeared while building Module 07 and were fixed at the time, so a
future regression of any of these is recognizable:

| What failed (brief) | Resolution |
|---|---|
| Copy-history assertion: rejected events must not report `quantity: 0` | DTO now maps `quantity: null` for `REJECTED` (`copy-event-response.dto.ts`) |
| Sync route asserted 200 but defaulted to 201 | `@HttpCode(HttpStatus.OK)` added on `POST /copy/follows/:id/sync` |
| `copy-poor` case never reached `INSUFFICIENT_COPY_CASH` (cash '10' still affordable) | fixture cash changed to `'0'` |
| `copy-unpriced` expected `account: null` | contract clarified: account **is** provisioned before sizing → test asserts `$100,000` account |
| Aggregate-race assertion expected 2 separate positions | positions merge per symbol → asserts one merged row with `followCount: 2` |
| `follow-config` case ordered follow after `placeOrder` (pre-follow fills are never copied) | reordered: follow first, then place, then sync |
| `copy-order` millisecond timestamp ties produced unstable ordering | `await delay(5)` between order placements |
| Duplicate `follower` destructures / unused locals in copy e2e + controller | deduped |
| `it.each` typing error in copy e2e | tuple typed explicitly |
| `app/tokenomics/page.tsx` failed `tsc` — backticks around `currentcolor` / `.ring` inside the CSS comment **closed the `EMBER_OVERRIDES` template literal early** (TS1005 at 875:39/51), breaking `next build` (observed 2026-10-25, pre-existing) | comment rewritten with plain quotes (`'currentcolor'`, unquoted `.ring`) — no CSS/behaviour change |

---

## Fix checklist for the end of the project

- [ ] **OPEN-1** — decide option A, B or C (needs approval to touch frozen 06c), apply, then re-run:
  ```powershell
  cd backend
  npm run test:e2e                        # must be 638/638 (with OPEN-2 fixed too)
  npx jest --silent                       # must stay 945/945
  ```
- [ ] **OPEN-2** — clear the stale Sepolia mint row (or scope the assertion), then re-run `ember-ecosystem`.
- [ ] Re-run outside and inside US market hours to confirm the fix removed the time dependency.
- [ ] Optional: silence the unit-runner teardown warning (`.unref()` on the leaking timer).
