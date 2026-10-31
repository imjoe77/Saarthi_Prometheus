"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  History,
  Landmark,
  Loader2,
  Power,
  RefreshCw,
  Shield,
  Snowflake,
  Users,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  adminFundTreasury,
  adminListUsers,
  adminPlatformOverview,
  adminSetAssetStatus,
  adminSetUserStatus,
  adminSetWalletStatus,
  adminTreasuryWithdrawal,
  adminUserDetail,
  adminWalletMovement,
  getAssets,
  getTreasurySummary,
  type AdminUser,
  type AssetSummary,
  type PlatformOverview,
  type PlatformUserDetail,
  type TreasurySummary,
} from "@/lib/api-client";

/**
 * PLATFORM ADMIN — the platform's money and account controls, one surface.
 *
 * What this page backs:
 *  1. Platform overview — one read-only snapshot: account and wallet
 *     counters, role distribution, request queue, token activity, per-asset
 *     aggregates across every wallet, treasury state and the newest audit
 *     rows. Every figure comes straight from the records.
 *  2. Treasury funding AND withdrawal — capital (INR/USDT) and EMBER
 *     inventory are credited to, or debited from, the treasury's system
 *     wallet. This is the platform of record: the hub delivers purchases
 *     from this inventory and the reserve floor is computed from it.
 *  3. Per-account controls — manual CREDIT/DEBIT on any user's wallet
 *     (ledger type ADJUSTMENT, note required on the ledger and the audit
 *     row), lifecycle status (SUSPENDED/CLOSED stop the account's tokens
 *     immediately), wallet freeze (a frozen wallet refuses every movement)
 *     and the account's full read (roles, activity counts, balances, ledger
 *     tail).
 *  4. Asset lifecycle — retire an asset for new movements or restore it.
 *     A retired asset accepts no movement anywhere in the platform while
 *     balances and history stay readable.
 *
 * The RoleGate + the backend's RolesGuard make this page admin-only, and
 * nothing here can grant PLATFORM_ADMIN (that stays an operator CLI action).
 * Every action writes an admin audit row readable on /admin/activity, and
 * every read is genuinely read-only. Pricing/tokenomics configuration is
 * intentionally absent: that belongs to the tokenomics and hub surfaces and
 * is edited in the backend's environment, not edited live from a console.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function PlatformAdminPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [treasury, setTreasury] = useState<TreasurySummary | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [userList, assetList, summary, snapshot] = await Promise.all([
        adminListUsers(),
        getAssets(),
        getTreasurySummary(),
        adminPlatformOverview(),
      ]);
      setUsers(userList);
      setAssets(assetList);
      setTreasury(summary);
      setOverview(snapshot);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([adminListUsers(), getAssets(), getTreasurySummary(), adminPlatformOverview()])
      .then(([userList, assetList, summary, snapshot]) => {
        if (!active) return;
        setUsers(userList);
        setAssets(assetList);
        setTreasury(summary);
        setOverview(snapshot);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(messageFor(cause));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  const reload = useCallback(() => {
    setStatus("loading");
    setError(null);
    void load();
  }, [load]);

  return (
    <AppShell>
      <RoleGate roles={["PLATFORM_ADMIN"]}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
                <Shield className="w-3.5 h-3.5" />
                Admin · Platform
              </div>
              <h1 className="text-2xl font-bold text-white">Capital &amp; controls</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Fund the treasury, adjust wallets, freeze wallets and manage account statuses.
                Every action is audited.
              </p>
            </div>
            <button
              onClick={reload}
              className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
              <AlertTriangle className="w-4 h-4 inline mr-2" />
              {error}
            </div>
          )}

          {status === "loading" && (
            <div className="space-y-3" aria-busy="true">
              <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "ready" && overview && (
            <>
              <OverviewPanel overview={overview} users={users} />
              <div className="mt-6" />
              <TreasuryPanel treasury={treasury} assetSymbols={assets.map((asset) => asset.symbol)} onChanged={reload} />
              <div className="mt-6" />
              <AssetPanel assets={overview.assets} onChanged={reload} />
              <div className="mt-6" />
              <UserAccountsPanel users={users} assetSymbols={assets.map((asset) => asset.symbol)} onChanged={reload} />
            </>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Platform overview (read-only snapshot)
// ---------------------------------------------------------------------------

function OverviewPanel({ overview, users }: { overview: PlatformOverview; users: AdminUser[] }) {
  const suspended = overview.users.byStatus.SUSPENDED;
  const frozen = overview.wallets.byStatus.FROZEN;
  const admins = overview.roles.filter((row) => row.role === "PLATFORM_ADMIN" && row.count > 0).length > 0;

  return (
    <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <Shield className="w-4 h-4 text-[#38BDF8]" />
        Platform overview
      </h2>
      <p className="text-[11px] text-[#6B7280] mb-4">
        Counted straight from the records — accounts, wallets, roles, requests and token activity.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Fact label="Accounts" value={`${overview.users.total}`} tone="plain" />
        <Fact label="Active / suspended" value={`${overview.users.byStatus.ACTIVE} / ${suspended}`} tone={suspended > 0 ? "warn" : "plain"} />
        <Fact label="Wallets active / frozen" value={`${overview.wallets.total - frozen} / ${frozen}`} tone={frozen > 0 ? "warn" : "plain"} />
        <Fact label="Closed accounts" value={`${overview.users.byStatus.CLOSED}`} tone={overview.users.byStatus.CLOSED > 0 ? "warn" : "plain"} />
        <Fact label="Role requests pending" value={`${overview.roleRequests.pending} of ${overview.roleRequests.total}`} tone={overview.roleRequests.pending > 0 ? "warn" : "plain"} />
        <Fact label="Platform admins" value={admins ? overview.roles.find((row) => row.role === "PLATFORM_ADMIN")!.count.toString() : "none"} tone={admins ? "good" : "warn"} />
        <Fact label="Strategies (public)" value={`${overview.activity.strategies.total} (${overview.activity.strategies.public})`} tone="plain" />
        <Fact label="Copy follows" value={`${overview.activity.copyFollows}`} tone="plain" />
      </div>

      <p className="mt-4 mb-2 text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold">
        Assets across every wallet ({overview.assets.length}) · treasury wallet {overview.treasury.provisioned ? overview.treasury.walletStatus ?? "—" : "not provisioned"}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {overview.assets.map((asset) => {
          const treasuryBalance = overview.treasury.balances.find((row) => row.symbol === asset.symbol);
          return (
            <div key={asset.symbol} className="rounded-lg border border-[#222834] bg-[#14181F] p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-white">{asset.symbol} · {asset.name}</p>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                    asset.isActive ? "border-[#00D26A]/40 text-[#00D26A]" : "border-[#EF4444]/40 text-[#EF4444]"
                  }`}
                >
                  {asset.isActive ? "ACTIVE" : "RETIRED"}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-[#9CA3AF] font-mono">
                Platform: {asset.totalAvailable} avail · {asset.totalLocked} locked · {asset.walletsHolding} wallets
              </p>
              {treasuryBalance && (
                <p className="text-[11px] text-[#6B7280] font-mono">
                  Treasury: {treasuryBalance.available} avail · {treasuryBalance.locked} locked
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 mb-2 text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold">
        Latest audit rows ({users.length > 0 ? "actor / action" : "none yet"})
      </p>
      <div className="space-y-1">
        {overview.recentAudit.slice(0, 5).map((row) => (
          <p key={row.id} className="font-mono text-[11px] text-[#9CA3AF] break-all">
            {new Date(row.createdAt).toISOString().replace("T", " ").slice(0, 19)} · {row.actorEmail} → {row.action}
          </p>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Asset lifecycle
// ---------------------------------------------------------------------------

function AssetPanel({ assets, onChanged }: { assets: PlatformOverview["assets"]; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busySymbol, setBusySymbol] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const toggle = async (symbol: string, isActive: boolean): Promise<void> => {
    setBusySymbol(symbol);
    setMessage(null);
    try {
      const result = await adminSetAssetStatus(symbol, { isActive, note: note.trim() });
      setMessage(
        isActive
          ? `${result.symbol} restored: movements are accepted again.`
          : `${result.symbol} retired: no movement will be accepted until it is restored. Balances and history stay readable.`,
      );
      setIsError(false);
      setNote("");
      onChanged();
    } catch (cause) {
      setMessage(messageFor(cause));
      setIsError(true);
    } finally {
      setBusySymbol(null);
    }
  };

  return (
    <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <Coins className="w-4 h-4 text-[#F59E0B]" />
        Asset lifecycle
      </h2>
      <p className="text-[11px] text-[#6B7280] mb-4">
        Retiring an asset blocks every movement it would produce, wallet-wide, until it is restored.
        Retire with care: the hub, treasury and treasury guardrails all move assets through this ledger.
      </p>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center mb-3">
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Reason (required, audited)"
          maxLength={200}
          className="w-full sm:max-w-md bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
        />
      </div>

      <div className="space-y-2">
        {assets.map((asset) => (
          <div key={asset.symbol} className="rounded-lg border border-[#222834] bg-[#14181F] px-4 py-3 flex items-center gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white">
                {asset.symbol} <span className="text-[#6B7280] font-normal">· {asset.kind} · {asset.decimals}dp</span>
              </p>
              <p className="text-[11px] text-[#9CA3AF] font-mono break-all">
                Platform {asset.totalAvailable} avail / {asset.totalLocked} locked · {asset.walletsHolding} wallets
              </p>
            </div>
            <span
              className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                asset.isActive ? "border-[#00D26A]/40 text-[#00D26A]" : "border-[#EF4444]/40 text-[#EF4444]"
              }`}
            >
              {asset.isActive ? "ACTIVE" : "RETIRED"}
            </span>
            <button
              type="button"
              disabled={!note.trim() || busySymbol !== null}
              onClick={() => void toggle(asset.symbol, !asset.isActive)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#323B4C] px-3 py-2 text-[11px] font-semibold text-[#9CA3AF] hover:text-white transition-colors disabled:opacity-50"
            >
              {busySymbol === asset.symbol ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
              {asset.isActive ? "Retire" : "Restore"}
            </button>
          </div>
        ))}
      </div>

      <ActionMessage message={message} isErroneous={isError} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

function TreasuryPanel({
  treasury,
  assetSymbols,
  onChanged,
}: {
  treasury: TreasurySummary | null;
  assetSymbols: string[];
  onChanged: () => void;
}) {
  const [assetSymbol, setAssetSymbol] = useState("EMBER");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const symbols = assetSymbols.length > 0 ? assetSymbols : ["EMBER", "USDT", "INR"];

  const move = async (kind: "CREDIT" | "DEBIT"): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const mover = kind === "CREDIT" ? adminFundTreasury : adminTreasuryWithdrawal;
      const result = await mover({
        assetSymbol,
        amount: amount.trim(),
        note: note.trim(),
      });
      setMessage(
        kind === "CREDIT"
          ? `Treasury funded: ${result.asset.symbol} available is now ${result.available}. The ADJUSTMENT leg and audit row are recorded.`
          : `Treasury debited: ${result.asset.symbol} available is now ${result.available}. The ADJUSTMENT leg and audit row are recorded.`,
      );
      setIsError(false);
      setAmount("");
      setNote("");
      onChanged();
    } catch (cause) {
      setMessage(messageFor(cause));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <Landmark className="w-4 h-4 text-[#00D26A]" />
        Treasury funding &amp; withdrawal
      </h2>
      <p className="text-[11px] text-[#6B7280] mb-4">
        Credits or debits the treasury&apos;s system wallet — capital and inventory reach, and leave, the platform of record here.
      </p>

      {treasury && <TreasuryFacts treasury={treasury} />}

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 mt-3">
        <select
          value={assetSymbol}
          onChange={(event) => setAssetSymbol(event.target.value)}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF5A1F]"
        >
          {symbols.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbol}
            </option>
          ))}
        </select>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="Amount (e.g. 100000)"
          maxLength={40}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
        />
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Reason (required, audited)"
          maxLength={200}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
        />
        <button
          type="button"
          onClick={() => void move("CREDIT")}
          disabled={busy || !amount.trim() || !note.trim()}
          className="inline-flex items-center justify-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
          Add to treasury
        </button>
        <button
          type="button"
          onClick={() => void move("DEBIT")}
          disabled={busy || !amount.trim() || !note.trim()}
          className="inline-flex items-center justify-center gap-1.5 border border-[#F59E0B]/40 text-[#F59E0B] hover:bg-[#F59E0B]/10 px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
          Remove from treasury
        </button>
      </div>

      <ActionMessage message={message} isErroneous={isError} />
    </section>
  );
}

function TreasuryFacts({ treasury }: { treasury: TreasurySummary }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Fact
        label="Account"
        value={treasury.treasury.provisioned ? "provisioned" : "not provisioned"}
        tone={treasury.treasury.provisioned ? "good" : "warn"}
      />
      <Fact
        label="Wallet status"
        value={treasury.treasury.walletStatus ?? "—"}
        tone={treasury.treasury.walletStatus === "FROZEN" ? "warn" : "good"}
      />
      <Fact
        label="EMBER available / total"
        value={
          treasury.ember ? `${treasury.ember.available} / ${treasury.ember.total}` : "—"
        }
        tone="plain"
      />
      <Fact
        label="USDT available / total"
        value={treasury.usdt ? `${treasury.usdt.available} / ${treasury.usdt.total}` : "—"}
        tone="plain"
      />
      <Fact label="Reserve floor status" value={treasury.reserve.status} tone="plain" />
      <Fact
        label="USDT capacity remaining"
        value={treasury.usdtCapacity.remaining ?? "not configured"}
        tone="plain"
      />
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "plain" }) {
  const color = tone === "good" ? "text-[#00D26A]" : tone === "warn" ? "text-[#F59E0B]" : "text-white";
  return (
    <div className="rounded-lg border border-[#222834] bg-[#14181F] p-3">
      <p className="text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold">{label}</p>
      <p className={`mt-1 text-sm font-semibold break-all ${color}`}>{value}</p>
    </div>
  );
}

function ActionMessage({ message, isErroneous }: { message: string | null; isErroneous: boolean }) {
  if (!message) {
    return null;
  }
  return (
    <div
      className={`mt-3 rounded-lg border p-3 text-xs ${
        isErroneous
          ? "border-[#EF4444]/40 bg-[#EF4444]/10 text-[#EF4444]"
          : "border-[#00D26A]/40 bg-[#00D26A]/10 text-[#00D26A]"
      }`}
    >
      {isErroneous ? <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" /> : <CheckCircle2 className="w-3.5 h-3.5 inline mr-1.5" />}
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User accounts
// ---------------------------------------------------------------------------

function UserAccountsPanel({
  users,
  assetSymbols,
  onChanged,
}: {
  users: AdminUser[];
  assetSymbols: string[];
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <Users className="w-4 h-4 text-[#FF5A1F]" />
        Accounts ({users.length})
      </h2>
      <p className="text-[11px] text-[#6B7280] mb-4">
        Wallet adjustments, wallet freezes and lifecycle statuses per account — open a row for the
        full read (roles, activity, balances, ledger tail). Roles are managed on the users page.
      </p>

      {users.length === 0 ? (
        <p className="text-sm text-[#6B7280]">No accounts found.</p>
      ) : (
        <div className="space-y-2">
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              assetSymbols={assetSymbols}
              open={openId === user.id}
              onToggle={() => setOpenId(openId === user.id ? null : user.id)}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface UserRowState {
  busy: string | null;
  message: string | null;
  error: boolean;
  walletStatus: "ACTIVE" | "FROZEN" | null;
}

function UserRow({
  user,
  assetSymbols,
  open,
  onToggle,
  onChanged,
}: {
  user: AdminUser;
  assetSymbols: string[];
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<UserRowState>({ busy: null, message: null, error: false, walletStatus: null });
  const symbols = assetSymbols.length > 0 ? assetSymbols : ["INR", "USDT", "EMBER"];

  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    setState({ busy: label, message: null, error: false, walletStatus: null });
    try {
      const note = await action();
      setState({ busy: null, message: note, error: false, walletStatus: null });
      onChanged();
    } catch (cause) {
      setState({ busy: null, message: messageFor(cause), error: true, walletStatus: null });
    }
  };

  return (
    <div className="rounded-xl border border-[#222834] bg-[#14181F]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#181D26] transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4 text-[#6B7280]" /> : <ChevronRight className="w-4 h-4 text-[#6B7280]" />}
        <span className="font-mono text-xs text-white break-all">{user.email}</span>
        <span className="ml-auto flex items-center gap-2">
          <StatusChip status={user.status} />
          {user.roles
            .filter((role) => role !== "USER")
            .map((role) => (
              <span
                key={role}
                className="px-1.5 py-0.5 rounded text-[10px] font-mono border border-[#323B4C] text-[#9CA3AF]"
              >
                {role}
              </span>
            ))}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          <AccountDetail userId={user.id} />
          <MovementForm
            userId={user.id}
            symbols={symbols}
            busyLabel={state.busy}
            onRun={run}
          />
          <div className="flex flex-wrap gap-2">
            <ControlButton
              label="Freeze wallet"
              icon={<Snowflake className="w-3.5 h-3.5" />}
              busy={state.busy === "freeze"}
              disabled={state.busy !== null}
              onClick={() =>
                void run(
                  "freeze",
                  async () => {
                    const result = await adminSetWalletStatus(user.id, "FROZEN");
                    setState({ busy: null, message: null, error: false, walletStatus: result.walletStatus });
                    onChanged();
                    return "Wallet frozen: no movement can pass until unfrozen.";
                  },
                )
              }
              tone="warn"
            />
            <ControlButton
              label="Unfreeze wallet"
              icon={<Snowflake className="w-3.5 h-3.5" />}
              busy={state.busy === "unfreeze"}
              disabled={state.busy !== null}
              onClick={() =>
                void run(
                  "unfreeze",
                  async () => {
                    const result = await adminSetWalletStatus(user.id, "ACTIVE");
                    setState({ busy: null, message: null, error: false, walletStatus: result.walletStatus });
                    onChanged();
                    return "Wallet unfrozen: movements pass again.";
                  },
                )
              }
              tone="neutral"
            />
            {user.status === "ACTIVE" &&
              (
                <>
                  <ControlButton
                    label="Suspend account"
                    busy={state.busy === "suspend"}
                    disabled={state.busy !== null}
                    onClick={() =>
                      void run("suspend", async () => {
                        await adminSetUserStatus(user.id, "SUSPENDED");
                        return "Account suspended: the user's sessions stop resolving immediately.";
                      })
                    }
                    tone="warn"
                  />
                  <ControlButton
                    label="Close account"
                    busy={state.busy === "close"}
                    disabled={state.busy !== null}
                    onClick={() =>
                      void run("close", async () => {
                        await adminSetUserStatus(user.id, "CLOSED");
                        return "Account closed: the user's sessions stop resolving immediately.";
                      })
                    }
                    tone="danger"
                  />
                </>
              )}
            {(user.status === "SUSPENDED" || user.status === "CLOSED") && (
              <ControlButton
                label="Reactivate account"
                busy={state.busy === "reactivate"}
                disabled={state.busy !== null}
                onClick={() =>
                  void run("reactivate", async () => {
                    await adminSetUserStatus(user.id, "ACTIVE");
                    return "Account reactivated.";
                  })
                }
                tone="good"
              />
            )}
          </div>
          {state.walletStatus && (
            <p className="text-[11px] font-mono text-[#6B7280]">Wallet status: {state.walletStatus}</p>
          )}
          <ActionMessage message={state.message} isErroneous={state.error} />
        </div>
      )}
    </div>
  );
}

function MovementForm({
  userId,
  symbols,
  busyLabel,
  onRun,
}: {
  userId: string;
  symbols: string[];
  busyLabel: string | null;
  onRun: (label: string, action: () => Promise<string>) => Promise<void>;
}) {
  const [kind, setKind] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [assetSymbol, setAssetSymbol] = useState(symbols[0] ?? "INR");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const ready = Boolean(amount.trim()) && note.trim().length > 0 && busyLabel === null;

  return (
    <div className="rounded-lg border border-[#1E2532] bg-[#10141B] p-3">
      <p className="text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold mb-2">
        Adjust wallet (ADJUSTMENT — note recorded in the ledger and the audit log)
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as "CREDIT" | "DEBIT")}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-[#FF5A1F]"
        >
          <option value="CREDIT">Credit</option>
          <option value="DEBIT">Debit</option>
        </select>
        <select
          value={assetSymbol}
          onChange={(event) => setAssetSymbol(event.target.value)}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-[#FF5A1F]"
        >
          {symbols.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbol}
            </option>
          ))}
        </select>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="Amount"
          maxLength={40}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-xs text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
        />
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Reason (required)"
          maxLength={200}
          className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-xs text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
        />
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            void onRun("movement", async () => {
              await adminWalletMovement(userId, {
                kind,
                assetSymbol,
                amount: amount.trim(),
                note: note.trim(),
              });
              return `Wallet ${kind.toLowerCase()} recorded: ${amount.trim()} ${assetSymbol}.`;
            })
          }
          className="inline-flex items-center justify-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-3 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
        >
          {busyLabel === "movement" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
          Apply
        </button>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const cls =
    status === "ACTIVE"
      ? "border-[#00D26A]/40 text-[#00D26A]"
      : status === "SUSPENDED"
        ? "border-[#F59E0B]/40 text-[#F59E0B]"
        : "border-[#EF4444]/40 text-[#EF4444]";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${cls}`}>{status}</span>
  );
}

function AccountDetail({ userId }: { userId: string }) {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; detail: PlatformUserDetail }
  >({ phase: "loading" });

  useEffect(() => {
    let active = true;
    adminUserDetail(userId)
      .then((detail) => {
        if (active) setState({ phase: "ready", detail });
      })
      .catch((cause: unknown) => {
        if (active) setState({ phase: "error", message: messageFor(cause) });
      });
    return () => {
      active = false;
    };
  }, [userId]);

  if (state.phase === "loading") {
    return (
      <div className="rounded-lg border border-[#1E2532] bg-[#10141B] p-3 flex items-center gap-2 text-[11px] text-[#6B7280]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the account…
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-[11px] text-[#EF4444]">
        {state.message}
      </div>
    );
  }

  const { detail } = state;

  return (
    <div className="rounded-lg border border-[#1E2532] bg-[#10141B] p-3 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fact label="Roles" value={detail.roles.join(", ") || "—"} tone="plain" />
        <Fact label="Strategies owned" value={`${detail.counts.strategies}`} tone="plain" />
        <Fact label="Copy follows" value={`${detail.counts.follows}`} tone="plain" />
        <Fact label="Role requests" value={`${detail.counts.roleRequests}`} tone="plain" />
      </div>

      {detail.wallet === null ? (
        <p className="text-[11px] text-[#6B7280]">
          No wallet yet — one is created by the user&apos;s first balance movement; the admin
          surface does not create it implicitly.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold">
              Wallet {detail.wallet.id.slice(0, 8)}…
            </p>
            <StatusChip status={detail.wallet.status} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {detail.wallet.balances.length === 0 && (
              <p className="text-[11px] text-[#6B7280]">No balances.</p>
            )}
            {detail.wallet.balances.map((balance) => (
              <span
                key={balance.symbol}
                className="px-2 py-1 rounded border border-[#323B4C] font-mono text-[11px] text-[#9CA3AF]"
              >
                {balance.symbol}: {balance.available} avail / {balance.locked} locked
              </span>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold mb-1.5 flex items-center gap-1.5">
              <History className="w-3 h-3" /> Newest ledger legs
            </p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {detail.wallet.ledger.length === 0 && (
                <p className="text-[11px] text-[#6B7280]">No ledger legs yet.</p>
              )}
              {detail.wallet.ledger.map((leg) => (
                <p key={leg.id} className="font-mono text-[11px] text-[#9CA3AF] break-all">
                  {new Date(leg.createdAt).toISOString().replace("T", " ").slice(0, 19)} · {leg.type} ·{" "}
                  {leg.amount} {leg.asset.symbol} · after: {leg.availableAfter ?? "—"}
                  {leg.note ? ` · ${leg.note}` : ""}
                </p>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ControlButton({
  label,
  icon,
  busy,
  disabled,
  onClick,
  tone,
}: {
  label: string;
  icon?: React.ReactNode;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  tone: "warn" | "good" | "neutral" | "danger";
}) {
  const toneClass =
    tone === "warn"
      ? "border-[#F59E0B]/40 text-[#F59E0B] hover:bg-[#F59E0B]/10"
      : tone === "good"
        ? "border-[#00D26A]/40 text-[#00D26A] hover:bg-[#00D26A]/10"
        : tone === "danger"
          ? "border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10"
          : "border-[#323B4C] text-[#9CA3AF] hover:text-white";
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border bg-transparent px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${toneClass}`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      <span>{label}</span>
    </button>
  );
}
