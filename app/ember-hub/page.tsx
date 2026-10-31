"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Coins,
  Flame,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Wallet,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import {
  ApiError,
  createEmberPurchase,
  getBalances,
  getEmberHubOverview,
  getEmberHubScenarios,
  getMyEmberPurchases,
  type BalanceSummary,
  type EmberHubScenario,
  type EmberHubStatement,
  type EmberPurchaseRecord,
} from "@/lib/api-client";
import { addDecimalStrings } from "@/lib/decimal";

/**
 * EMBER Hub — buy configured EMBER inventory from the treasury.
 *
 * What this page must keep honest:
 *  - Prices and limits are CONFIGURATION shown by the backend, never market
 *    observations; the live "you pay" figure is derived from that configured
 *    price and labelled as an estimate — the server's exact totals are what the
 *    purchase response reports.
 *  - Entering an amount previews what the payment costs (amount x configured
 *    INR price, with the USDT equivalent); on completion the EMBER lands in
 *    the caller's wallet and the debited USDT leaves it — the balance chips
 *    read the real wallet and reload after every purchase, so the credit is
 *    visible immediately.
 *  - A purchase is an internal transfer: treasury EMBER -> the user, the
 *    user's USDT -> the treasury. On-chain supply does not change, which is
 *    why this page shows no supply figures of its own.
 *  - Purchases are idempotent on a client-generated UUID. The key is minted
 *    once per form intent and reused while the amount is unchanged, so a
 *    retry after a network failure replays the original purchase instead of
 *    buying twice.
 *
 * No role gate: buying inventory is open to every signed-in user. The backend
 * refuses without a session and enforces the per-day/per-month limits
 * regardless of what this page renders.
 */

type LoadStatus = "loading" | "ready" | "error";

function formatINR(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed >= 10000000) return `${(parsed / 10000000).toFixed(1)}cr`;
  if (parsed >= 100000) return `${(parsed / 100000).toFixed(1)}l`;
  return parsed.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function money(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : value;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

/**
 * Wallet balances for the balance chips. A visitor can reach this page before
 * ever creating a wallet, and `GET wallets/me/balances` answers 404 in that
 * case — which is "no balances", not an error.
 */
async function balancesForWallet(): Promise<BalanceSummary[]> {
  try {
    return await getBalances();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

export default function EmberHubPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [statement, setStatement] = useState<EmberHubStatement | null>(null);
  const [scenarios, setScenarios] = useState<EmberHubScenario[]>([]);
  const [purchases, setPurchases] = useState<EmberPurchaseRecord[]>([]);
  const [balances, setBalances] = useState<BalanceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [buying, setBuying] = useState(false);

  // Idempotency key for the current form intent: kept while the amount is
  // unchanged so a failed attempt can be retried without buying twice.
  const requestKeyRef = useRef<{ emberAmount: string; key: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [overview, scenarioList, history, walletBalances] = await Promise.all([
        getEmberHubOverview(),
        getEmberHubScenarios(),
        getMyEmberPurchases(50),
        balancesForWallet(),
      ]);
      setStatement(overview);
      setScenarios(scenarioList.scenarios);
      setPurchases(history.items);
      setBalances(walletBalances);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // State is applied inside the promise callbacks, never synchronously in
    // the effect body, so this reads as a subscription rather than a render
    // that cascades into another (house pattern; see app/wallet/page.tsx).
    let active = true;
    Promise.all([
      getEmberHubOverview(),
      getEmberHubScenarios(),
      getMyEmberPurchases(50),
      balancesForWallet(),
    ])
      .then(([overview, scenarioList, history, walletBalances]) => {
        if (!active) return;
        setStatement(overview);
        setScenarios(scenarioList.scenarios);
        setPurchases(history.items);
        setBalances(walletBalances);
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

  const submitPurchase = async (): Promise<void> => {
    const emberAmount = amount.trim();
    if (!emberAmount) return;

    const pending = requestKeyRef.current;
    const clientRequestId =
      pending && pending.emberAmount === emberAmount ? pending.key : crypto.randomUUID();
    requestKeyRef.current = { emberAmount, key: clientRequestId };

    setBuying(true);
    setError(null);
    setFlash(null);
    try {
      const result = await createEmberPurchase({
        emberAmount,
        clientRequestId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });

      if (result.created) {
        setFlash(
          `Payment complete — paid ₹${money(result.purchase.totalInr)}` +
            (result.purchase.totalUsdt
              ? ` (${result.purchase.totalUsdt} USDT at ${result.purchase.usdtRateInr} INR/USDT)`
              : "") +
            ` and ${money(result.purchase.emberAmount)} EMBER is now in your wallet.` +
            " Both legs moved in one transaction.",
        );
        setAmount("");
        setNote("");
      } else {
        setFlash("This request was already recorded — showing the original purchase. Nothing moved twice.");
      }
      requestKeyRef.current = null;
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBuying(false);
    }
  };

  // Live "what you will pay": amount x the configured INR price, with the
  // USDT equivalent when a rate is configured. Display-only — the exact
  // fixed-point totals are computed server-side by the purchase endpoint.
  const estimate = (() => {
    const parsed = Number(amount.trim());
    if (!statement || !Number.isFinite(parsed) || parsed <= 0) return null;
    const totalInr = parsed * Number(statement.baselinePriceInr);
    const totalUsdt = statement.usdtRateInr ? totalInr / Number(statement.usdtRateInr) : null;
    return {
      inr: totalInr.toFixed(2),
      usdt: totalUsdt !== null ? totalUsdt.toFixed(2) : null,
    };
  })();

  const walletTotalFor = (symbol: string): string | null => {
    const balance = balances.find((row) => row.asset.symbol === symbol);
    return balance ? addDecimalStrings(balance.available, balance.locked) : null;
  };
  const emberWalletTotal = walletTotalFor("EMBER");
  const usdtWalletTotal = walletTotalFor("USDT");

  const dailyLimit = statement?.dailyEmberLimit ? money(statement.dailyEmberLimit) : "—";
  const monthlyLimit = statement?.monthlyEmberLimit ? money(statement.monthlyEmberLimit) : "—";

  return (
    <AppShell>
      <div className="p-6 max-w-[1680px] mx-auto">
        {/* Hero */}
        <div className="relative overflow-hidden rounded-2xl border border-[#FF5A1F]/25 bg-gradient-to-r from-[#2A1408] via-[#1A1410] to-[#12161D] p-6 mb-6">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-[#FF5A1F]/25 blur-3xl"
          />
          <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#FF5A1F] shadow-lg shadow-[#FF5A1F]/30">
                <Flame className="h-6 w-6 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-[#FF5A1F]">
                  <Sparkles className="h-3 w-3" />
                  Ember Hub
                </div>
                <h1 className="mt-1 text-2xl font-bold text-white">Buy EMBER from the treasury</h1>
                <p className="mt-1 max-w-2xl text-sm text-[#9CA3AF]">
                  A fixed configured price, not a market quote. Purchases are internal transfers, so
                  on-chain supply does not change.
                </p>
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[#262E3B] bg-[#0B0D10]/60 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-[#9CA3AF]">
                  <ShieldCheck className="h-3 w-3 text-[#00D26A]" />
                  Internal transfer · supply unchanged
                </div>
              </div>
            </div>
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 self-start rounded-lg border border-[#262E3B] bg-[#0B0D10]/60 px-3 py-2 text-xs font-semibold text-[#9CA3AF] hover:border-[#FF5A1F] hover:text-white transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
            <AlertTriangle className="mr-2 inline h-4 w-4" />
            {error}
          </div>
        )}

        {flash && (
          <div className="mb-4 rounded-xl border border-[#00D26A]/40 bg-[#00D26A]/10 p-3 text-sm text-[#00D26A]">
            <Sparkles className="mr-2 inline h-4 w-4" />
            {flash}
          </div>
        )}

        {status === "loading" && (
          <div className="space-y-3" aria-busy="true">
            <div className="h-28 rounded-xl bg-[#181D26] animate-pulse" />
            <div className="h-44 rounded-xl bg-[#181D26] animate-pulse" />
            <div className="h-56 rounded-xl bg-[#181D26] animate-pulse" />
          </div>
        )}

        {status === "error" && (
          <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-10 text-center">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-[#6B7280]" />
            <h2 className="text-lg font-semibold text-white">The hub terms could not be loaded</h2>
            <p className="mt-1 text-sm text-[#9CA3AF]">{error}</p>
            <button
              onClick={() => void load()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#FF5A1F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#E04B14]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </button>
          </div>
        )}

        {status === "ready" && statement && (
          <>
            {/* Overview */}
            <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <OverviewCard
                icon={<Wallet className="h-4 w-4 text-[#FF5A1F]" />}
                label="Your EMBER"
                value={emberWalletTotal ?? "—"}
                hint="available + locked in your wallet"
              />
              <OverviewCard
                icon={<Coins className="h-4 w-4 text-[#00D26A]" />}
                label="Your USDT"
                value={usdtWalletTotal ?? "—"}
                hint="debited by the USDT leg of a purchase"
              />
              <OverviewCard
                icon={<Flame className="h-4 w-4 text-[#F59E0B]" />}
                label="Configured price"
                value={`₹${money(statement.baselinePriceInr)}`}
                hint="per EMBER · not a market quote"
              />
              <OverviewCard
                icon={<ShieldCheck className="h-4 w-4 text-[#38BDF8]" />}
                label="Your purchase limits"
                value={dailyLimit}
                hint={`daily · ${monthlyLimit} monthly`}
              />
              <OverviewCard
                icon={<ShoppingBag className="h-4 w-4 text-[#9CA3AF]" />}
                label="Treasury inventory"
                value={statement.treasuryAvailableEmber ? money(statement.treasuryAvailableEmber) : "—"}
                hint="EMBER available to deliver"
              />
              <OverviewCard
                icon={<ArrowLeftRight className="h-4 w-4 text-[#9CA3AF]" />}
                label="USDT display rate"
                value={statement.usdtRateInr ? `₹${money(statement.usdtRateInr)}` : "not configured"}
                hint={
                  statement.usdtRateInr
                    ? "conversion only — quotes are labelled"
                    : "USDT legs are refused until a rate is set"
                }
              />
            </div>

            {/* Purchase */}
            <section className="mb-6 rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <ShoppingBag className="h-4 w-4 text-[#00D26A]" />
                  Purchase EMBER
                </h2>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <BalanceChip label="Your EMBER" value={emberWalletTotal} />
                  <BalanceChip label="Your USDT" value={usdtWalletTotal} />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="EMBER amount (e.g. 250)"
                  aria-label="EMBER amount"
                  maxLength={40}
                  className="rounded-lg border border-[#222834] bg-[#14181F] px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:border-[#FF5A1F] focus:outline-none"
                />
                <input
                  type="text"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Note (optional, recorded on the purchase)"
                  aria-label="Purchase note"
                  maxLength={200}
                  className="rounded-lg border border-[#222834] bg-[#14181F] px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:border-[#FF5A1F] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void submitPurchase()}
                  disabled={buying || !amount.trim()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#FF5A1F] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#E04B14] disabled:opacity-50"
                >
                  {buying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShoppingBag className="h-3.5 w-3.5" />
                  )}
                  {buying ? "Buying…" : "Buy from treasury"}
                </button>
              </div>

              {estimate ? (
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-[#FF5A1F]/40 bg-[#FF5A1F]/5 p-3">
                    <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-[#6B7280]">
                      You pay
                    </p>
                    <p className="mt-1 text-xl font-bold text-white">₹{formatINR(estimate.inr)}</p>
                    <p className="mt-0.5 text-[11px] text-[#9CA3AF]">
                      ₹{money(estimate.inr)} exactly ·{" "}
                      {estimate.usdt !== null
                        ? `≈ ${estimate.usdt} USDT at the configured rate`
                        : "USDT rate not configured"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-[#00D26A]/40 bg-[#00D26A]/5 p-3">
                    <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-[#6B7280]">
                      You receive
                    </p>
                    <p className="mt-1 break-all text-xl font-bold text-white">
                      {amount.trim()} EMBER
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#9CA3AF]">
                      credited to your wallet on completion
                    </p>
                  </div>
                  <p className="self-end text-[11px] text-[#6B7280]">
                    Estimate derived from the configured price. The exact INR and USDT totals are
                    computed server-side and reported by the purchase response.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-[#6B7280]">
                  Enter an EMBER amount to see the INR total you would pay at the configured price.
                  The exact totals are computed server-side and shown after the purchase.
                </p>
              )}
            </section>

            {/* Scenarios */}
            <section className="mb-6 rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-white">
                <Info className="h-4 w-4 text-[#6B7280]" />
                Illustrative scenarios
              </h2>
              <p className="mb-4 text-[11px] text-[#6B7280]">
                Display-only: nothing here is computed or recorded.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {scenarios.map((scenario) => (
                  <div
                    key={scenario.label}
                    className="rounded-lg border border-[#222834] bg-[#14181F] p-3"
                  >
                    <p className="text-xs font-semibold text-white">{scenario.label}</p>
                    <p className="mt-1 text-[11px] text-[#9CA3AF]">{scenario.emberAmount} EMBER</p>
                    <p className="mt-1 text-sm font-semibold text-[#FF5A1F]">₹{scenario.totalInr}</p>
                    <p className="text-[11px] text-[#6B7280]">
                      {scenario.totalUsdt ? `${scenario.totalUsdt} USDT` : "USDT rate not configured"}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* History */}
            <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                <Coins className="h-4 w-4 text-[#FF5A1F]" />
                Your purchases
              </h2>
              {purchases.length === 0 ? (
                <p className="text-sm text-[#9CA3AF]">
                  No purchases yet — the form above starts your history.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-[#6B7280]">
                        <th className="py-2 pr-4 font-bold">When</th>
                        <th className="py-2 pr-4 font-bold">EMBER</th>
                        <th className="py-2 pr-4 font-bold">INR total</th>
                        <th className="py-2 pr-4 font-bold">USDT</th>
                        <th className="py-2 pr-4 font-bold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="text-[#9CA3AF]">
                      {purchases.map((purchase) => (
                        <tr key={purchase.purchaseId} className="border-t border-[#1F252E]">
                          <td className="py-2 pr-4 font-mono text-[10px]">
                            {new Date(purchase.purchasedAt).toLocaleString()}
                          </td>
                          <td className="py-2 pr-4 text-white">{money(purchase.emberAmount)}</td>
                          <td className="py-2 pr-4">₹{money(purchase.totalInr)}</td>
                          <td className="py-2 pr-4">{purchase.totalUsdt ?? "—"}</td>
                          <td className="py-2 pr-4">
                            <span
                              title={purchase.failedReason ?? undefined}
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-mono ${
                                purchase.status === "COMPLETED"
                                  ? "border-[#00D26A]/40 text-[#00D26A]"
                                  : "border-[#EF4444]/40 text-[#EF4444]"
                              }`}
                            >
                              {purchase.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <p className="mt-4 text-[11px] text-[#6B7280]">{statement.note}</p>
          </>
        )}
      </div>
    </AppShell>
  );
}

function OverviewCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-[#6B7280]">
          {label}
        </p>
        {icon}
      </div>
      <p className="mt-2 break-words text-lg font-semibold text-white">{value}</p>
      <p className="mt-1 text-[11px] text-[#6B7280]">{hint}</p>
    </div>
  );
}

function BalanceChip({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#222834] bg-[#14181F] px-3 py-2">
      <span className="text-[10px] font-mono uppercase tracking-wider text-[#6B7280]">{label}</span>
      <span className="break-all font-mono text-xs font-bold text-white">{value ?? "—"}</span>
    </div>
  );
}
