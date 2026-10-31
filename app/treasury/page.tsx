"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  adminFundTreasury,
  adminPlatformOverview,
  ApiError,
  type PlatformMovementResult,
  type PlatformOverview,
} from "@/lib/api-client";

/**
 * The platform treasury, in money terms.
 *
 * The page shows exactly two things: the treasury money balances
 * (working-capital USDT and the platform's INR capital, straight from
 * GET admin/platform/overview, never derived here) and the admin funding
 * control (POST admin/platform/treasury/funding), which credits the treasury
 * wallet with an ADJUSTMENT ledger leg and an audit row in one transaction.
 *
 * The floor/capacity policy cards of the old dashboard are gone: those are
 * reporting-only figures about limits, not money, and the page no longer
 * mixes the two. Withdrawals and per-user corrections remain on the admin
 * platform page; this page deliberately offers only the add-capital action.
 */
type LoadStatus = "loading" | "ready" | "error";

type FundAsset = "INR" | "USDT";

interface TreasuryMoney {
  symbol: string;
  decimals: number;
  available: string;
  locked: string;
}

/** Reads the treasury view. Sets no state, so an effect can call it freely. */
async function fetchOverview(): Promise<PlatformOverview> {
  return adminPlatformOverview();
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

/** Groups an integer part and trims the fraction for display only. */
function fmt(value: string, fractionDigits = 2): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, fractionDigits).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

function MoneyCard({
  title,
  icon,
  accent,
  money,
  unit,
}: {
  title: string;
  icon: React.ReactNode;
  accent: string;
  money: TreasuryMoney | null;
  unit: string;
}) {
  return (
    <div className="rounded-xl border border-[#2A3140] bg-[#1A1F2E] p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[#9CA3AF]">
        {icon}
        <span className="text-[11px] font-bold tracking-wider uppercase">{title}</span>
        <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full border border-[#2A3140] text-[#9CA3AF]">
          {accent}
        </span>
      </div>
      {money ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[28px] text-[#00D26A]">{fmt(money.available, money.decimals)}</span>
            <span className="text-[12px] text-[#6B7280]">{unit} available</span>
          </div>
          <div className="border-t border-[#2A3140] pt-2 flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-[#6B7280]">Locked</span>
              <span className="font-mono text-[14px] text-[#F3F4F6]">{fmt(money.locked, money.decimals)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-[#6B7280]">Total</span>
              <span className="font-mono text-[14px] text-[#F3F4F6]">
                {fmt(
                  (
                    Number(money.available.replace(/,/g, "")) + Number(money.locked.replace(/,/g, ""))
                  ).toFixed(money.decimals),
                  money.decimals,
                )}
              </span>
            </div>
          </div>
        </>
      ) : (
        <span className="text-[13px] text-[#6B7280]">No {unit} balance yet</span>
      )}
    </div>
  );
}

export default function TreasuryPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);

  const [fundAsset, setFundAsset] = useState<FundAsset>("USDT");
  const [amountText, setAmountText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [funding, setFunding] = useState(false);
  const [funded, setFunded] = useState<PlatformMovementResult | null>(null);
  const [fundError, setFundError] = useState<ExecutionFailure | null>(null);

  const load = useCallback(async () => {
    setOverview(await fetchOverview());
    setError(null);
    setStatus("ready");
  }, []);

  useEffect(() => {
    let active = true;
    // State is applied inside the promise callback, never synchronously in
    // the effect body, so this reads as a subscription rather than a render
    // that cascades into another.
    fetchOverview()
      .then((snapshot) => {
        if (active) {
          setOverview(snapshot);
          setError(null);
          setStatus("ready");
        }
      })
      .catch((snapshotError: unknown) => {
        if (active) {
          setError(messageFor(snapshotError));
          setStatus("error");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setStatus("loading");
    load()
      .catch((loadError: unknown) => {
        setError(messageFor(loadError));
        setStatus("error");
      });
  }, [load]);

  const decimals = fundAsset === "INR" ? 2 : 6;
  const amountPattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  const amountValid = amountPattern.test(amountText.trim()) && Number(amountText.trim()) > 0;
  const canFund = amountValid && !funding;

  const submitFunding = useCallback(async () => {
    if (!canFund) return;
    setFunding(true);
    setFunded(null);
    setFundError(null);
    try {
      const result = await adminFundTreasury({
        assetSymbol: fundAsset,
        amount: amountText.trim(),
        // The backend requires a note on every balance change; the admin may
        // write their own reason, otherwise the console supplies one.
        note: noteText.trim() || `Admin ${fundAsset} capital top-up via treasury console`,
      });
      setFunded(result);
      setAmountText("");
      setNoteText("");
      await load();
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      setFundError({
        message: messageFor(error),
        status: api?.status ?? 0,
      });
    } finally {
      setFunding(false);
    }
  }, [canFund, fundAsset, amountText, noteText, load]);

  const treasury = overview?.treasury ?? null;
  const usdt = treasury?.balances.find((row) => row.symbol === "USDT") ?? null;
  const inr = treasury?.balances.find((row) => row.symbol === "INR") ?? null;

  return (
    <AppShell>
      <RoleGate roles={["PLATFORM_ADMIN"]}>
        <div className="flex-1 overflow-y-auto bg-[#12161E] px-8 py-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-[22px] font-bold text-white">Treasury</h1>
              <p className="text-[13px] text-[#6B7280] mt-1">
                Platform working capital and treasury money - balances read straight from the
                ledger, capital added only through the funding box below.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {status === "loading" ? (
                <Loader2 className="w-4 h-4 text-[#FF5A1F] animate-spin" />
              ) : (
                <span
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                    status === "error"
                      ? "border-[#EF4444]/40 text-[#EF4444]"
                      : "border-[#00D26A]/40 text-[#00D26A]"
                  }`}
                >
                  {status === "error" ? "READ FAILED" : "LEDGER SYNCED"}
                </span>
              )}
              <button
                onClick={refresh}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[#2A3140] text-[13px] text-[#9CA3AF] hover:text-white hover:border-[#FF5A1F]/60 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            </div>
          </div>

          {error ? (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-[#EF4444]/30 bg-[#EF4444]/10 px-4 py-3 text-[13px] text-[#FCA5A5]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          ) : null}

          {status === "loading" && !treasury ? (
            <div className="flex items-center gap-3 text-[#9CA3AF] text-[13px] py-16">
              <Loader2 className="w-4 h-4 animate-spin" />
              Reading the treasury balances...
            </div>
          ) : null}

          {treasury ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <MoneyCard
                  title="USDT Working Capital"
                  icon={<Wallet className="w-4 h-4" />}
                  accent="TREASURY"
                  money={usdt}
                  unit="USDT"
                />
                <MoneyCard
                  title="Platform Capital"
                  icon={<Building2 className="w-4 h-4" />}
                  accent="TREASURY"
                  money={inr}
                  unit="₹ INR"
                />
              </div>

              {/* Add capital to the platform treasury */}
              <div className="rounded-xl border border-[#2A3140] bg-[#1A1F2E] p-5 mb-4">
                <div className="flex items-center gap-2 text-[#9CA3AF] mb-1">
                  <Plus className="w-4 h-4" />
                  <span className="text-[11px] font-bold tracking-wider uppercase">
                    Add capital to the treasury
                  </span>
                </div>
                <p className="text-[12px] text-[#6B7280] mb-3">
                  Credits the treasury wallet immediately and records the movement in the ledger and
                  the admin audit trail. The treasury wallet is provisioned on the first credit if
                  needed.
                </p>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5 bg-[#161B24] p-1 rounded-lg border border-[#242C3B]">
                    {(["INR", "USDT"] as FundAsset[]).map((asset) => (
                      <button
                        key={asset}
                        onClick={() => {
                          setFundAsset(asset);
                          setFunded(null);
                          setFundError(null);
                        }}
                        className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                          fundAsset === asset
                            ? "bg-[#FF5A1F] text-white"
                            : "text-[#7B8799] hover:text-white"
                        }`}
                      >
                        {asset === "INR" ? "₹ INR" : "USDT"}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amountText}
                    onChange={(event) => setAmountText(event.target.value)}
                    placeholder={fundAsset === "INR" ? "1,000,000.00" : "50000.000000"}
                    className="w-48 bg-[#161B24] border border-[#242C3B] rounded-lg px-3 py-2 font-mono text-sm text-white placeholder-[#4C5563] focus:outline-none focus:border-[#FF5A1F]"
                  />
                  <input
                    type="text"
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="Note (optional - e.g. approved capital injection)"
                    maxLength={140}
                    className="w-72 bg-[#161B24] border border-[#242C3B] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4C5563] focus:outline-none focus:border-[#FF5A1F]"
                  />
                  <button
                    onClick={() => void submitFunding()}
                    disabled={!canFund}
                    className="px-4 py-2 rounded-lg bg-[#FF5A1F] hover:bg-[#E14E15] text-white text-[13px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                  >
                    {funding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {funding ? "Adding..." : "Add"}
                  </button>
                </div>

                {amountText.trim().length > 0 && !amountValid && (
                  <p className="mt-2 text-[11px] text-[#FF5A1F] font-mono">
                    {fundAsset === "INR"
                      ? "INR amounts take digits only, up to 2 decimals, greater than zero."
                      : "USDT amounts take digits only, up to 6 decimals, greater than zero."}
                  </p>
                )}

                {funded !== null && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#00D26A]/40 bg-[#00D26A]/10 px-3 py-2 text-[13px] text-[#00D26A]">
                    <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      Capital added - the treasury now holds {funded.available} {funded.asset.symbol}{" "}
                      available. Ledger: ADJUSTMENT credit, audited.
                    </span>
                  </div>
                )}

                {fundError !== null && (
                  <div className="mt-3 rounded-lg border border-[#FF5A1F]/40 bg-[#FF5A1F]/10 px-3 py-2 text-[13px] text-[#FF5A1F]">
                    <p className="font-semibold">
                      {fundError.status === 403
                        ? "Only a PLATFORM_ADMIN can fund the treasury."
                        : fundError.status === 401
                          ? "Your session expired - sign in again."
                          : "The funding did not go through."}
                    </p>
                    <p className="mt-1 text-[12px] text-[#FCA5A5]">{fundError.message}</p>
                  </div>
                )}

                <p className="mt-3 text-[11px] text-[#6B7280]">
                  Nothing here invents figures: the balances above are the treasury wallet
                  {"'"}s own ledger rows, and funding is a real wallet credit - not a dashboard
                  number. Withdrawals and per-account corrections live on the{" "}
                  <Link href="/admin/platform" className="text-[#FF5A1F] hover:underline">
                    admin platform controls
                  </Link>
                  .
                </p>
              </div>

              {!treasury.provisioned ? (
                <div className="flex items-center gap-3 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-4 py-3 text-[13px] text-[#FCD34D]">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  The treasury account ({treasury.walletId ? "wallet exists" : "no wallet yet"})
                  {" "}has no balances yet - use the funding box above to add the first capital.
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </RoleGate>
    </AppShell>
  );
}

interface ExecutionFailure {
  message: string;
  status: number;
}
