# PROMETHEUS — Digital Asset Command Center & Engineering Walkthrough

> **Executive Overview**: Prometheus is a comprehensive, production-grade prototype for a digital asset command center. It unifies **multi-asset digital wallet accounting**, a **zero-fee USDT exchange with a live best-price guarantee**, an **adaptive copy-trading desk** supporting directional LONG/SHORT execution, a **dual-split EMBER tokenomics engine** (direct burn + simulated buyback with treasury reserve guardrails), **automated voice alerts via Sentinel**, an **AI Trading Buddy doubt solver**, an **ERC-20 smart contract on Hardhat/Sepolia**, and a strict **Role-Based Access Control (RBAC)** architecture supporting four dedicated personas (*Trader*, *Expert Trader*, *Liquidity Provider*, and *Platform Admin*).

---

## Table of Contents

1. [Prototype Boundary & Honest Engineering Philosophy](#1-prototype-boundary--honest-engineering-philosophy)
2. [Technology Stack](#2-technology-stack)
3. [Architecture & Security Foundations](#3-architecture--security-foundations)
4. [Complete Feature Breakdown by Module](#4-complete-feature-breakdown-by-module)
   - [Authentication, RBAC & User Profiles (Modules 02 & 13)](#authentication-rbac--user-profiles-modules-02--13)
   - [Digital Wallet, Accounting Core & Top-Ups (Modules 03 & 03b)](#digital-wallet-accounting-core--top-ups-modules-03--03b)
   - [Portfolio Read-Model & Reporting (Module 04)](#portfolio-read-model--reporting-module-04)
   - [Strategy Registry & Risk Engine (Modules 05 & 06)](#strategy-registry--risk-engine-modules-05--06)
   - [Market Data, Backtesting & Paper Trading (Modules 06b & 06c)](#market-data-backtesting--paper-trading-modules-06b--06c)
   - [Adaptive Copy-Trading Desk (Module 07)](#adaptive-copy-trading-desk-module-07)
   - [Zero-Fee USDT Exchange & Best-Price Guarantee (Module 08)](#zero-fee-usdt-exchange--best-price-guarantee-module-08)
   - [Simulated Liquidity Providers (LP) Engine (Module 09)](#simulated-liquidity-providers-lp-engine-module-09)
   - [EMBER Token Accounting (Module 10)](#ember-token-accounting-module-10)
   - [EMBER Tokenomics, Buyback & Burn Engine (Module 11)](#ember-tokenomics-buyback--burn-engine-module-11)
   - [Treasury Guardrails & Monthly Capacity (Module 12)](#treasury-guardrails--monthly-capacity-module-12)
   - [Sentinel Voice Alerts & Price Monitoring (Module 14)](#sentinel-voice-alerts--price-monitoring-module-14)
   - [Blockchain Integration (EmberToken ERC-20)](#blockchain-integration-embertoken-erc-20)
   - [AI Trading Buddy & Interactive Doubt Solver](#ai-trading-buddy--interactive-doubt-solver)
   - [Platform Administration Portal](#platform-administration-portal)
5. [Prerequisites, Clone & Installation Guide](#5-prerequisites-clone--installation-guide)
   - [Step 1: Clone Repository](#step-1-clone-repository)
   - [Step 2: Backend Database & Environment Setup](#step-2-backend-database--environment-setup)
   - [Step 3: Cryptographic Key Generation](#step-3-cryptographic-key-generation)
   - [Step 4: Frontend Environment Setup](#step-4-frontend-environment-setup)
   - [Step 5: Seeding Database & Market Data](#step-5-seeding-database--market-data)
   - [Step 6: Role Provisioning](#step-6-role-provisioning)
   - [Step 7: Booting the Application](#step-7-booting-the-application)
   - [Step 8: (Optional) Smart Contract & Blockchain Deployment](#step-8-optional-smart-contract--blockchain-deployment)
6. [Navigation, Persona Routing & Sitemap](#6-navigation-persona-routing--sitemap)
7. [Current State, Verification & Test Coverage](#7-current-state-verification--test-coverage)
8. [Codebase Directory Structure](#8-codebase-directory-structure)
9. [Database Schema](#9-database-schema)
   - [Engine & Tooling](#91-engine--tooling)
   - [Conventions Applied Throughout](#92-conventions-applied-throughout)
   - [Table Map by Module](#93-table-map-by-module)
   - [The Ledger Tables](#94-the-ledger-tables)
   - [Referential Integrity](#95-referential-integrity)
   - [Indexing](#96-indexing)
   - [`exchange_revenue_events` — the settlement outbox](#97-exchange_revenue_events--the-settlement-outbox)
   - [Working With the Schema](#98-working-with-the-schema)
10. [Summary & Quickstart Command Cheat Sheet](#10-summary--quickstart-command-cheat-sheet)

---

## 1. Prototype Boundary & Honest Engineering Philosophy

Prometheus is a college / final-year engineering prototype. The platform is designed according to **strict financial transparency and honesty**:

1. **Zero JavaScript Floats for Balances**: Standard IEEE 754 binary floating-point numbers (`0.1 + 0.2 === 0.30000000000000004`) cause balance drift and rounding leaks. In Prometheus, all monetary values and token amounts are stored in PostgreSQL as `NUMERIC(38,18)` via `Prisma.Decimal`, transmitted across the wire as string representations, and calculated using `BigInt`-scaled integer arithmetic or server-side arbitrary-precision math.
2. **No Invented Metrics**: If a financial figure cannot be mathematically derived from real platform data, **it is omitted rather than faked**. Portfolio values are not displayed in USD when only INR and USDT have live rates; strategies without simulated history display `INSUFFICIENT_DATA` rather than mock "+24.5% APY" tiles.
3. **Simulated Rails Clearly Identified**: Simulated systems (e.g. simulated INR top-ups, simulated buyback orders, simulated paper cash) are explicitly labeled in the UI as demo experiences. However, **ledger movements within the platform database are 100% atomic and cryptographically genuine**.

---

## 2. Technology Stack

### Frontend & Client Tier
- **Framework**: [Next.js 16](https://nextjs.org/) (React 19, App Router, Server Actions)
- **Styling & Animation**: [Tailwind CSS v4](https://tailwindcss.com/), GSAP 3.15, Lenis smooth scroll
- **Financial Charting**: [TradingView Lightweight Charts 5.0](https://tradingview.github.io/lightweight-charts/) (candlestick boards, fill markers, equity curves)
- **Icons & UI**: [Lucide React](https://lucide.dev/)
- **Auth & Session**: [Auth.js v5 beta](https://authjs.dev/) (`next-auth@5.0.0-beta.32`), JOSE 6.2 for asymmetric JWT operations

### Backend API Tier
- **Framework**: [NestJS 11](https://nestjs.com/) (Modular Monolith architecture, Express platform)
- **Validation & Transformation**: `class-validator`, `class-transformer`, `joi` boot-time environment schema verification
- **Documentation**: Swagger / OpenAPI (`/api/docs`)
- **Health & Monitoring**: `@nestjs/terminus` (liveness & database readiness probes at `/api/health`)
- **Security & Tokens**: Asymmetric RS256 JWT verifier with SPKI public keys

### Database & Persistence
- **Database**: PostgreSQL 14+ (containerized via Docker Compose)
- **ORM**: [Prisma 6.15](https://www.prisma.io/)
- **Data Integrity**: Hand-written SQL migrations enforcing non-negative balance checks, positive transaction magnitudes, string length boundaries, and expression indexes (`lower(btrim(name))`).

### Blockchain & Smart Contracts
- **Framework**: [Hardhat](https://hardhat.org/), Viem, TypeChain
- **Solidity**: OpenZeppelin ERC-20 (`EmberToken.sol`) with capped supply (100M EMBER), owner-controlled minting with monthly limits, and burning capabilities.
- **Networks**: Local Hardhat node & Ethereum Sepolia Testnet.

### External Providers & Integrations
- **OAuth**: Google Cloud Console & GitHub Developer Apps
- **Market Pricing**: CoinDCX order-book live VWAP, CoinGecko reference API, Finnhub market feeds
- **Payments**: Razorpay test gateway + deterministic simulated payment rail
- **Telephony & Alerts**: Twilio Voice API + deterministic local speech synthesis / ringtone audio engine

---

## 3. Architecture & Security Foundations

```
                           Browser (User Agent)
            │ Holds ONLY HttpOnly cookies (No bearer tokens in JS)
            ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      Next.js 16 (Port 3000)                            │
│                                                                        │
│  [Client Components] ──► [Server Actions / Proxy]                      │
│                                │                                       │
│  OAuth Callback ───────────────┼──► Auth.js (`authjs.session-token`)   │
│                                ▼                                       │
│  BFF Route: `app/api/backend/[...path]/route.ts`                       │
│    - Validates Auth.js session                                         │
│    - Mints 15-minute asymmetric RS256 JWT (`prometheus_api_token`)     │
│    - Injects `Authorization: Bearer <token>` server-to-server          │
└────────────────────────────────┼───────────────────────────────────────┘
                                 │ HTTP (Private Network / Loopback)
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      NestJS 11 API (Port 3001)                         │
│                                                                        │
│  Global Guards:                                                        │
│    ├── `AccessTokenVerifier` (Verifies RS256 with Public Key only)     │
│    ├── `AuthGuard` (Resolves user identity & User.id)                  │
│    └── `RolesGuard` (Enforces USER, EXPERT, LP, PLATFORM_ADMIN)        │
│                                                                        │
│  Service Modules:                                                      │
│    WalletService ──► UsdtService ──► CopyService ──► Tokenomics        │
│                                                                        │
│  Persistence:                                                          │
│    Prisma ORM ──► PostgreSQL (ACID Transactions, CHECK constraints)    │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Security Guardrails
1. **BFF (Backend-for-Frontend) Proxy**: The browser never connects directly to the NestJS backend. All authenticated calls pass through `/api/backend/*`. The backend address and secrets are server-only.
2. **Asymmetric Key Separation**: The Next.js BFF holds the **RS256 Private Key** (`AUTH_API_SIGNING_PRIVATE_KEY`) to sign 15-minute access tokens. The backend holds **only the RS256 Public Key** (`AUTH_API_SIGNING_PUBLIC_KEY`). Even a complete compromise of the backend database or environment cannot forge a signature.
3. **No Bearer Tokens in JavaScript**: Tokens reside in `HttpOnly; SameSite=Lax; Secure` cookies. Client-side XSS attacks have no credentials to extract.
4. **Strict Concurrency & Dev-Guard**: Next.js and NestJS require synchronized compilation. `scripts/dev-guard.mjs` prevents accidental dual-server launches that could corrupt the route manifest, and `scripts/wait-for-api.mjs` prevents the frontend from serving before the API backend passes health checks.

---

## 4. Complete Feature Breakdown by Module

### Authentication, RBAC & User Profiles (Modules 02 & 13)
- **OAuth Providers**: Seamless login with Google or GitHub OAuth.
- **Themed 4-Card Login Funnel**: Dedicated login portal (`/login`) featuring interactive visual personas:
  1. *Trader (Normal User)*: Unrestricted registration, accesses wallet, copy-trading, USDT exchange, terminal.
  2. *Expert Trader*: Strategy creation, paper portfolio management, publishing signals.
  3. *Liquidity Provider*: EMBER locking, USDT commitment provision, liquidity fee earnings.
  4. *Platform Admin*: Configuration, system health, treasury controls, user role management.
- **One-Privileged-Role-Per-Gmail Policy**: To enforce strict security boundaries, a single Gmail address cannot hold multiple privileged roles (e.g. an Expert Trader cannot also be an Admin). Attempts trigger a clean denial redirect: *"Try a different account"*.
- **Self-Service Role Requests**: Users can request upgrades to Expert Trader or Liquidity Provider directly from their settings, landing in the Admin Decision Queue.
- **Onboarding Wizard & Financial Preferences**: 3-step questionnaire (`/onboarding` and `/preferences`) collecting trading experience, risk appetite, and alert thresholds.

### Digital Wallet, Accounting Core & Top-Ups (Modules 03 & 03b)
- **Idempotent Wallet Creation**: Every user provisions a dedicated wallet. `POST /api/wallets` is idempotent; duplicate requests safely return the existing wallet.
- **Multi-Asset Architecture**: Native support for reference assets (`INR`, `USDT`, `EMBER`).
- **Two-Column Ledger**: Every asset tracks `available` and `locked` balances separately.
- **Immutable Transaction History**: Keyset-paginated transaction ledger recording movements (`DEPOSIT`, `WITHDRAWAL`, `TRANSFER`, `BUY`, `SELL`, `LOCK`, `UNLOCK`, `BURN`, `ADJUSTMENT`).
- **Deposit Rails**:
  - *Simulated Rail*: Immediate deposit credit for sandbox testing.
  - *Razorpay Rail*: Generates a server-side order, opens the Razorpay modal, and verifies the HMAC-SHA256 signature upon completion.

### Portfolio Read-Model & Reporting (Module 04)
- **Zero-Storage Projection**: Computes live holdings, portfolio composition, and 30-day activity directly from ledger balances.
- **Locked Share Visualization**: Accurately depicts available vs. locked capital (e.g. USDT locked in copy trading, EMBER locked in liquidity commitments).
- **Honest Valuation**: Omits misleading USD net worth estimates when reference prices are absent.

### Strategy Registry & Risk Engine (Modules 05 & 06)
- **Strategy Lifecycle**: Traders can create strategies (`DRAFT`), configure visibility (`PUBLIC` vs. `PRIVATE`), and retire them (`ARCHIVED`).
- **Unique Name Constraint**: Hand-written PostgreSQL functional index `(owner_id, lower(btrim(name)))` prevents duplicate names regardless of letter casing or whitespace.
- **One-Way Retirement**: Archiving a strategy is irreversible, preventing tampering with retired track records.
- **Automated Risk Engine**:
  - Ingests daily balance history.
  - Computes **Maximum Drawdown (MDD)** and **Annualized Volatility**.
  - Classifies strategies into standardized categories: `CONSERVATIVE`, `MODERATE`, `AGGRESSIVE`, or `SPECULATIVE`.

### Market Data, Backtesting & Paper Trading (Modules 06b & 06c)
- **Historical Market Data**: Offline dataset of 1,932 daily candles across multiple market regimes.
- **Deterministic Simulation Engine**: Evaluates signal-at-close and executes fills at the next candle's open.
- **Live Terminal & Candlestick Boards**: 8 live instruments (5 equities: AAPL, MSFT, GOOGL, AMZN, TSLA; 3 crypto pairs: BTC/USDT, ETH/USDT, SOL/USDT) rendered via TradingView Lightweight Charts with switchable timeframes (`1m`, `5m`, `15m`, `1h`, `1d`).
- **Expert Paper Trading Accounts**: Each expert receives a simulated $100,000 USD paper trading account supporting market and limit orders, execution tracking, and live unrealized P&L calculations.

### Adaptive Copy-Trading Desk (Module 07)
- **Directional Positions (LONG / SHORT)**: Beyond basic spot buying, the copy engine tracks leveraged or directional market positions.
- **Allocation Scaling (1% – 100%)**: Followers dynamically adjust how much capital mirrors each expert fill.
- **Background Execution Worker**: Automatically picks up expert paper trade fills and creates proportional follower copy orders in an isolated execution pot.
- **Balance Gating**: Orders are checked against the follower's real USDT wallet balance; insufficient capital automatically halts or resizes execution.
- **Interactive Copy Charts**: Visualizes execution history with color-coded buy/sell fill markers overlaid on the live candlestick series.
- **Trade Explanation & Replay**: Detailed breakdown of why specific trades were executed, downscaled, or skipped.

### Zero-Fee USDT Exchange & Best-Price Guarantee (Module 08)
- **Order-Book Execution Pricing**: Calculates exact execution prices using volume-weighted average price (VWAP) derived from live CoinDCX depth books.
- **Best-Price Guarantee**: Guarantees that Prometheus rates are **at least ₹1.50 better** than competitor venues (CoinDCX, WazirX, ZebPay).
- **Atomic Balance Settlement**: Executing a BUY or SELL updates INR and USDT balances atomically in a single ACID transaction.
- **Circuit Breaker Fallback**: In the event of upstream market blips, transactions are rejected with clear error messaging rather than executing against stale rates.

### Simulated Liquidity Providers (LP) Engine (Module 09)
- **Tiered EMBER Locking Slabs**: Liquidity commitments require collateralizing native EMBER tokens according to tiered thresholds:
  - Tier 1: 0 – 100,000 USDT commitment → 1,000 EMBER locked
  - Tier 2: 100,000 – 250,000 USDT commitment → 20,000 EMBER locked
  - Tier 3: 250,000 – 500,000 USDT commitment → 45,000 EMBER locked
  - Tier 4: 500,000+ USDT commitment → 80,000 EMBER locked
- **Oldest-First FIFO Allocation**: Inbound customer USDT purchases are automatically routed across eligible commitments starting from the oldest registered provider.
- **Shortfall Monitoring**: Automated platform detection triggers top-up requests if aggregate available USDT drops below configured safety thresholds.

### EMBER Token Accounting (Module 10)
- **Peer-to-Peer Transfers**: Transfer EMBER tokens between registered accounts using their email addresses.
- **Idempotency Safeguard**: Every transfer requires a client-generated UUID, preventing double-spend errors during connection retries.
- **Supply Reconciliation**: Aggregated directly from database balances:
  $$\text{Circulating Supply} = \text{Total Issued} - \text{Total Burned} - \text{Total Locked}$$

### EMBER Tokenomics, Buyback & Burn Engine (Module 11)
- **Configurable Revenue Split**: Configurable split (default 60% direct burn / 40% simulated buyback).
- **Simulated Buyback Execution**: Records open-market buyback simulation events without affecting external exchanges.
- **Atomic Burn Leg**: The burn operation irreversibly debits the platform treasury wallet and decrements the global token supply within a single database transaction.
- **Volume-Linked Exchange Outbox**: Background worker monitors exchange volume and schedules proportional token burns automatically.

### Treasury Guardrails & Monthly Capacity (Module 12)
- **30% Qualifying Reserve Floor**: Hard architectural stop. The burn worker refuses any burn operation that would reduce treasury funds below 30% of lifetime qualifying funding.
- **Capacity Tracking**: Monitors monthly platform outflow capacity (demo standard: ₹30 Crore).
- **Admin Capital Injection**: Platform admins can inject additional capital into the treasury wallet with recorded ledger adjustment notes.

### Sentinel Voice Alerts & Price Monitoring (Module 14)
- **Real-World Price Alerts**: Monitors real-time asset prices against user-defined alert thresholds.
- **Voice Telephony**: Automated phone calls powered by Twilio Voice API (or a deterministic mock audio provider).
- **Abuse Prevention**:
  - Daily per-user call limits (max 5 calls/day) and platform-wide limits (200 calls/day).
  - Quiet hours configuration (suppresses voice calls during sleep hours).
  - Explicit SMS/voice verification code confirmation before enabling telephone alerts.
  - In-browser simulated voice synthesizer and realistic emergency ringtone alerts.

### Blockchain Integration (EmberToken ERC-20)
- **Smart Contract**: Solidity ERC-20 contract (`EmberToken.sol`) deployed to Ethereum Sepolia / local Hardhat node.
- **Admin Minting Controls**: Owner-controlled minting functions with monthly volume ceilings.
- **Ledger-to-Chain Reconciliation**: Background comparison comparing off-chain PostgreSQL balances against on-chain token contract state.

### AI Trading Buddy & Interactive Doubt Solver
- **Contextual Knowledge Assistant**: Floating assistant embedded across all core pages (`/copy-trading`, `/terminal`, `/usdt-exchange`, `/tokenomics`).
- **Dual Inference Engine**:
  - Connects to an external local LLM endpoint (`AI_MODEL_URL`) when configured.
  - Automatically falls back to a curated internal knowledge base covering copy trading mechanics, tokenomics formulas, and platform security rules.

### Platform Administration Portal
- **User Directory**: Search, inspect, and manage platform users.
- **Role Approval Queue**: Review and approve/reject pending Expert Trader and LP applications.
- **Audit Trails**: Append-only audit logs recording every administrative action.
- **System Health & Distribution**: Live system status monitors and USDT liquidity distribution reports.

---

## 5. Prerequisites, Clone & Installation Guide

### System Prerequisites
- **Node.js**: `20.9.0` or higher (verified with Node.js v20 - v24)
- **Package Manager**: `npm` (comes with Node.js)
- **Database**: PostgreSQL 14+ (Local installation or Docker)
- **Docker & Docker Compose**: Recommended for instant PostgreSQL setup
- **OAuth Credentials**: Google Cloud Console or GitHub Developer App credentials

---

### Step 1: Clone Repository

```bash
git clone https://github.com/your-username/prometheus.git
cd prometheus
```

---

### Step 2: Backend Database & Environment Setup

1. Open a terminal and enter the `backend/` directory:
   ```bash
   cd backend
   npm install
   ```

2. Create your `.env` configuration file from the template:
   - On Windows (PowerShell):
     ```powershell
     Copy-Item .env.example .env
     ```
   - On Linux / macOS:
     ```bash
     cp .env.example .env
     ```

3. Spin up the PostgreSQL database container:
   ```bash
   docker compose up -d
   ```
   *(Defaults: database `prometheus`, user `prometheus`, password `prometheus_dev_password` on port `5432`)*.

4. Generate the Prisma Client and run database migrations:
   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   ```

---

### Step 3: Cryptographic Key Generation

Prometheus uses an asymmetric RS256 key pair to sign and verify session tokens securely. Generate the keys using the built-in generator:

```bash
# From the project root directory:
cd ..
node scripts/generate-auth-keys.mjs --write --yes
```

This script:
- Generates a 2048-bit RSA key pair.
- Injects the **Private Key** into root `.env.local` (`AUTH_API_SIGNING_PRIVATE_KEY`).
- Injects the **Public Key** into `backend/.env` (`AUTH_API_SIGNING_PUBLIC_KEY`).

---

### Step 4: Frontend Environment Setup

1. From the project root, install frontend dependencies:
   ```bash
   npm install
   ```

2. If `.env.local` was not created yet:
   - On Windows (PowerShell):
     ```powershell
     Copy-Item .env.example .env.local
     ```
   - On Linux / macOS:
     ```bash
     cp .env.example .env.local
     ```

3. Configure your OAuth credentials in `.env.local`:
   ```ini
   # Google OAuth (from https://console.cloud.google.com/apis/credentials)
   GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your_google_client_secret

   # GitHub OAuth (from https://github.com/settings/developers)
   GITHUB_CLIENT_ID=your_github_client_id
   GITHUB_CLIENT_SECRET=your_github_client_secret

   # NextAuth / Auth.js Secret (generate via node -e "console.log(crypto.randomBytes(32).toString('base64'))")
   AUTH_SECRET=your_generated_random_secret

   AUTH_URL=http://localhost:3000
   AUTH_API_BASE_URL=http://localhost:3001
   ```

4. Register the OAuth redirect callback URLs in your provider dashboards:
   - Google Authorized Redirect URI: `http://localhost:3000/api/auth/callback/google`
   - GitHub Authorization Callback URL: `http://localhost:3000/api/auth/callback/github`

---

### Step 5: Seeding Database & Market Data

Populate the database with reference assets (`INR`, `USDT`, `EMBER`), historical market data, and backtested expert strategies:

```bash
cd backend

# Seed assets and initial reference data
npm run prisma:seed

# Seed 1,932 historical candles and pre-computed paper simulations
npm run market:seed
```

---

### Step 6: Role Provisioning

To access privileged surfaces (*Platform Admin*, *Expert Trader*, or *Liquidity Provider*), assign the desired role to your email address:

```bash
# In the backend directory:
npm run grant:role -- your-email@gmail.com PLATFORM_ADMIN
npm run grant:role -- expert-trader@example.com EXPERT_TRADER
npm run grant:role -- lp-provider@example.com LIQUIDITY_PROVIDER
```

*Note: You can also specify comma-separated allowlists in `backend/.env`:*
```ini
PLATFORM_ADMIN_EMAILS=your-email@gmail.com
EXPERT_TRADER_EMAILS=expert@example.com
LIQUIDITY_PROVIDER_EMAILS=lp@example.com
```

---

### Step 7: Booting the Application

Start both the Next.js frontend (port `3000`) and the NestJS backend (port `3001`) with a single command from the project root:

```bash
# From the project root:
npm run dev
```

The startup script executes `dev-guard.mjs` to ensure no conflicting servers are running, launches the backend API, waits for `/api/health` to report ready, and boots the Next.js server.

Visit **`http://localhost:3000`** in your browser.

#### Dedicated Single-Service Commands:
- `npm run dev:web`: Runs Next.js frontend only (port 3000).
- `npm run dev:api`: Runs NestJS backend only (port 3001).

---

### Step 8: (Optional) Smart Contract & Blockchain Deployment

If you wish to test the ERC-20 smart contract locally:

```bash
cd blockchain
npm install

# Run contract tests
npx hardhat test

# Start a local Hardhat Ethereum node
npx hardhat node

# In a new terminal, deploy EmberToken to the local node:
npx hardhat run scripts/deploy.ts --network localhost
```

---

## 6. Navigation, Persona Routing & Sitemap

The user interface automatically morphs its navigation rail based on the authenticated user's active role:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PROMETHEUS ROUTE MAP                            │
├────────────────────────────────┬───────────────────────────────────────┤
│ Surface                        │ Route Paths                           │
├────────────────────────────────┼───────────────────────────────────────┤
│ Public Landing Page            │ `/`                                   │
│ Themed 4-Card Login Funnel     │ `/login`, `/login/continue`           │
│ User Onboarding & Preferences  │ `/onboarding`, `/preferences`         │
├────────────────────────────────┼───────────────────────────────────────┤
│ Trader Workspace               │                                       │
│   - Unified Dashboard          │ `/dashboard`                          │
│   - Digital Wallet & Deposits  │ `/wallet`                             │
│   - Portfolio Overview         │ `/portfolio`                          │
│   - USDT Zero-Fee Exchange     │ `/usdt-exchange`                      │
│   - Adaptive Copy Trading Desk │ `/copy-trading`                       │
│   - Live Trading Terminal      │ `/terminal`                           │
│   - EMBER Token & Tokenomics   │ `/tokenomics`                         │
│   - EMBER Inventory Hub        │ `/ember-hub`                          │
│   - Sentinel Voice Alerts      │ `/sentinel`                           │
│   - Strategy Discovery         │ `/discover`                           │
├────────────────────────────────┼───────────────────────────────────────┤
│ Expert Trader Workspace        │                                       │
│   - Expert Workspace Hub       │ `/expert`                             │
│   - Strategy Authoring Studio  │ `/expert/strategies/new`              │
│   - Strategy Management Desk   │ `/expert/strategies`                  │
│   - Paper Trading Desk         │ `/expert/dashboard`                   │
│   - Paper Portfolio            │ `/expert/portfolio`                   │
├────────────────────────────────┼───────────────────────────────────────┤
│ Liquidity Provider Workspace   │                                       │
│   - Liquidity Management Hub   │ `/liquidity`                          │
│   - LP Ledger & Allocations    │ `/liquidity/activity`                 │
│   - LP Capital Portfolio       │ `/liquidity/portfolio`                │
│   - EMBER Token Staking        │ `/staking`                            │
├────────────────────────────────┼───────────────────────────────────────┤
│ Platform Admin Workspace       │                                       │
│   - User Management            │ `/admin/users`                        │
│   - Role Decision Queue        │ `/admin/users`                        │
│   - System Health Diagnostics  │ `/admin/health`                       │
│   - Operational Audit Trail    │ `/admin/activity`                     │
│   - USDT Distribution Summary  │ `/admin/usdt`                         │
│   - Liquidity Overview         │ `/admin/liquidity`                    │
│   - Treasury Guardrails Desk   │ `/treasury`                           │
│   - Blockchain Reconciliation  │ `/blockchain`                         │
└────────────────────────────────┴───────────────────────────────────────┘
```

---

## 7. Current State, Verification & Test Coverage

### Test Suites Status

| Test Suite | Command | Result |
|---|---|---|
| **Backend Unit Tests** | `cd backend && npm test` | **978 / 978 passed (100%)** across 63 test suites |
| **Backend End-to-End** | `cd backend && npm run test:e2e` | **676 / 683 passed** (Comprehensive integration coverage) |
| **Backend Typecheck** | `cd backend && npm run typecheck` | **Clean (0 errors)** |
| **Frontend Unit Tests** | `npm test` | **15 / 15 passed (100%)** (Speech synthesis & ringtone suites) |
| **Frontend Typecheck** | `npx tsc --noEmit` | **Clean (0 errors)** |
| **Frontend Production Build** | `npm run build` | **Build successfully generates all static & dynamic routes** |

### Known Environmental Notes
1. **Live NYSE Market Session Timing**: If running the end-to-end tests during live US equity cash hours (13:30–20:00 UTC), paper trading test order rejections for equities may encounter live pricing rather than `MARKET_DATA_UNAVAILABLE`. This is documented in `TEST_FAILURES.md` as an expected provider dependency.
2. **Sepolia Mint Fixture**: The blockchain test suite expects a local Hardhat node or mock RPC when testnet keys are unset.
3. **Client-Side Sign-Out**: NextAuth clears browser session cookies immediately. Short-lived access tokens expire naturally after 15 minutes.

---

## 8. Codebase Directory Structure

```
prometheus/
├── app/                                 # Next.js 16 App Router pages
│   ├── admin/                           # Platform Admin management surfaces
│   ├── api/                             # API route handlers
│   │   ├── auth/[...nextauth]/          # Auth.js OAuth handlers
│   │   └── backend/[...path]/           # BFF Proxy: mints tokens, forwards to NestJS
│   ├── blockchain/                      # On-chain explorer and reconciliation
│   ├── copy-trading/                    # Adaptive Copy Trading Desk & candlestick charts
│   ├── dashboard/                       # User Dashboard
│   ├── expert/                          # Expert Trader portal & strategy authoring
│   ├── liquidity/                       # Liquidity Provider commitment portal
│   ├── login/                           # 4-card themed login experience
│   ├── onboarding/                      # 3-step user onboarding questionnaire
│   ├── portfolio/                       # Asset holdings and composition read-model
│   ├── sentinel/                        # Voice alert management & phone verification
│   ├── staking/                         # EMBER staking simulation interface
│   ├── terminal/                        # 8-instrument candlestick charts
│   ├── tokenomics/                      # Buyback, burn, and supply tracking
│   ├── treasury/                        # Platform capital & reserve floor dashboard
│   ├── usdt-exchange/                   # Zero-fee USDT exchange with live guarantee
│   └── wallet/                          # Digital wallet, transactions & top-ups
├── backend/                             # NestJS 11 Modular Monolith
│   ├── prisma/                          # Database schema, migrations & seed scripts
│   │   ├── migrations/                  # Hand-crafted PostgreSQL constraints
│   │   ├── market-seed.ts               # Seeds 1,932 historical candles
│   │   ├── grant-role.ts                # Operator CLI for assigning roles
│   │   └── schema.prisma                # Prisma relational schema
│   ├── src/                             # Backend application source code
│   │   ├── common/                      # Guards, decorators, filters, interceptors
│   │   ├── config/                      # Environment schema validation (Joi)
│   │   ├── database/                    # Prisma service & connection pool lifecycle
│   │   └── modules/                     # 17 Feature Modules
│   │       ├── ai-doubt-solver/         # Trading Buddy & knowledge base
│   │       ├── auth/                    # Token verification & user mapping
│   │       ├── blockchain/              # Viem / Hardhat client integration
│   │       ├── copy/                    # Copy trading engine & execution worker
│   │       ├── ember/                   # EMBER token accounting & P2P transfers
│   │       ├── liquidity/               # LP commitments, slabs & FIFO allocation
│   │       ├── market-data/             # Candlestick storage & streaming feeds
│   │       ├── paper/                   # Expert paper accounts ($100k balance)
│   │       ├── payments/                # Razorpay & simulated deposit rails
│   │       ├── platform-admin/          # System metrics, audit logs & health
│   │       ├── portfolio/               # Portfolio snapshot aggregation
│   │       ├── rbac/                    # RolesGuard, permissions, role requests
│   │       ├── risk/                    # MDD & Volatility calculation engine
│   │       ├── sentinel/                # Price alert monitor & Twilio caller
│   │       ├── simulation/              # Deterministic market backtest engine
│   │       ├── strategy/                # Strategy registry & lifecycle
│   │       ├── tokenomics/              # 60/40 burn engine & treasury checks
│   │       ├── treasury/                # 30% reserve floor & capacity limits
│   │       ├── usdt/                    # CoinDCX VWAP & Best-Price Guarantee
│   │       └── wallet/                  # Atomic wallet balance accounting
│   └── test/                            # Comprehensive Jest unit & e2e suites
├── blockchain/                          # Hardhat environment & smart contracts
│   ├── contracts/                       # Solidity contracts (EmberToken.sol)
│   └── scripts/                         # Contract deployment & address derivation
├── components/                          # Shared React UI components
│   ├── AppShell.tsx                     # Main navigation chrome & dynamic sidebar
│   ├── StrategyChart.tsx                # Lightweight Charts candlestick component
│   ├── CopyActivityChart.tsx            # Order fill marker charting
│   ├── ExpertChatModal.tsx              # Follower-to-expert messaging modal
│   └── LoginForm.tsx                    # Multi-persona interactive login card
├── lib/                                 # Shared utilities & business logic
│   ├── api-client.ts                    # Strongly typed client for /api/backend/*
│   ├── auth.ts                          # Auth.js OAuth configuration
│   ├── decimal.ts                       # BigInt-scaled arbitrary-precision math
│   └── rbac.ts                          # Client-side permission helpers
├── scripts/                             # Operational & dev tooling
│   ├── dev-guard.mjs                    # Prevents duplicate dev server collision
│   ├── generate-auth-keys.mjs           # Asymmetric RS256 key pair generator
│   └── wait-for-api.mjs                 # Synchronizes frontend boot with API readiness
└── public/                              # Static media, icons, and AI widget assets
```

---

## 9. Database Schema

PostgreSQL is the source of truth. Prisma is only the data-access layer, and
`backend/prisma/schema.prisma` holds schema and nothing else — no wallet
accounting, no exchange behaviour, no copy-trading rules. Introspection is
disabled on purpose so every column is authored and reviewed rather than
absorbed from a drifted database.

### 9.1 Engine & Tooling

| Item | Value |
| :--- | :--- |
| Engine | PostgreSQL 16 (`postgres:16` image, container `prometheus-postgres`) |
| ORM / migrations | Prisma 6.19.3, `prisma migrate dev` / `deploy` |
| Models / enums / tables | 41 models · 33 enums · 41 mapped tables |
| Migrations | 24, in `backend/prisma/migrations` |
| Databases | `prometheus` (dev) · `prometheus_e2e` (integration suites) |
| Cache (non-schema) | Redis 7 for market-data and price TTL only — never a ledger |

### 9.2 Conventions Applied Throughout

- **UUID primary keys on every application entity.** Ids are opaque; nothing
  sequential leaks volume or ordering to a client.
- **`NUMERIC(38,18)` for every persisted financial quantity** (84 columns),
  surfaced in TypeScript as `Prisma.Decimal`. JavaScript floats are never used
  for money: `0.1 + 0.2 !== 0.3` in binary floating point, so balances would
  drift. The scale is 18 because EMBER is an ERC-20 with 18 decimals; INR is
  rendered at 2 decimals at every boundary by policy, not by column type.
- **`TIMESTAMPTZ(3)` for every timestamp** (91 columns), stored in UTC. The
  presentation layer converts; the database never stores a local time.
- **`snake_case` table and column names** via `@@map` / `@map`, so SQL
  inspection matches the Prisma model one-to-one.
- **Statuses are real PostgreSQL enums**, not free text. Adding a value is an
  `ALTER TYPE ... ADD VALUE` in a migration, which keeps the set reviewable and
  keeps the database able to reject a state the application doesn't understand.

### 9.3 Table Map by Module

| Group | Tables |
| :--- | :--- |
| Identity, RBAC & audit (01, 02, 13) | `users`, `auth_accounts`, `user_roles`, `role_requests`, `user_profiles`, `admin_audit_logs` |
| Wallet & accounting core (03, 03b) | `wallets`, `assets`, `wallet_balances`, `transactions`, `wallet_deposits` |
| Strategies, backtest & paper trading (05, 06, 06b, 06c) | `strategies`, `market_candles`, `strategy_simulations`, `strategy_fills`, `strategy_daily_balance`, `paper_accounts`, `paper_orders`, `paper_positions` |
| Copy-trading desk (07) | `strategy_follows`, `copy_accounts`, `copy_positions`, `copy_events` |
| USDT exchange & LP engine (08, 09) | `usdt_orders`, `liquidity_providers`, `liquidity_commitments`, `liquidity_allocations`, `liquidity_commitment_reductions`, `liquidity_top_up_requests` |
| EMBER ledger & tokenomics (10, 11, 12) | `ember_transfers`, `token_allocations`, `token_buybacks`, `token_burns`, `ember_mint_requests`, `ember_purchases`, `ember_stake_positions`, `blockchain_events`, `exchange_revenue_events` |
| Sentinel alerts & voice (14) | `sentinel_alerts`, `sentinel_voice_settings`, `sentinel_voice_calls` |

### 9.4 The Ledger Tables

`transactions` is the append-only spine: every balance movement is a row with a
`type`, an `amount`, and the `available_after` / `locked_after` it produced.
`wallet_balances` is the current-state projection of that history. A balance is
never edited without a transaction, and the pair is what lets the wallet page
show a figure and then prove it.

`wallet_balances`, `transactions.amount` and `wallet_deposits.amount` are the
columns `test/schema.e2e-spec.ts` pins to `NUMERIC(38,18)` by reading
`information_schema` — the assertion is a database census, not a code review,
so a future migration that reaches for `DOUBLE PRECISION` fails a test rather
than corrupting a balance. That same suite asserts that **no** column in the
schema is `real`, `double precision` or `money`.

### 9.5 Referential Integrity

Delete rules are chosen per relation and are enforced by PostgreSQL, not by
application discipline:

| Rule | Count | Where and why |
| :--- | :--- | :--- |
| `Restrict` | 37 | Financial history is never silently deleted. A settled order, a burn or a ledger transaction cannot vanish because something referenced it was removed; the database refuses first. |
| `Cascade` | 17 | Owned configuration and derived rows with no independent meaning (a voice setting of a user, a session-scoped record). |
| `SetNull` | 3 | Optional links that should survive the removal of their target, leaving the row and a null pointer rather than deleting evidence. |

### 9.6 Indexing

41 `@@index` and 20 `@@unique` declarations. The indexes exist for named reads
rather than generically: the worker's scan of due work
(`status, next_attempt_at`), the dashboard's newest-first grouping
(`status, detected_at DESC`), and the wallet's balance lookups. Uniqueness is
used as a correctness mechanism, not only as a constraint — see below.

### 9.7 `exchange_revenue_events` — the settlement outbox

The bridge between the USDT exchange (Module 08) and the burn engine (Module 11).
One row per settled order, written **inside the settlement transaction**, so an
order that fails, is refused or rolls back leaves no event at all.

| Column | Meaning |
| :--- | :--- |
| `order_id` | `UNIQUE`, `Restrict` FK to `usdt_orders`. One order can produce at most one event, forever — a replayed HTTP request cannot become a second burn. |
| `revenue_mode` / `revenue_bps` | The policy this order was decided under, snapshotted at detection. The row outlives the configuration. |
| `customer_inr`, `lp_inr_settled`, `retained_inr` | What was paid, what the liquidity providers were credited, and the measured residual the platform actually kept. |
| `revenue_inr` | **What the platform earned.** Zero under a volume policy, and the column is never widened to mean "something". |
| `basis_inr` | **What the engine was sized against.** Equals `revenue_inr` under `RETAINED_BPS`; equals the order's own INR value under `VOLUME_LINKED`. |
| `ember_price`, `direct_burn_pct`, `buyback_pct` | The reference price and baseline split in force for this order. |
| `status`, `reason_code`, `detail` | Queue state plus a reason for every outcome, including the reasons nothing happened. A blank would be indistinguishable from a bug. |
| `attempts`, `max_attempts`, `next_attempt_at` | Retry bookkeeping with exponential backoff; a 15-minute `PROCESSING` lease makes a crashed worker's row reclaimable. |
| `allocation_id`, `buyback_id`, `direct_burn_id`, `buyback_burn_id` | The Module 11 records this order funded. |

The two rupee columns exist because the two claims are different. A volume-linked
allocation says "this much traded, so this much EMBER leaves circulation"; it
does **not** say the platform earned it, and no rupee moves because of it. The
EMBER comes out of the treasury's own inventory under the same reserve floor as
any other burn. Adding `basis_inr` was migration
`20261101120000_exchange_revenue_volume_basis`, which backfills
`basis_inr = revenue_inr` so every pre-existing row keeps exactly its old
meaning.

### 9.8 Working With the Schema

```bash
cd backend
npm run prisma:migrate      # author a migration (dev database)
npx prisma migrate deploy   # apply committed migrations
npm run prisma:status       # what is pending, without touching data
npm run prisma:studio       # browse the live database
```

Two rules the project follows without exception:

1. **Never `prisma db push` against a shared database.** It rewrites schema from
   the local file with no migration history and no review.
2. **Never run the integration suites against the dev database.** The e2e suites
   purge the tables they own, including unfiltered `deleteMany` calls on
   `exchange_revenue_events`, `token_allocations`, `token_buybacks` and
   `token_burns`. Point `DATABASE_URL` at `prometheus_e2e` first:

   ```bash
   DATABASE_URL="postgresql://prometheus:prometheus_dev_password@localhost:5432/prometheus_e2e?schema=public" \
     npx prisma migrate deploy
   DATABASE_URL="postgresql://prometheus:prometheus_dev_password@localhost:5432/prometheus_e2e?schema=public" \
     npm run test:e2e
   ```

---

## 10. Summary & Quickstart Command Cheat Sheet

```bash
# 1. Setup Backend
cd backend
npm install
Copy-Item .env.example .env             # Windows (or cp .env.example .env)
npm run prisma:generate
docker compose up -d
npm run prisma:migrate
npm run prisma:seed
npm run market:seed

# 2. Setup Security Keys & Frontend
cd ..
node scripts/generate-auth-keys.mjs --write --yes
npm install
Copy-Item .env.example .env.local       # Windows (or cp .env.example .env.local)
# -> Add your GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET to .env.local

# 3. Grant Admin Privileges
cd backend
npm run grant:role -- your-email@gmail.com PLATFORM_ADMIN

# 4. Start Full Stack
cd ..
npm run dev

# Open http://localhost:3000
```

