"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Droplets,
  History,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Unlock,
  X,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  createLiquidityCommitment,
  getBalances,
  getLiquidityOverview,
  getLiquiditySlabs,
  getMyLiquidityCommitment,
  reduceLiquidityCommitment,
  type BalanceSummary,
  type LiquidityCommitmentSummary,
  type LiquidityMyCommitment,
  type LiquidityOverview,
  type LiquiditySlab,
  type LiquiditySlabs,
} from "@/lib/api-client";
import { addDecimalStrings, compareDecimalStrings } from "@/lib/decimal";

/**
 * MODULE 13 — the Liquidity Provider landing page.
 *
 * The caller's own LP registration and commitment (both null until the first
 * commitment), the aggregate health numbers, and the two commitment mutations
 * the Module 09 API exposes: pledge USDT and withdraw from it.
 *
 * The slab table is READ FROM the server (`GET /liquidity/slabs`), never copied
 * here: the lock the UI shows is the lock the backend will apply, because it is
 * the same configuration the service resolves against. The client-side figures
 * are a preview of that rule; the server stays the authority and its answer is
 * what the page shows afterwards.
 *
 * Nothing here fabricates yield, APY or earnings: the only figures shown are
 * the ones the backend computed from ledger state.
 */

type LoadStatus = "loading" | "ready" | "error";
type ModalMode = "pledge" | "withdraw";

/** USDT's display precision - the API rejects a mutation with more places. */
const USDT_DECIMALS = 6;

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

function fmt(value: string, digits = 2): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Drops trailing zeros from a fixed-point string without changing its value. */
function trimAmount(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : "0";
}

/** A negative result clamped to zero - the shape both movements need. */
function nonNegative(value: string): string {
  return value.startsWith("-") ? "0" : value;
}

/**
 * The slab covering a commitment total, mirroring the backend's flat cliff:
 * the last slab whose floor the total reaches.
 */
function slabFor(slabs: LiquiditySlab[], committed: string): LiquiditySlab | null {
  let match: LiquiditySlab | null = null;

  for (const slab of slabs) {
    if (compareDecimalStrings(committed, slab.minUsdt) >= 0) {
      match = slab;
    } else {
      break;
    }
  }

  return match;
}

interface Projection {
  /** The typed amount, when it is one the backend would accept. */
  amount: string | null;
  /** The commitment total after the change. */
  total: string | null;
  /** The slab that would apply to `total`. */
  slab: LiquiditySlab | null;
  /** EMBER the change locks (pledge) or releases (withdraw). */
  ember: string | null;
  /** Why the amount cannot be applied, when it cannot. */
  problem: string | null;
}

/**
 * Works out what a pledge or a withdrawal would do, using the same rule the
 * service applies: the EMBER lock is the flat requirement of the slab the new
 * total lands in, and only the difference against what is already locked moves.
 *
 * A withdrawal is capped by `usdtAvailable`, not by the committed total: the
 * difference is what trades have already consumed, and the server refuses to
 * release it.
 */
function projectCommitment(
  mode: ModalMode,
  slabs: LiquiditySlab[],
  committed: string,
  locked: string,
  withdrawable: string,
  amount: string,
): Projection {
  const trimmed = amount.trim();
  const empty: Projection = { amount: null, total: null, slab: null, ember: null, problem: null };

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return empty;
  }
  if (compareDecimalStrings(trimmed, "0") <= 0) {
    return { ...empty, problem: "Enter an amount above zero." };
  }
  if ((trimmed.split(".")[1] ?? "").length > USDT_DECIMALS) {
    return {
      ...empty,
      problem: `USDT carries at most ${USDT_DECIMALS} decimal places.`,
    };
  }

  if (mode === "pledge") {
    const total = addDecimalStrings(committed, trimmed);
    const slab = slabFor(slabs, total);

    if (!slab) {
      return {
        amount: trimmed,
        total,
        slab: null,
        ember: null,
        problem: "That amount is below the lowest approved EMBER slab.",
      };
    }

    return {
      amount: trimmed,
      total,
      slab,
      ember: nonNegative(addDecimalStrings(slab.requiredEmber, `-${locked}`)),
      problem: null,
    };
  }

  if (compareDecimalStrings(trimmed, withdrawable) > 0) {
    return {
      ...empty,
      problem: `That is more than the commitment can release (${fmt(withdrawable)} USDT available).`,
    };
  }

  const total = addDecimalStrings(committed, `-${trimmed}`);
  const closing = compareDecimalStrings(total, "0") === 0;
  const required = closing ? "0" : (slabFor(slabs, total)?.requiredEmber ?? "0");

  return {
    amount: trimmed,
    total,
    slab: closing ? null : slabFor(slabs, total),
    ember: nonNegative(addDecimalStrings(locked, `-${required}`)),
    problem: null,
  };
}

/** A caller with no wallet yet has no balances, which is not an error. */
async function balancesForWallet(): Promise<BalanceSummary[]> {
  try {
    return await getBalances();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

interface LiquidityState {
  commitment: LiquidityMyCommitment;
  health: LiquidityOverview;
  slabs: LiquiditySlabs;
  balances: BalanceSummary[];
}

async function fetchLiquidityState(): Promise<LiquidityState> {
  const [commitment, health, slabs, balances] = await Promise.all([
    getMyLiquidityCommitment(),
    getLiquidityOverview(),
    getLiquiditySlabs(),
    balancesForWallet(),
  ]);

  return { commitment, health, slabs, balances };
}

export default function LiquidityPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [my, setMy] = useState<LiquidityMyCommitment | null>(null);
  const [overview, setOverview] = useState<LiquidityOverview | null>(null);
  const [slabs, setSlabs] = useState<LiquiditySlabs | null>(null);
  const [balances, setBalances] = useState<BalanceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode | null>(null);

  const apply = useCallback((state: LiquidityState) => {
    setMy(state.commitment);
    setOverview(state.health);
    setSlabs(state.slabs);
    setBalances(state.balances);
    setStatus("ready");
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await fetchLiquidityState());
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, [apply]);

  useEffect(() => {
    // State is applied inside the promise callback, never synchronously in the
    // effect body, so this reads as a subscription rather than a render that
    // cascades into another (house pattern; see app/wallet/page.tsx).
    let active = true;
    fetchLiquidityState()
      .then((state) => {
        if (!active) return;
        apply(state);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(messageFor(cause));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [apply]);

  const closeModal = useCallback(() => setModalMode(null), []);

  const handleDone = useCallback(
    async (message: string) => {
      setFlash(message);
      await load();
    },
    [load],
  );

  return (
    <AppShell>
      <RoleGate roles={["LIQUIDITY_PROVIDER", "PLATFORM_ADMIN"]}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
                <Droplets className="w-3.5 h-3.5" />
                Liquidity
              </div>
              <h1 className="text-2xl font-bold text-white">Liquidity Provider</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Your simulated commitment and the platform&apos;s aggregate health. No yield or
                earnings figure is shown because none is measured.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/liquidity/activity"
                className="inline-flex items-center gap-1.5 bg-[#14181F] border border-[#222834] hover:border-[#323B4C] text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              >
                <History className="w-3.5 h-3.5" />
                Activity
              </Link>
              <button
                onClick={() => void load()}
                className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reload
              </button>
            </div>
          </div>

          {flash && (
            <div className="mb-4 rounded-xl border border-[#00D26A]/40 bg-[#00D26A]/10 p-3 text-sm text-[#00D26A]">
              {flash}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
              <AlertTriangle className="w-4 h-4 inline mr-2" />
              {error}
            </div>
          )}

          {status === "loading" && (
            <div className="space-y-3" aria-busy="true">
              <div className="h-28 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-28 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "ready" && my && overview && (
            <div className="space-y-4">
              {/* My commitment */}
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[#FF5A1F]" />
                    My commitment
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setModalMode("pledge")}
                      disabled={!my.commitmentsEnabled}
                      className="inline-flex items-center gap-1.5 bg-gradient-to-r from-[#FF5A1F] to-[#FF8A3D] text-[#170800] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      Pledge USDT
                    </button>
                    {my.commitment && my.commitment.status === "ACTIVE" && (
                      <button
                        type="button"
                        onClick={() => setModalMode("withdraw")}
                        disabled={!my.commitmentsEnabled}
                        className="inline-flex items-center gap-1.5 bg-[#14181F] border border-[#222834] hover:border-[#323B4C] text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        Withdraw USDT
                      </button>
                    )}
                  </div>
                </div>

                {!my.provider ? (
                  <div className="text-sm text-[#9CA3AF]">
                    You are not registered as a liquidity provider yet. Your first pledge registers
                    you automatically.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <Stat label="Provider status" value={my.provider.status} mono />
                    <Stat
                      label="Registered"
                      value={new Date(my.provider.registeredAt).toLocaleDateString()}
                    />
                    {my.commitment ? (
                      <>
                        <Stat
                          label="USDT committed"
                          value={fmt(my.commitment.usdtCommitted)}
                          mono
                        />
                        <Stat
                          label="USDT available"
                          value={fmt(my.commitment.usdtAvailable)}
                          mono
                        />
                        <Stat
                          label="USDT consumed"
                          value={fmt(my.commitment.usdtConsumed)}
                          mono
                        />
                        <Stat
                          label="EMBER locked"
                          value={fmt(my.commitment.emberLocked, 4)}
                          mono
                        />
                        <Stat label="Commitment status" value={my.commitment.status} mono />
                      </>
                    ) : (
                      <div className="col-span-2 sm:col-span-3 text-sm text-[#6B7280]">
                        No commitment yet. One appears here after your first pledge.
                      </div>
                    )}
                  </div>
                )}

                {!my.commitmentsEnabled && (
                  <div className="mt-4 rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-2.5 text-xs text-[#F59E0B]">
                    Commitment mutations are disabled until approved EMBER slabs are configured.
                  </div>
                )}
              </div>

              {/* Aggregate health */}
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-4">Platform liquidity</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Stat
                    label="Aggregate available"
                    value={fmt(overview.aggregateAvailableUsdt)}
                    mono
                  />
                  <Stat label="Threshold" value={fmt(overview.thresholdUsdt)} mono />
                  <Stat label="Shortfall" value={fmt(overview.shortfallUsdt)} mono />
                  <Stat
                    label="Status"
                    value={overview.belowThreshold ? "BELOW THRESHOLD" : "OK"}
                    tone={overview.belowThreshold ? "warn" : "ok"}
                  />
                </div>

                {overview.openRequest && (
                  <div className="mt-4 rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-xs text-[#EF4444]">
                    Open shortfall notice: {fmt(overview.openRequest.requiredUsdt)} USDT required
                    against a {fmt(overview.openRequest.thresholdUsdt)} USDT threshold.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {modalMode && slabs && (
          <CommitmentModal
            mode={modalMode}
            commitment={my?.commitment ?? null}
            slabs={slabs.slabs}
            balances={balances}
            onClose={closeModal}
            onDone={handleDone}
          />
        )}
      </RoleGate>
    </AppShell>
  );
}

function CommitmentModal({
  mode,
  commitment,
  slabs,
  balances,
  onClose,
  onDone,
}: {
  mode: ModalMode;
  commitment: LiquidityCommitmentSummary | null;
  slabs: LiquiditySlab[];
  balances: BalanceSummary[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Idempotency key for the current intent: kept while the amount is unchanged,
  // so a retry after a lost response replays instead of moving the money twice.
  const requestKeyRef = useRef<{ amount: string; key: string } | null>(null);

  const committed = commitment?.usdtCommitted ?? "0";
  const locked = commitment?.emberLocked ?? "0";
  const withdrawable = commitment?.usdtAvailable ?? "0";

  const emberAvailable = balances.find((row) => row.asset.symbol === "EMBER")?.available ?? "0";

  const projection = useMemo(
    () => projectCommitment(mode, slabs, committed, locked, withdrawable, amount),
    [mode, slabs, committed, locked, withdrawable, amount],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const presets =
    mode === "pledge"
      ? slabs
          .map((slab) => slab.minUsdt)
          .filter((value) => compareDecimalStrings(value, "0") > 0)
      : [trimAmount(withdrawable)];

  const emberShort = useMemo(() => {
    if (mode !== "pledge" || !projection.ember) return null;
    const missing = addDecimalStrings(projection.ember, `-${emberAvailable}`);
    return compareDecimalStrings(missing, "0") > 0 ? missing : null;
  }, [mode, projection.ember, emberAvailable]);

  const submit = async (): Promise<void> => {
    if (!projection.amount || projection.problem) return;

    const pending = requestKeyRef.current;
    const clientRequestId =
      pending && pending.amount === projection.amount
        ? pending.key
        : crypto.randomUUID();
    requestKeyRef.current = { amount: projection.amount, key: clientRequestId };

    setBusy(true);
    setFailure(null);
    try {
      if (mode === "pledge") {
        await createLiquidityCommitment({ usdtAmount: projection.amount, clientRequestId });
      } else if (commitment) {
        await reduceLiquidityCommitment({
          commitmentId: commitment.commitmentId,
          usdtAmount: projection.amount,
          clientRequestId,
        });
      } else {
        return;
      }

      requestKeyRef.current = null;
      await onDone(
        mode === "pledge"
          ? `Pledged ${fmt(projection.amount)} USDT. Your commitment now holds ${fmt(projection.total ?? "0")} USDT.`
          : `Withdrew ${fmt(projection.amount)} USDT. Your commitment now holds ${fmt(projection.total ?? "0")} USDT.`,
      );
      onClose();
    } catch (cause) {
      setFailure(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const activeSlab = projection.slab?.minUsdt ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "pledge" ? "Pledge USDT" : "Withdraw USDT"}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-[#262E3B] bg-[#12161D] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-white">
              {mode === "pledge" ? "Pledge USDT" : "Withdraw USDT"}
            </h2>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              {mode === "pledge"
                ? "Commit USDT to the platform's liquidity pool and lock the EMBER the tier requires."
                : "Release USDT from your commitment and unlock the EMBER surplus above the tier you land on."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-[#222834] p-1.5 text-[#9CA3AF] hover:border-[#323B4C] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <label
          className="mt-5 block text-[11px] font-bold tracking-wider text-[#6B7280] uppercase"
          htmlFor="liquidity-amount"
        >
          USDT
        </label>
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-[#262E3B] bg-[#0B0E13] px-3 py-2.5 focus-within:border-[#FF5A1F]">
          <span className="font-mono text-sm font-bold text-[#F59E0B]">USDT</span>
          <input
            id="liquidity-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
            className="w-full bg-transparent font-mono text-lg font-semibold text-white outline-none placeholder:text-[#4B5563]"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmount(preset)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                amount === preset
                  ? "border-[#FF5A1F]/60 bg-[#FF5A1F]/15 text-white"
                  : "border-[#222834] bg-[#14181F] text-[#9CA3AF] hover:border-[#323B4C] hover:text-white"
              }`}
            >
              {mode === "pledge" ? fmt(preset) : "Withdraw all"}
            </button>
          ))}
        </div>

        {projection.problem && (
          <div className="mt-4 rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-2.5 text-xs text-[#F59E0B]">
            {projection.problem}
          </div>
        )}

        {projection.total !== null && (
          <div className="mt-4 space-y-2 rounded-lg border border-[#262E3B] bg-[#0B0E13] p-3 text-xs">
            <Row label="Commitment after this" value={`${fmt(projection.total)} USDT`} />
            <Row
              label={mode === "pledge" ? "EMBER to lock" : "EMBER released"}
              value={`${fmt(projection.ember ?? "0", 4)} EMBER`}
            />
            <Row
              label="EMBER available in wallet"
              value={`${fmt(emberAvailable, 4)} EMBER`}
            />
          </div>
        )}

        {slabs.length > 0 && (
          <table className="mt-4 w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[#6B7280]">
                <th className="pb-2 text-left font-bold">USDT committed</th>
                <th className="pb-2 text-right font-bold">EMBER locked</th>
              </tr>
            </thead>
            <tbody>
              {slabs.map((slab) => {
                const active = activeSlab !== null && slab.minUsdt === activeSlab;
                return (
                  <tr key={slab.minUsdt} className={active ? "text-white" : "text-[#9CA3AF]"}>
                    <td className={`py-1.5 ${active ? "font-semibold" : ""}`}>
                      {active && <span className="mr-1 text-[#FF5A1F]">&#9656;</span>}
                      &#8805; {fmt(slab.minUsdt)}
                    </td>
                    <td className="py-1.5 text-right font-mono">{fmt(slab.requiredEmber)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {emberShort && (
          <div className="mt-3 rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-2.5 text-xs text-[#F59E0B]">
            Your wallet holds {fmt(emberAvailable, 4)} EMBER available, so it is {fmt(emberShort, 4)}{" "}
            EMBER short of this lock.{" "}
            <Link href="/ember-hub" className="font-semibold underline">
              Get EMBER
            </Link>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-[#262E3B] bg-[#0B0E13] p-3 text-[11px] leading-relaxed text-[#9CA3AF]">
          {mode === "pledge" ? (
            <>
              The pledged USDT stays in your wallet and is drawn on when a trade needs liquidity. The
              EMBER lock is what the platform holds against it, and it is released when you
              withdraw.
            </>
          ) : (
            <>
              Only the EMBER above the tier you land on comes back immediately. USDT that trades have
              already consumed cannot be withdrawn.
            </>
          )}
        </div>

        {failure && (
          <div className="mt-4 rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-2.5 text-xs text-[#EF4444]">
            <b className="block text-white">The commitment was not changed</b>
            {failure}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-[#222834] bg-[#14181F] px-3.5 py-2 text-xs font-semibold text-white hover:border-[#323B4C]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !projection.amount || projection.problem !== null}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-[#FF5A1F] to-[#FF8A3D] px-3.5 py-2 text-xs font-bold text-[#170800] transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {mode === "pledge" ? "Pledge USDT" : "Withdraw USDT"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[#6B7280] uppercase tracking-wider text-[10px]">{label}</span>
      <span className="font-mono font-semibold text-white">{value}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ok" | "warn";
}) {
  const color =
    tone === "ok" ? "text-[#00D26A]" : tone === "warn" ? "text-[#F59E0B]" : "text-white";
  return (
    <div>
      <div className="text-[11px] text-[#6B7280] uppercase tracking-wider">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${color} ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}
