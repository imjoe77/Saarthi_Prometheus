# Sepolia testnet deployment and verification (EMBER)

Everything here is testnet-only. `hardhat.config.ts` defines **no mainnet
network**: the only reachable chains are the in-process `hardhat` chain,
`localhost:8545`, and `sepolia` (chain id **11155111**).

## 1. What must exist before deploying

| Item | Where it lives | Secret? | Current state |
|---|---|---|---|
| `SEPOLIA_RPC_URL` | `blockchain/.env` | no (public node default) | set (`https://ethereum-sepolia-rpc.publicnode.com`) |
| `SEPOLIA_DEPLOYER_KEY_FILE` | `blockchain/.env` → path | path only; key is a file | set (`~\.prometheus\sepolia\deployer.key`) |
| `TREASURY_ADDRESS` / `MINTER_ADDRESS` | `blockchain/.env` | no (public) | set (`~\.prometheus\sepolia\addresses.txt`) |
| `MAX_SUPPLY_EMBER` / `INITIAL_TREASURY_ALLOCATION_EMBER` | `blockchain/.env` | no | set (100000000 / 10000000) |
| **Sepolia ETH on the deployer** | on-chain | — | **must be supplied (faucet)** |

Generated accounts (public addresses; private keys are ACL-restricted files in
`%USERPROFILE%\.prometheus\sepolia\`, backed up by `mnemonic.txt` there):

- deployer (pays gas, holds `DEFAULT_ADMIN_ROLE`): `0x2c35a0467D907C091cf5c6c6ceBF19320fF7661E`
- minter (holds `MINTER_ROLE`, backend signer): `0xdEFe002d9A0fBb6A880FB00836a3EA940333Da06`
- treasury (holds `BURNER_ROLE`, receives/burns supply): `0x7Fb75d286974243c9f45f38Ae7292EBFFd4FCA8B`

**Only the deployer needs a faucet claim** (~0.05 ETH is ample);
`npm run fund:sepolia` then forwards gas money to the minter and treasury.

Faucets (change often, one claim per address is enough):
- https://sepoliafaucet.com (Alchemy)
- https://faucets.chain.link/sepolia
- https://faucet.quicknode.com/ethereum/sepolia

Use your own funded account instead if you prefer: point
`SEPOLIA_DEPLOYER_KEY_FILE` at your key file (or set `TREASURY_ADDRESS` /
`MINTER_ADDRESS` to your addresses) in `blockchain/.env`.

## 2. Deploy

```powershell
cd blockchain
npm run deploy:sepolia
```

Refuses to run when configuration or the deployer key is missing, or when the
deployer has no ETH. On success it writes `deployments/sepolia.json` (the
local record `deployments/hardhat.json` is never touched) and prints the
backend environment lines to use.

## 3. Fund the role signers (once)

```powershell
cd blockchain
npm run fund:sepolia
```

## 4. Verify on-chain (read-only: chain id, bytecode, roles, permission gates)

```powershell
cd blockchain
npm run verify:sepolia
```

Prints PASS/FAIL per check plus the Etherscan links. It signs nothing.

## 5. Point the backend at the Sepolia deployment

The local `backend/.env` is **not modified**. Sepolia mode is opt-in:

```powershell
# from the repository root
powershell -ExecutionPolicy Bypass -File backend\scripts\start-api-sepolia.ps1
```

The launcher:
- reads `backend/.env.sepolia` (RPC, confirmations, key file paths - no secrets),
- reads `blockchain/deployments/sepolia.json` (addresses, chain id, deploy block),
- **refuses** to start unless the record says network `sepolia` / chain id 11155111,
  the live RPC answers chain id 11155111, the token address has bytecode, the key
  files exist and match the recorded minter/treasury addresses (and never on chain id 1),
- starts backend `npm run start` (single build + run, never watch: a second
  watcher would share `backend/dist` with the local stack) with those
  `BLOCKCHAIN_*` values injected into the process environment only.

Plain `npm run dev:api` afterwards still starts in the original local/disabled
configuration - nothing silent switches.

## 6. End-to-end checks against the running backend

Admin routes (`/api/admin/blockchain/*`) need a `PLATFORM_ADMIN` session.

- `GET  /api/admin/blockchain/status` - enabled, sepolia, 11155111, signers, rpcReachable
- `POST /api/admin/blockchain/mints` - real mint: PENDING -> SUBMITTED -> CONFIRMED
  (2 confirmations), transaction hash returned on the request record
- `POST /api/admin/blockchain/recovery` - no stuck SUBMITTED rows
- `POST /api/admin/blockchain/events/sync` - TokensMinted/TokensBurned ingested
- `GET  /api/admin/blockchain/reconciliation` - on-chain vs ledger, differences listed
- `POST /api/tokenomics/burns` - real `burnTreasury` signed by the treasury key

## 7. Security rules

- Never commit `.env`, never paste a private key/seed into a file in the
  repository, a shell command, or a chat. Keys are referenced by path only.
- `%USERPROFILE%\.prometheus\sepolia\` is ACL-restricted to your user + SYSTEM.
  Back up `mnemonic.txt` somewhere safe; losing it loses the accounts.
- Mainnet is intentionally unconfigurable here. Adding it is an owner decision.

## 8. Back to local development

Stop the sepolia launcher (Ctrl+C) and start the stack normally
(`npm run dev`). The local Hardhat record and `backend/.env` were never
changed.

## 9. Verification results (2026-10-22, recorded after the live run)

All checks below were executed for real against Sepolia; nothing here is
aspirational.

| Check | Result |
|---|---|
| Deploy | `EmberToken` at `0x4A90080e30F107BE32Ee332Bc2cE92058e12Bc82`, tx `0xec9fa8…63aa`, block 11970734 |
| Explorer | https://sepolia.etherscan.io/address/0x4A90080e30F107BE32Ee332Bc2cE92058e12Bc82 (contract "Ember", status ok) |
| `npm run verify:sepolia` | **22/22 PASS** (chain id, 7553-byte runtime bytecode == compiled artifact, metadata, cap, roles, role separation, negative permission `eth_call`s, cap-guard) |
| Backend status | `enabled`, network `sepolia`, 11155111, both signers configured, `rpcReachable` |
| Mint (admin route) | 1 EMBER CONFIRMED, tx `0xac54a0b9…72a0`, block 11971010, 2 confirmations in ~28 s |
| Recovery / events sync | recovery `stillOpen: 0`; sync ingested `TokensMinted` + `TokensBurned` |
| Burn (tokenomics DIRECT) | 10 EMBER, tx `0x40b26063…51e0`, block 11971014, signed by the treasury key |
| Supply math | on-chain total supply `10000001 → 9999991` (exactly −10); reconciliation reported ledger-vs-chain differences without mutating either side |

Regression after the live run: backend typecheck clean, unit 829/829,
hardhat 24/24, e2e 581/582 (the one failure is the documented time-of-day
`paper.e2e` OPEN-1 in `TEST_FAILURES.md`, which fails inside the US cash
session — unrelated to Sepolia).

### Shared-database caveat (read before re-running live operations)

The Sepolia profile shares the dev postgres with the local stack and with the
e2e suites. Live chain records therefore land in tables the suites read:

- `ember-ecosystem.e2e-spec.ts` asserts **zero** `ember_mint_requests` rows
  (it exercises the chain-disabled 503 path). After the verification mint was
  deleted from that table the suite was green again (21/21); its chain events
  were kept (`blockchain_events.mint_request_id` is nullable, `SetNull`).
- `treasury@prometheus.local` plus its wallet (1000 EMBER off-chain inventory)
  was left provisioned — every suite passed with it present.

So: any new live mint will redden that suite until the request row is removed
again (the row is local bookkeeping; the on-chain tx is the real evidence).
