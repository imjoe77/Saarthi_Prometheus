# Test Failures — Working Ledger

Purpose: every test case that has failed and has **not** been fixed yet, gathered
in one place so they can all be fixed at the end of the project. Anything listed
under `OPEN` must be fixed before the project is called complete; anything under
`RESOLVED` is history and needs no action.

Last updated: **2026-10-31** (the **copy trading** work: Module 07's engine switched from
BUY/SELL to **LONG/SHORT** with directional positions, the paper module gained live
marking and a close-position route, and both engines now gate a fill on the caller's
real USDT balance. The unit snapshot below was re-verified green on 2026-10-31; the
e2e run is now **676 / 683** with two open failures, one of them new — see **OPEN-3**).

Previously **2026-10-31** (the admin **USDT distribution** surface: new
`GET /api/liquidity/distribution`, PLATFORM_ADMIN-only and read-only, with 3
new unit cases and 2 new e2e cases in the liquidity suites — liquidity alone is
now **15 / 15**; the unit snapshot below was re-verified green on 2026-10-31).

Previously **2026-10-28** (full-suite run after the role/auth rework: the
login page now offers a fourth, env-only **Platform Admin** card; every persona
card scopes the session to its own surface ("one click, one surface"); and a
Gmail address may hold only **one** privileged role, refused through the
existing denial flow with a "try a different account" message).

---

## Snapshot at last full run

| Suite | Command | Result |
|---|---|---|
| Backend unit | `cd backend && npx jest --silent` | **978 / 978 passed** in 63 suites (re-verified 2026-10-31; was 945 in 61 suites at the 2026-10-28 run. +3 here: the `getDistribution()` coverage in `liquidity.service.spec.ts`, 5 → 8. The remaining +30 / +2 suites are the concurrent payments and liquidity-DTO work merged the same day — every suite green, no assertion weakened) |
| Backend typecheck | `cd backend && npm run typecheck` | **clean** |
| Backend e2e | `cd backend && npm run test:e2e` | **676 / 683 passed** — 683 because the copy and paper suites grew with the LONG/SHORT work. The 7 failures are OPEN-2 below (the stale Sepolia mint row, unchanged) and OPEN-3 below (**new**: the AI doubt solver, 6 failures). The copy suite is **green** (`copy` + `paper` = **62 / 62**), the sentinel expiry test was green in this run, and the unit suites stayed green |
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
(searched 2026-10-12): the OPEN entries below are the only outstanding
**failures**; the sentinel timeout noted in the snapshot is a load flake
(reproduced green in isolation), not an open defect.

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

## OPEN-3 — `ai-doubt-solver.e2e-spec.ts`: the widget suite cannot answer

**Status:** OPEN — environment-dependent, not a code defect. First observed
2026-10-31; the health-probe case was already failing before that, and the
five answer cases fail whenever the configured model provider is not reachable
from the machine running the suite.

**Location:** `backend/test/ai-doubt-solver.e2e-spec.ts` — five cases under
`POST /api/ai-doubt-solver`, plus `GET /api/health (widget status probe)`.

**Exact failures (2026-10-31, standalone run):**

```
● AI doubt solver (e2e) › POST /api/ai-doubt-solver › answers a covered question with the widget contract
  thrown: "Exceeded timeout of 15000 ms for a test."

● AI doubt solver (e2e) › GET /api/health (widget status probe) › reports the AI provider as configured and names the answer source
  expect(received).toBe(expected) // Object.is equality
  Expected: "knowledge-base"
  Received: "model"
```

**Root cause — two separate facts, one environment.**

1. The local `backend/.env` sets **`AI_MODEL_URL`**. `health.service.ts:51`
   reports the answer source as `aiProvider: this.config.aiModelUrl ?
   'model' : 'knowledge-base'`, so the health probe sees `'model'` while the
   test expects the no-model value `'knowledge-base'`. The test's premise —
   "no model configured, so the answer comes from the knowledge base" — is
   false on a machine that configures one.
2. `ai-doubt-solver.service.ts:77` calls that model URL with
   `AbortSignal.timeout(this.config.aiModelTimeoutMs)`, and
   `app.config.ts:771` defaults **`AI_MODEL_TIMEOUT_MS` to 20_000**. When the
   provider is unreachable, each request therefore hangs for 20 s before the
   knowledge-base fallback can run — while jest's per-test budget is **15 s**.
   The five answer cases time out first, so the fallback never gets a chance
   to answer. The service is fine; the two budgets are simply incompatible
   when the provider is down.

**Repro:**

```powershell
cd backend
npm run test:e2e -- --testPathPatterns=ai-doubt-solver
# 19 passed, 6 failed while the configured model provider is unreachable.
```

**Fix options (decide when fixing):**

| # | Option | Touches | Trade-off |
|---|---|---|---|
| **A (recommended)** | Lower `AI_MODEL_TIMEOUT_MS` below the test budget (e.g. `8000`) in the e2e env, so the fallback answers inside 15 s | e2e env only | Keeps the fallback path under test; the answer cases then pass even with the provider down. The health-probe case still needs B or C. |
| B | Make the health probe assert the provider the environment actually configures (`process.env.AI_MODEL_URL ? 'model' : 'knowledge-base'`) | 1 test file | The probe then tests the real contract rather than a hard-coded provider. Weakens nothing that matters: it still proves the probe *names* the source in use. |
| C | Run the suite with `AI_MODEL_URL` unset | e2e env only | Restores the original premise exactly; the model path then goes untested here (it has its own unit coverage in `ai-doubt-solver.service.spec.ts`). |

**Why deferred:** the three fixes touch the e2e environment or a frozen test,
and which one to take is a project decision. Nothing about the copy-trading
work depends on this suite.

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
  npm run test:e2e                        # must be 683/683 (with OPEN-2 and OPEN-3 fixed too)
  npx jest --silent                       # must stay 978/978
  ```
- [ ] **OPEN-2** — clear the stale Sepolia mint row (or scope the assertion), then re-run `ember-ecosystem`.
- [ ] **OPEN-3** — decide option A, B or C for the AI doubt solver, then re-run `ai-doubt-solver`.
- [ ] Re-run outside and inside US market hours to confirm the fix removed the time dependency.
- [ ] Optional: silence the unit-runner teardown warning (`.unref()` on the leaking timer).
