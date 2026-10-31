"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  Loader2,
  RefreshCw,
  SearchCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  createEmberMint,
  getBlockchainReconciliation,
  getBlockchainStatus,
  listEmberMints,
  runBlockchainRecovery,
  syncBlockchainEvents,
  type BlockchainReconciliation,
  type BlockchainStatus,
  type EmberMintRequest,
} from "@/lib/api-client";

/**
 * Blockchain (EMBER) — the PLATFORM_ADMIN surface over the chain layer.
 *
 * What this page must keep honest:
 *  - A disabled layer (BLOCKCHAIN_ENABLED=false) is a deployment decision,
 *    not an outage: status still answers 200 with `enabled: false` and
 *    `rpcReachable: null`, while every chain-touching action (mint, recovery,
 *    event sync, reconciliation) answers 503 with a clear message. The UI
 *    shows that state plainly instead of implying a fault.
 *  - Minting never credits the PostgreSQL ledger here — the request only
 *    broadcasts and records; reconciliation is the explicit comparison an
 *    operator reads BEFORE deciding on any correction. Differences are
 *    reported, never mutated.
 *  - Seed/demo issuance (ledger EMBER with no confirmed on-chain mint behind
 *    it) is shown as its own figure so a difference is explained, not hidden.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

function shortHash(hash: string | null): string {
  if (!hash) return "—";
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: "border-[#00D26A]/40 text-[#00D26A]",
  FAILED: "border-[#EF4444]/40 text-[#EF4444]",
  SUBMITTED: "border-[#F59E0B]/40 text-[#F59E0B]",
  PENDING: "border-[#6B7280]/40 text-[#9CA3AF]",
};

export default function BlockchainAdminPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [chain, setChain] = useState<BlockchainStatus | null>(null);
  const [mints, setMints] = useState<EmberMintRequest[]>([]);
  const [reconciliation, setReconciliation] = useState<BlockchainReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [statusResult, mintList] = await Promise.all([
        getBlockchainStatus(),
        listEmberMints(25),
      ]);
      setChain(statusResult);
      setMints(mintList.items);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // State is applied inside the promise callbacks, never synchronously in
    // the effect body (house pattern; see app/wallet/page.tsx).
    let active = true;
    Promise.all([getBlockchainStatus(), listEmberMints(25)])
      .then(([statusResult, mintList]) => {
        if (!active) return;
        setChain(statusResult);
        setMints(mintList.items);
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

  const submitMint = async (): Promise<void> => {
    const trimmed = amount.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setError(null);
    setFlash(null);
    try {
      const result = await createEmberMint({
        amount: trimmed,
        clientRequestId: crypto.randomUUID(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setFlash(
        result.created
          ? `Mint request ${result.request.status}: ${result.request.amount} EMBER on ${result.request.network}.`
          : "This idempotency key was already used — showing the original request. No second mint was attempted.",
      );
      setAmount("");
      setReason("");
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const runRecovery = async (): Promise<void> => {
    setBusyAction("recovery");
    setError(null);
    setFlash(null);
    try {
      const result = await runBlockchainRecovery();
      setFlash(
        `Recovery: examined ${result.examined}, confirmed ${result.confirmed}, failed ${result.failed}, ` +
          `${result.stillOpen} still open (stale broadcasts are left visible, never guessed).`,
      );
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const syncEvents = async (): Promise<void> => {
    setBusyAction("sync");
    setError(null);
    setFlash(null);
    try {
      const result = await syncBlockchainEvents();
      setFlash(
        `Event sync: scanned ${result.scanned} event(s) from block ${result.fromBlock} to ${result.toBlock}, ` +
          `ingested ${result.ingested}, linked ${result.linked}. Re-runs are no-ops by dedupe.`,
      );
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const runReconciliation = async (): Promise<void> => {
    setBusyAction("reconciliation");
    setError(null);
    try {
      setReconciliation(await getBlockchainReconciliation());
    } catch (cause) {
      setReconciliation(null);
      setError(messageFor(cause));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <AppShell>
      <RoleGate roles={["PLATFORM_ADMIN"]}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
                <Blocks className="w-3.5 h-3.5" />
                Blockchain
              </div>
              <h1 className="text-2xl font-bold text-white">EMBER token — chain operations</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Mint requests, event history and the on-chain vs ledger comparison. Comparison only — differences
                are reported, never mutated.
              </p>
            </div>
            <button
              onClick={() => void load()}
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

          {flash && (
            <div className="mb-4 rounded-xl border border-[#00D26A]/40 bg-[#00D26A]/10 p-3 text-sm text-[#00D26A]">
              <Sparkles className="w-4 h-4 inline mr-2" />
              {flash}
            </div>
          )}

          {status === "loading" && (
            <div className="space-y-3" aria-busy="true">
              <div className="h-28 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "error" && (
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-10 text-center">
              <AlertTriangle className="w-10 h-10 text-[#6B7280] mx-auto mb-3" />
              <h2 className="text-lg font-semibold text-white">The layer status could not be loaded</h2>
              <p className="mt-1 text-sm text-[#9CA3AF]">{error}</p>
              <button
                onClick={() => void load()}
                className="mt-4 inline-flex items-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-4 py-2 rounded-lg text-xs font-semibold"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Try again
              </button>
            </div>
          )}

          {status === "ready" && chain && (
            <>
              {/* Status */}
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-4">
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-sm font-semibold text-white">Layer status</h2>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                      chain.enabled
                        ? "border-[#00D26A]/40 text-[#00D26A]"
                        : "border-[#F59E0B]/40 text-[#F59E0B]"
                    }`}
                  >
                    {chain.enabled ? "ENABLED" : "DISABLED"}
                  </span>
                  <span className="text-[10px] font-mono text-[#6B7280]">
                    {chain.network} · chain {chain.chainId}
                  </span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Token</p>
                    <p className="font-mono text-white break-all">{chain.tokenAddress ?? "not configured"}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Treasury</p>
                    <p className="font-mono text-white break-all">{chain.treasuryAddress ?? "not configured"}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Signers</p>
                    <p className="text-white">
                      minter {chain.minterSignerConfigured ? "✓" : "✗"} · burner{" "}
                      {chain.treasurySignerConfigured ? "✓" : "✗"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">RPC</p>
                    <p className="text-white">
                      {chain.rpcReachable === null
                        ? "not probed (layer disabled)"
                        : chain.rpcReachable
                          ? "reachable"
                          : "unreachable"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Lifetime cap</p>
                    <p className="text-white">{chain.maxSupplyWhole ?? "not recorded"}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Event scan</p>
                    <p className="text-white">from block {chain.deploymentBlock}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Confirmations</p>
                    <p className="text-white">{chain.confirmations}</p>
                  </div>
                </div>

                {!chain.enabled && (
                  <div className="mt-3 rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/10 p-3 text-xs text-[#F59E0B] flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      The blockchain layer is disabled: chain-touching actions below will answer 503 until the
                      contracts are deployed from <span className="font-mono">blockchain/</span> and{" "}
                      <span className="font-mono">BLOCKCHAIN_ENABLED=true</span> points the backend at the
                      deployment record. A disabled layer is a deployment decision, not an outage.
                    </span>
                  </div>
                )}
              </div>

              {/* Mint request */}
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-4">
                <h2 className="text-sm font-semibold text-white mb-3">Request a mint to the treasury</h2>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="EMBER amount (e.g. 5000)"
                    maxLength={40}
                    className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
                  />
                  <input
                    type="text"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason (audit trail)"
                    maxLength={120}
                    className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
                  />
                  <button
                    type="button"
                    onClick={() => void submitMint()}
                    disabled={submitting || !amount.trim()}
                    className="inline-flex items-center justify-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
                  >
                    {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Blocks className="w-3.5 h-3.5" />}
                    Broadcast mint
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void runRecovery()}
                      disabled={busyAction !== null}
                      title="Re-poll receipts of open requests; stale broadcasts stay open"
                      className="inline-flex items-center gap-1.5 border border-[#222834] text-[#9CA3AF] hover:text-white hover:border-[#323B4C] px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                    >
                      {busyAction === "recovery" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      Recovery
                    </button>
                    <button
                      type="button"
                      onClick={() => void syncEvents()}
                      disabled={busyAction !== null}
                      title="Pull event history from the deployment block (re-runs are no-ops)"
                      className="inline-flex items-center gap-1.5 border border-[#222834] text-[#9CA3AF] hover:text-white hover:border-[#323B4C] px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                    >
                      {busyAction === "sync" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <UploadCloud className="w-3.5 h-3.5" />
                      )}
                      Sync events
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-[#6B7280]">
                  The ledger is never credited by this request — broadcast, confirm, ingest events, then read the
                  reconciliation below before deciding anything.
                </p>
              </div>

              {/* Mints */}
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-4">
                <h2 className="text-sm font-semibold text-white mb-3">Mint requests</h2>
                {mints.length === 0 ? (
                  <p className="text-sm text-[#9CA3AF]">No mint requests yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-[#6B7280]">
                          <th className="py-2 pr-4">Requested</th>
                          <th className="py-2 pr-4">Amount</th>
                          <th className="py-2 pr-4">Status</th>
                          <th className="py-2 pr-4">Tx</th>
                          <th className="py-2 pr-4">Reason / error</th>
                        </tr>
                      </thead>
                      <tbody className="text-[#9CA3AF]">
                        {mints.map((mint) => (
                          <tr key={mint.mintRequestId} className="border-t border-[#1F252E]">
                            <td className="py-2 pr-4 font-mono text-[10px]">
                              {new Date(mint.requestedAt).toLocaleString()}
                            </td>
                            <td className="py-2 pr-4 text-white">{mint.amount}</td>
                            <td className="py-2 pr-4">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                                  STATUS_STYLES[mint.status] ?? "border-[#6B7280]/40 text-[#9CA3AF]"
                                }`}
                              >
                                {mint.status}
                              </span>
                            </td>
                            <td className="py-2 pr-4 font-mono text-[10px]" title={mint.txHash ?? undefined}>
                              {shortHash(mint.txHash)}
                              {mint.blockNumber ? ` · #${mint.blockNumber}` : ""}
                            </td>
                            <td className="py-2 pr-4 text-[10px]">
                              {mint.errorMessage ?? mint.reason ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Reconciliation */}
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <SearchCheck className="w-4 h-4 text-[#00D26A]" />
                    Reconciliation (on-chain vs ledger)
                  </h2>
                  <button
                    type="button"
                    onClick={() => void runReconciliation()}
                    disabled={busyAction !== null}
                    className="inline-flex items-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                  >
                    {busyAction === "reconciliation" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <SearchCheck className="w-3.5 h-3.5" />
                    )}
                    Run comparison
                  </button>
                </div>

                {!reconciliation && (
                  <p className="text-sm text-[#9CA3AF]">
                    Not run yet. The comparison is read-only: it never mutates the chain or the ledger.
                  </p>
                )}

                {reconciliation && (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                      <div className="rounded-lg border border-[#222834] bg-[#14181F] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                          On-chain
                        </p>
                        <dl className="space-y-1 text-xs">
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Total supply</dt>
                            <dd className="font-mono text-white">{reconciliation.onChain.totalSupply}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Lifetime cap</dt>
                            <dd className="font-mono text-white">{reconciliation.onChain.maxSupply}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Treasury balance</dt>
                            <dd className="font-mono text-white">{reconciliation.onChain.treasuryBalance}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Mint events</dt>
                            <dd className="font-mono text-white">{reconciliation.onChain.mintedEventsTotal}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Burn events</dt>
                            <dd className="font-mono text-white">{reconciliation.onChain.burnedEventsTotal}</dd>
                          </div>
                        </dl>
                      </div>
                      <div className="rounded-lg border border-[#222834] bg-[#14181F] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                          PostgreSQL ledger
                        </p>
                        <dl className="space-y-1 text-xs">
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Issued</dt>
                            <dd className="font-mono text-white">{reconciliation.offChain.ledgerIssuedSupply}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Burned</dt>
                            <dd className="font-mono text-white">{reconciliation.offChain.ledgerBurnedSupply}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Circulating</dt>
                            <dd className="font-mono text-white">
                              {reconciliation.offChain.ledgerCirculatingSupply}
                            </dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Treasury available</dt>
                            <dd className="font-mono text-white">
                              {reconciliation.offChain.treasuryAvailableEmber ?? "—"}
                            </dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Confirmed mints</dt>
                            <dd className="font-mono text-white">
                              {reconciliation.offChain.confirmedMintRequestsTotal}
                            </dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-[#9CA3AF]">Seed/demo issuance</dt>
                            <dd className="font-mono text-[#F59E0B]">
                              {reconciliation.offChain.seedAndDemoIssuedEstimate}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    {reconciliation.differences.length === 0 ? (
                      <div className="rounded-lg border border-[#00D26A]/30 bg-[#00D26A]/10 p-3 text-xs text-[#00D26A]">
                        The chain and the ledger reconcile: every reported figure matches.
                      </div>
                    ) : (
                      <div className="rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/10 p-3">
                        <p className="text-xs text-[#F59E0B] font-semibold mb-2">
                          {reconciliation.differences.length} difference(s) reported — evidence to read, never an
                          automatic correction:
                        </p>
                        <div className="space-y-1.5">
                          {reconciliation.differences.map((difference) => (
                            <div
                              key={difference.kind}
                              className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono"
                            >
                              <span className="text-white">{difference.kind}</span>
                              <span className="text-[#9CA3AF]">
                                chain {difference.onChainValue} · ledger {difference.offChainValue}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <p className="mt-3 text-[11px] text-[#6B7280]">{reconciliation.note}</p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
