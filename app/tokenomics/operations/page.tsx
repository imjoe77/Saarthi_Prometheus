"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Database,
  Flame,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import { useRoles } from "@/components/RoleProvider";
import { addDecimalStrings } from "@/lib/decimal";
import {
  ApiError,
  createTokenAllocation,
  createTokenBurn,
  createTokenBuyback,
  executeTokenBuyback,
  getEmberSupply,
  getExchangeRevenue,
  getTokenomicsConfig,
  getTokenomicsRecords,
  previewTokenAllocation,
  runExchangeRevenueOnce,
  type EmberSupply,
  type ExchangeRevenueBurnRef,
  type ExchangeRevenueEventRecord,
  type ExchangeRevenueSummary,
  type TokenomicsConfig,
  type TokenomicsPreview,
  type TokenomicsRecords,
} from "@/lib/api-client";

/**
 * MODULE 11 — the EMBER tokenomics page.
 *
 * Every figure on this page comes from the BFF: the configured split
 * (GET /tokenomics/config), the ledger-derived supply (GET /ember/supply),
 * the caller's own records (GET /tokenomics/records) and the platform-wide
 * exchange feed (GET /tokenomics/exchange-revenue). The split calculator
 * posts to /tokenomics/preview, which computes server-side and persists
 * nothing; a record is written only when the user explicitly asks for one.
 *
 * What is simulated and what is real is labelled everywhere it matters:
 * buybacks are SIMULATED records (execution is recorded, never performed on
 * any market), the reference amount is an illustrative metric and never cash
 * or funding, and burns are the only operation that destroys EMBER — each one
 * debits the treasury and reduces circulating supply exactly once.
 *
 * There is deliberately no market price, USD valuation, burn velocity or
 * on-chain address on this page: the platform publishes none of those, so the
 * design's invented figures are replaced by the ledger figures that do exist.
 *
 * Idempotency keys are pinned per action and reused until the action
 * succeeds, so a retry replays the original record instead of duplicating it.
 */

type LoadStatus = "loading" | "ready" | "error";

/** Which of the page's four reads failed, each mapped to the API's own words. */
type SnapshotFailures = Partial<Record<"config" | "supply" | "records" | "exchangeRevenue", string>>;

interface TokenomicsSnapshot {
  config: TokenomicsConfig | null;
  supply: EmberSupply | null;
  records: TokenomicsRecords;
  exchangeRevenue: ExchangeRevenueSummary | null;
  failures: SnapshotFailures;
}

/**
 * Reads the whole tokenomics view. Sets no state, so an effect can call it freely.
 *
 * The four reads are settled independently rather than awaited together. Under
 * `nest start --watch` the backend restarts on every save, and a page that
 * demands all four at once blanks completely for a blip that clears in seconds.
 * Each section now shows its own failure and the rest of the page keeps working.
 */
async function fetchSnapshot(): Promise<TokenomicsSnapshot> {
  const [config, supply, records, exchangeRevenue] = await Promise.allSettled([
    getTokenomicsConfig(),
    getEmberSupply(),
    getTokenomicsRecords(),
    getExchangeRevenue(20),
  ]);

  const failures: SnapshotFailures = {};

  const take = <T,>(
    key: keyof SnapshotFailures,
    result: PromiseSettledResult<T>,
    fallback: T,
  ): T => {
    if (result.status === "fulfilled") return result.value;
    failures[key] = messageFor(result.reason);
    return fallback;
  };

  return {
    config: take("config", config, null),
    supply: take("supply", supply, null),
    records: take("records", records, { allocations: [], buybacks: [], burns: [] }),
    exchangeRevenue: take("exchangeRevenue", exchangeRevenue, null),
    failures,
  };
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }

  return "Something went wrong while talking to the Prometheus API.";
}

/**
 * Waits before each successive snapshot read, in milliseconds.
 *
 * The backend runs under `nest start --watch`, which restarts it on every source
 * save; port 3001 stays closed for the whole rebuild-and-bootstrap window, five
 * to twenty seconds here. The proxy absorbs a sub-second race, this absorbs a
 * restart. Without it the page reports "the API is not reachable" about something
 * that was already coming back, and every reload during a save looks like a
 * failure to whoever is watching the screen.
 *
 * The budget is finite on purpose: after about a minute the page says the API is
 * unreachable rather than spinning forever, because at that point it genuinely is.
 */
const SNAPSHOT_RETRY_DELAYS_MS = [0, 1_500, 3_000, 5_000, 9_000, 15_000, 25_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Groups an integer part and trims the fraction for display only. */
function fmt(value: string, fractionDigits = 2): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, fractionDigits).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Compact display-only form of a supply figure (e.g. 42.16M). */
function compactEmber(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed >= 1_000_000_000) return `${(parsed / 1_000_000_000).toFixed(2)}B`;
  if (parsed >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2)}M`;
  if (parsed >= 1_000) return `${(parsed / 1_000).toFixed(2)}K`;
  return fmt(value, 2);
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function timeAgo(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return formatTimestamp(iso);
  if (elapsed < 60_000) return `${Math.max(1, Math.floor(elapsed / 1_000))} sec ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} h ago`;
  return `${Math.floor(elapsed / 86_400_000)} d ago`;
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function pctOf(value: string, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, (parsed / total) * 100));
}

const DONUT_CENTER = 150;
const DONUT_OUTER = 115;
const DONUT_INNER = 75;

function donutPoint(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: DONUT_CENTER + radius * Math.cos(rad), y: DONUT_CENTER + radius * Math.sin(rad) };
}

/** Builds one donut segment from percentages of the circle (0–100 each). */
function donutPath(startPct: number, endPct: number): string {
  const gap = 1.2;
  const a0 = -90 + startPct * 3.6 + gap / 2;
  const a1 = -90 + endPct * 3.6 - gap / 2;
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  const o0 = donutPoint(a0, DONUT_OUTER);
  const o1 = donutPoint(a1, DONUT_OUTER);
  const i1 = donutPoint(a1, DONUT_INNER);
  const i0 = donutPoint(a0, DONUT_INNER);

  return [
    `M ${o0.x.toFixed(2)} ${o0.y.toFixed(2)}`,
    `A ${DONUT_OUTER} ${DONUT_OUTER} 0 ${largeArc} 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `L ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    `A ${DONUT_INNER} ${DONUT_INNER} 0 ${largeArc} 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

export default function TokenomicsPage() {
  const { roles, loading: rolesLoading } = useRoles();
  const isAdmin = roles.includes("PLATFORM_ADMIN");

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [config, setConfig] = useState<TokenomicsConfig | null>(null);
  const [supply, setSupply] = useState<EmberSupply | null>(null);
  const [records, setRecords] = useState<TokenomicsRecords>({
    allocations: [],
    buybacks: [],
    burns: [],
  });
  // Platform-wide, unlike `records`: the exchange feed spans every account's
  // settled orders, and the backend read is not filtered by caller.
  const [exchangeRevenue, setExchangeRevenue] = useState<ExchangeRevenueSummary | null>(null);

  // Preview calculator (computation only, never a record).
  const [referenceAmount, setReferenceAmount] = useState("80000");
  const [emberPrice, setEmberPrice] = useState("10");
  const [preview, setPreview] = useState<TokenomicsPreview | null>(null);

  // Record-creation forms.
  const [selectedAllocationId, setSelectedAllocationId] = useState<string>("");
  const [directBurnAmount, setDirectBurnAmount] = useState("");
  const [allocationKey, setAllocationKey] = useState<string>(() => crypto.randomUUID());
  const [proposalKey, setProposalKey] = useState<string>(() => crypto.randomUUID());
  const [directBurnKey, setDirectBurnKey] = useState<string>(() => crypto.randomUUID());
  // BUYBACK burns are keyed per buyback so row retries replay, not double-burn.
  const [burnKeys, setBurnKeys] = useState<Record<string, string>>({});

  const [activeSlice, setActiveSlice] = useState<number | null>(null);
  const [ledgerTab, setLedgerTab] = useState<"all" | "burns" | "buybacks" | "allocations">("all");
  // Derived when the snapshot arrives: the cutoff is a clock read, which must
  // not happen during render.
  const [callerBurn24h, setCallerBurn24h] = useState("0");
  // When the snapshot was read, so the hero can show the figures are live
  // rather than static. Clock read happens in the callback, not in render.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  // Reads that failed while the rest of the page loaded. Each one degrades its
  // own section instead of taking the whole view down with it.
  const [unavailable, setUnavailable] = useState<SnapshotFailures>({});
  // Which attempt in the retry budget the page is on, or null once it settled.
  // Lets a restart look like what it is - a wait - rather than a dead page.
  const [retrying, setRetrying] = useState<{ attempt: number; total: number } | null>(null);
  // Bumped by every new load and by unmount; an in-flight loop checks it after
  // each await, so a cancelled load can no longer write state.
  const loadRun = useRef(0);

  const applySnapshot = useCallback((snapshot: TokenomicsSnapshot) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    const burned24h = snapshot.records.burns
      .filter((burn) => new Date(burn.burnedAt).getTime() >= cutoff)
      .reduce((total, burn) => addDecimalStrings(total, burn.amount), "0");

    setConfig(snapshot.config);
    setSupply(snapshot.supply);
    setRecords(snapshot.records);
    setExchangeRevenue(snapshot.exchangeRevenue);
    setUnavailable(snapshot.failures);
    setCallerBurn24h(burned24h);
    setLoadedAt(Date.now());

    // The hero, the supply map and the operations panel all derive from these
    // two reads. With either gone there is nothing to degrade to, so the page
    // says so rather than rendering a half-truth.
    if (!snapshot.config || !snapshot.supply) {
      setError(snapshot.failures.config ?? snapshot.failures.supply ?? null);
      setStatus("error");
      return;
    }

    setError(null);
    setStatus("ready");
  }, []);

  /**
   * Reads the whole view, retrying with backoff while any read is missing.
   *
   * A partially loaded page is still a page. As soon as the two reads the layout
   * is built on - config and supply - are back, they are rendered and only the
   * sections that failed keep being retried; the reader sees real figures
   * immediately instead of waiting for the slowest endpoint. Nothing is applied
   * while config or supply is still missing, because there is no honest partial
   * view without them, and the retry banner says why.
   */
  const load = useCallback(
    async (mode: "retry" | "single" = "retry") => {
      const delays: readonly number[] = mode === "retry" ? SNAPSHOT_RETRY_DELAYS_MS : [0];
      const run = (loadRun.current += 1);

      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        // Yielded even when the delay is zero: state is never written in the
        // same tick the effect ran, so the first load reads as a subscription
        // to the API rather than a render that cascades into another render.
        await sleep(delays[attempt]);
        if (run !== loadRun.current) return;

        const snapshot = await fetchSnapshot();
        if (run !== loadRun.current) return;

        const failed = Object.keys(snapshot.failures).length;
        const renderable = Boolean(snapshot.config && snapshot.supply);
        const exhausted = attempt === delays.length - 1;

        if (failed === 0 || renderable || exhausted) applySnapshot(snapshot);
        if (failed === 0 || exhausted) {
          setRetrying(null);
          return;
        }

        setRetrying({ attempt: attempt + 2, total: SNAPSHOT_RETRY_DELAYS_MS.length });
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    // `load` is started from a promise callback rather than directly in the
    // effect body, and it yields before its first write, so nothing is set
    // while React is still running this effect: the page subscribes to the API
    // instead of cascading one render into the next.
    void Promise.resolve().then(() => load());

    return () => {
      loadRun.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => {
    setError(null);
    setNotice(null);
    setStatus("loading");
    void load();
  }, [load]);

  const runAction = useCallback(
    async (tag: string, action: () => Promise<string>) => {
      setBusy(tag);
      setError(null);
      setNotice(null);

      try {
        setNotice(await action());
        // One read, no retry budget: the action itself just succeeded, so the
        // API is demonstrably up, and holding `busy` through a minute of
        // backoff would lock the panel for a refresh that can be retried by
        // hand if it is ever needed.
        await load("single");
      } catch (actionError) {
        setError(messageFor(actionError));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const handlePreview = async () => {
    setBusy("preview");
    setError(null);
    setNotice(null);

    try {
      setPreview(await previewTokenAllocation({ referenceAmount, emberPrice }));
    } catch (previewError) {
      setPreview(null);
      setError(messageFor(previewError));
    } finally {
      setBusy(null);
    }
  };

  const handleRecordAllocation = () => {
    if (!preview) return;

    void runAction("allocation", async () => {
      await createTokenAllocation({
        referenceAmount: preview.referenceAmount,
        emberPrice: preview.emberPrice,
        clientRequestId: allocationKey,
      });
      setAllocationKey(crypto.randomUUID());
      return "Allocation recorded. A retry with the same request replays this record instead of writing a second one.";
    });
  };

  const handleProposeBuyback = () => {
    if (!selectedAllocationId) return;

    void runAction("proposal", async () => {
      await createTokenBuyback({
        allocationId: selectedAllocationId,
        clientRequestId: proposalKey,
      });
      setProposalKey(crypto.randomUUID());
      return "Simulated buyback proposed. It moves nothing — supply changes only when a burn is recorded.";
    });
  };

  const handleRecordExecution = (buybackId: string, executedPrice: string) => {
    void runAction(`execute:${buybackId}`, async () => {
      await executeTokenBuyback(buybackId, { executedPrice });
      return "Simulated execution recorded at that price. One-way: the recording is never overwritten, and no market order was placed.";
    });
  };

  const handleDirectBurn = () => {
    void runAction("direct-burn", async () => {
      await createTokenBurn({
        source: "DIRECT",
        amount: directBurnAmount,
        clientRequestId: directBurnKey,
      });
      setDirectBurnKey(crypto.randomUUID());
      setDirectBurnAmount("");
      return "Burn recorded. The treasury was debited and circulating supply fell by exactly this amount.";
    });
  };

  const handleBurnBuyback = (buybackId: string) => {
    let key = burnKeys[buybackId];

    if (!key) {
      key = crypto.randomUUID();
      setBurnKeys((previous) => ({ ...previous, [buybackId]: key }));
    }

    void runAction(`burn:${buybackId}`, async () => {
      await createTokenBurn({
        source: "BUYBACK",
        buybackId,
        clientRequestId: key,
      });
      setBurnKeys((previous) => {
        const next = { ...previous };
        delete next[buybackId];
        return next;
      });
      return "Burn recorded for the executed quantity. The treasury was debited and circulating supply fell by exactly that quantity.";
    });
  };

  /**
   * Drain the settled-order queue now. The same code the background worker runs,
   * so it is a schedule shortcut rather than a different path — and it drives
   * burns, which is why the backend gates it to PLATFORM_ADMIN.
   */
  const handleRunExchangePass = () => {
    void runAction("exchange-pass", async () => {
      const { processed } = await runExchangeRevenueOnce();
      return `Exchange revenue pass finished — ${processed} order${processed === 1 ? "" : "s"} newly taken from the queue. Orders already completed are not re-processed, and orders blocked by a treasury guardrail report the same refusal.`;
    });
  };

  const burnedBuybackIds = useMemo(
    () => new Set(records.burns.map((burn) => burn.buybackId).filter((id): id is string => !!id)),
    [records.burns],
  );

  const ledgerEntries = useMemo<LedgerEntry[]>(() => {
    const entries: LedgerEntry[] = [];

    for (const allocation of records.allocations) {
      entries.push({
        id: allocation.allocationId,
        at: allocation.allocatedAt,
        kind: "allocation",
        label: "Allocation recorded",
        ember: addDecimalStrings(allocation.directBurnEmber, allocation.buybackEmber),
        inr: allocation.referenceAmount,
        status: "RECORDED",
      });
    }

    for (const buyback of records.buybacks) {
      entries.push({
        id: buyback.buybackId,
        at: buyback.executedAt ?? buyback.simulatedAt,
        kind: "buyback",
        label:
          buyback.status === "SIMULATED"
            ? "Simulated buyback proposed"
            : "Simulated execution recorded",
        ember: buyback.executedEmber ?? buyback.emberQuantity,
        inr: buyback.buybackInr,
        status: buyback.status === "SIMULATED" ? "SIMULATED" : "EXECUTED · SIM",
        buyback,
      });
    }

    for (const burn of records.burns) {
      entries.push({
        id: burn.burnId,
        at: burn.burnedAt,
        kind: "burn",
        label: burn.source === "DIRECT" ? "Direct burn" : "Buyback burn",
        ember: burn.amount,
        inr: null,
        status: "BURNED",
      });
    }

    entries.sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
    return entries;
  }, [records]);

  const visibleEntries = useMemo(() => {
    if (ledgerTab === "all") return ledgerEntries;
    const wanted = ledgerTab === "burns" ? "burn" : ledgerTab === "buybacks" ? "buyback" : "allocation";
    return ledgerEntries.filter((entry) => entry.kind === wanted);
  }, [ledgerEntries, ledgerTab]);

  const callerBurnTotal = useMemo(
    () => records.burns.reduce((total, burn) => addDecimalStrings(total, burn.amount), "0"),
    [records.burns],
  );

  const recentBurns = useMemo(() => [...records.burns].slice(0, 12).reverse(), [records.burns]);

  const errorTitle =
    error && error.toLowerCase().includes("unauthorized")
      ? "Sign in to manage tokenomics"
      : "Could not load tokenomics data";

  return (
    <AppShell>
      <style>{EMBER_PAGE_CSS}</style>
      <div className="mx-auto max-w-[1680px] p-6">
        {/* TOP BAR */}
        <div className="flex flex-wrap items-center gap-3 pb-5 text-[13px] text-[#8a8f9b]">
          <span className="grid h-9 w-9 place-items-center rounded-[9px] border border-[#24272f] bg-[#14161b]">
            <Flame className="h-4 w-4 text-[#ff6a1a]" />
          </span>
          <b className="font-semibold text-[#eceef2]">EMBER</b>
          <span>/</span>
          <span>Deflationary hub</span>
          <span className="flex-1" />
          <span className="hidden rounded-full bg-[#ff6a1a]/10 px-3 py-1 text-[11px] font-bold text-[#ff6a1a] sm:inline">
            Ledger-reconciled · simulated buybacks
          </span>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-[#24272f] bg-[#14161b] px-3.5 py-2 text-xs font-semibold text-[#eceef2] transition hover:bg-[#1a1d23]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <Link
            href="/ember-hub"
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-[#ff6a1a] bg-[#ff6a1a] px-4 py-2 text-xs font-bold text-white transition hover:brightness-110"
          >
            <ShoppingBag className="h-3.5 w-3.5" />
            Buy EMBER
          </Link>
        </div>

        {/* HEAD */}
        <div className="mb-5">
          <h1 className="text-[28px] font-extrabold tracking-[-0.02em] text-white">EMBER</h1>
          <p className="mt-1 max-w-[620px] text-sm text-[#8a8f9b]">
            The Prometheus token. {config ? `${config.directBurnPct}% of every recorded reference amount is burned directly from the treasury and ${config.buybackPct}% is recorded as a simulated buyback.` : "The configured direct-burn and simulated-buyback split is read from the API."}{" "}
            Supply figures are ledger-derived; no market price is published.
          </p>
        </div>

        {retrying && (
          <div className="mb-4 flex items-center gap-3 rounded-[14px] border border-[#ffb020]/30 bg-[#ffb020]/5 p-4">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#ffb020]" />
            <p className="flex-1 text-xs text-[#c5cfde]">
              The Prometheus API is restarting — it refuses connections for a few seconds whenever
              the backend rebuilds, which is normal in development. Retrying automatically (attempt{" "}
              {retrying.attempt} of {retrying.total}); this page will fill itself in when it comes
              back.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-[14px] border border-[#ff6a1a]/30 bg-[#ff6a1a]/5 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#ff6a1a]" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">{errorTitle}</p>
              <p className="mt-0.5 text-xs text-[#c5cfde]">{error}</p>
            </div>
            <button
              type="button"
              onClick={refresh}
              className="text-xs font-bold text-[#ff6a1a] hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {notice && (
          <div className="mb-4 flex items-start gap-3 rounded-[14px] border border-[#3ddc97]/30 bg-[#3ddc97]/5 p-4">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#3ddc97]" />
            <p className="flex-1 text-xs text-[#c5cfde]">{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-xs font-bold text-[#3ddc97] hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {status === "loading" && <LoadingState />}

        {status === "ready" && config && supply && (
          <>
            <BurnHero supply={supply} config={config} loadedAt={loadedAt} />

            <UtilityRail config={config} />

            <SectionHead
              title="Supply map"
              description="Where the issued EMBER sits right now. Tap a segment or a legend card."
            />
            <SupplyTiles supply={supply} />

            <div className="eh-card mt-4 grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <SupplyDonut
                supply={supply}
                active={activeSlice}
                onActivate={setActiveSlice}
              />
              <SupplyLegend supply={supply} active={activeSlice} onActivate={setActiveSlice} />
            </div>

            {/* MODULE 08 x MODULE 11 — the exchange feed */}
            <SectionHead
              title="Exchange revenue feed"
              description="What settled USDT buy orders have handed the buyback & burn engine, platform-wide."
              right={
                <div className="flex flex-wrap items-center gap-2">
                  {exchangeRevenue && (
                    <span className="eh-chip eh-chip-muted">
                      Platform-wide · latest {exchangeRevenue.recent.length}
                    </span>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={handleRunExchangePass}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1.5 rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-3 py-1.5 text-[12px] font-bold text-white transition hover:bg-[#23262d] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy === "exchange-pass" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Run one pass now
                    </button>
                  )}
                </div>
              }
            />
            {exchangeRevenue ? (
              <>
                <ExchangeRevenueCard summary={exchangeRevenue} supply={supply} />
                <ExchangeRevenueLedger
                  recent={exchangeRevenue.recent}
                  isVolumeBasis={exchangeRevenue.policy.mode === "VOLUME_LINKED"}
                />
              </>
            ) : (
              <ReadUnavailable
                what="the exchange revenue feed"
                message={unavailable.exchangeRevenue ?? "Not read."}
              />
            )}

            <SectionHead
              title="Burn telemetry"
              description="Your recorded burns, read straight from this account's tokenomics records."
              right={<span className="eh-chip eh-chip-green">Per-account · latest 50</span>}
            />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              {unavailable.records ? (
                <ReadUnavailable
                  what="this account's tokenomics records"
                  message={unavailable.records}
                />
              ) : (
                <BurnActivityCard
                  records={records}
                  total={callerBurnTotal}
                  last24h={callerBurn24h}
                  recent={recentBurns}
                />
              )}
              <SupplyFacts supply={supply} config={config} />
            </div>

            <SectionHead
              title="Buyback & burn ledger"
              description="Recorded through the tokenomics API. Buybacks are simulated; burns are the only supply-changing entry."
              right={
                <div className="flex flex-wrap gap-1 rounded-[9px] bg-[#1a1d23] p-1">
                  {(
                    [
                      ["all", "All"],
                      ["burns", "Burns"],
                      ["buybacks", "Buybacks"],
                      ["allocations", "Allocations"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setLedgerTab(value)}
                      className={`rounded-[7px] px-3 py-1 text-[12.5px] font-semibold transition ${
                        ledgerTab === value
                          ? "bg-[#14161b] text-[#eceef2] shadow-[0_0_0_1px_#24272f]"
                          : "text-[#8a8f9b] hover:text-[#eceef2]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              }
            />
            {unavailable.records ? (
              <ReadUnavailable
                what="the buyback & burn ledger"
                message={unavailable.records}
              />
            ) : (
              <LedgerCard
                entries={visibleEntries}
                total={ledgerEntries.length}
                showActions={ledgerTab === "buybacks"}
                busy={busy}
                burnedBuybackIds={burnedBuybackIds}
                isAdmin={isAdmin}
                onRecordExecution={handleRecordExecution}
                onBurnBuyback={handleBurnBuyback}
              />
            )}

            {/* OPERATIONS */}
            <SectionHead
              title="Operations"
              description="Preview is open to every caller. Recording allocations, buybacks and burns requires PLATFORM_ADMIN."
            />

            <div className="eh-card p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8a8f9b]">
                    Comprehension only
                  </div>
                  <h3 className="text-sm font-bold text-white">Split calculator</h3>
                </div>
                <span className="text-[10px] font-mono text-[#6f7580]">
                  computed by the API · persists nothing
                </span>
              </div>

              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <label className="block">
                  <span className="text-[11px] font-mono text-[#8a8f9b]">
                    Reference amount (INR, illustrative)
                  </span>
                  <input
                    type="text"
                    value={referenceAmount}
                    onChange={(event) => setReferenceAmount(event.target.value)}
                    className="mt-1 w-full rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-3 py-2 text-sm font-mono text-white outline-none focus:border-[#ff6a1a]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-mono text-[#8a8f9b]">
                    EMBER price (INR per EMBER, illustrative)
                  </span>
                  <input
                    type="text"
                    value={emberPrice}
                    onChange={(event) => setEmberPrice(event.target.value)}
                    className="mt-1 w-full rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-3 py-2 text-sm font-mono text-white outline-none focus:border-[#ff6a1a]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void handlePreview()}
                  disabled={busy === "preview"}
                  className="inline-flex items-center justify-center gap-1.5 rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#23262d] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "preview" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CircleDollarSign className="h-3.5 w-3.5" />
                  )}
                  Preview split
                </button>
              </div>

              {preview ? (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2 rounded-[9px] border border-[#24272f] bg-[#1a1d23] p-3 text-xs lg:grid-cols-4">
                    <PreviewFact
                      label={`DIRECT BURN (${preview.directBurnPct}%)`}
                      value={`₹${fmt(preview.directBurnInr)}`}
                      sub={`${fmt(preview.directBurnEmber, 6)} EMBER`}
                      tone="text-[#ff6a1a]"
                    />
                    <PreviewFact
                      label={`SIMULATED BUYBACK (${preview.buybackPct}%)`}
                      value={`₹${fmt(preview.buybackInr)}`}
                      sub={`${fmt(preview.buybackEmber, 6)} EMBER`}
                      tone="text-[#3ddc97]"
                    />
                    <PreviewFact
                      label="REFERENCE AMOUNT"
                      value={`₹${fmt(preview.referenceAmount)}`}
                      sub={`@ ₹${fmt(preview.emberPrice)}`}
                      tone="text-white"
                    />
                    <PreviewFact
                      label="POTENTIAL BURN"
                      value={fmt(preview.potentialBurnEmber, 6)}
                      sub="EMBER if both portions burned"
                      tone="text-[#ff6a1a]"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-2xl text-[11px] text-[#8a8f9b]">
                      Illustrative only: nothing above is recorded until you press record. The direct
                      portion rounds to 2dp and the buyback takes the exact remainder, so both
                      portions always sum to the reference amount.
                    </p>
                    {isAdmin ? (
                      <button
                        type="button"
                        onClick={handleRecordAllocation}
                        disabled={busy === "allocation"}
                        className="inline-flex items-center gap-1.5 rounded-[9px] bg-[#ff6a1a] px-4 py-2 text-xs font-bold text-white shadow-[0_4px_16px_rgba(255,106,26,.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === "allocation" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        Record allocation
                      </button>
                    ) : (
                      !rolesLoading && (
                        <p className="text-[11px] text-[#8a8f9b]">
                          Recording allocations requires a PLATFORM_ADMIN role.
                        </p>
                      )
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-[#8a8f9b]">
                  Enter a reference amount and an illustrative price, then preview the split the API
                  would record. Nothing is written until you explicitly record it.
                </p>
              )}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="eh-card p-5">
                <div className="mb-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8a8f9b]">
                    Stage 1 → 2 · proposal &amp; simulation
                  </div>
                  <h3 className="text-sm font-bold text-white">Propose a simulated buyback</h3>
                </div>

                {unavailable.records ? (
                  <p className="text-xs text-[#ffb020]">
                    Your records could not be read, so no allocation can be chosen. The list is not
                    empty — it is unknown. {unavailable.records}
                  </p>
                ) : records.allocations.length === 0 ? (
                  <p className="text-xs text-[#8a8f9b]">
                    No allocations recorded yet. Record one from the split calculator above first.
                  </p>
                ) : (
                  <>
                    <label className="block">
                      <span className="text-[11px] font-mono text-[#8a8f9b]">Allocation to act on</span>
                      <select
                        value={selectedAllocationId}
                        onChange={(event) => {
                          setSelectedAllocationId(event.target.value);
                          setProposalKey(crypto.randomUUID());
                        }}
                        className="mt-1 w-full rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-3 py-2 text-xs font-mono text-white outline-none focus:border-[#ff6a1a]"
                      >
                        <option value="">Select a recorded allocation…</option>
                        {records.allocations.map((allocation) => (
                          <option key={allocation.allocationId} value={allocation.allocationId}>
                            ₹{fmt(allocation.referenceAmount)} @ ₹{fmt(allocation.emberPrice)} ·{" "}
                            {shortId(allocation.allocationId)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="mt-4 flex items-center justify-between gap-3">
                      <p className="text-[11px] text-[#8a8f9b]">
                        Proposing moves nothing: the record is a SIMULATED buyback until its
                        execution is recorded, and even then no market order exists.
                      </p>
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={handleProposeBuyback}
                          disabled={!selectedAllocationId || busy === "proposal"}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#23262d] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy === "proposal" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Plus className="h-3.5 w-3.5" />
                          )}
                          Propose buyback
                        </button>
                      ) : (
                        !rolesLoading && (
                          <p className="text-[11px] text-[#8a8f9b]">Requires PLATFORM_ADMIN.</p>
                        )
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="eh-card p-5">
                <div className="mb-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8a8f9b]">
                    The only destructive step
                  </div>
                  <h3 className="text-sm font-bold text-white">Record a direct burn</h3>
                </div>

                {isAdmin ? (
                  <>
                    <label className="block">
                      <span className="text-[11px] font-mono text-[#8a8f9b]">
                        EMBER to burn from the treasury
                      </span>
                      <input
                        type="text"
                        value={directBurnAmount}
                        onChange={(event) => setDirectBurnAmount(event.target.value)}
                        placeholder="e.g. 100"
                        className="mt-1 w-full rounded-[9px] border border-[#24272f] bg-[#1a1d23] px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-[#4a5568] focus:border-[#ff6a1a]"
                      />
                    </label>

                    <div className="mt-4 flex items-center justify-between gap-3">
                      <p className="text-[11px] text-[#8a8f9b]">
                        A burn debits the auto-provisioned treasury wallet with one BURN ledger leg
                        and writes the record in the same transaction. Supply falls exactly once; an
                        unfunded treasury is refused.
                      </p>
                      <button
                        type="button"
                        onClick={handleDirectBurn}
                        disabled={!directBurnAmount || busy === "direct-burn"}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-[9px] bg-[#ff6a1a] px-4 py-2 text-xs font-bold text-white shadow-[0_4px_16px_rgba(255,106,26,.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === "direct-burn" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Flame className="h-3.5 w-3.5" />
                        )}
                        Record burn
                      </button>
                    </div>
                  </>
                ) : (
                  !rolesLoading && (
                    <p className="text-xs text-[#8a8f9b]">
                      Burning EMBER requires a PLATFORM_ADMIN role. The ledger and records below
                      remain readable.
                    </p>
                  )
                )}
              </div>
            </div>

            {/* LIMITATIONS */}
            <div className="mt-4 space-y-1 rounded-[14px] border border-[#24272f] bg-[#14161b] p-4 text-[11px] leading-relaxed text-[#8a8f9b]">
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#6f7580]">
                Scope &amp; limitations
              </p>
              <p>
                · Reference amounts are an illustrative reference-price metric — never cash, never
                funding. Prices shown are illustrative too.
              </p>
              <p>
                · Buybacks are simulated records. Stages are proposal → SIMULATED → recorded
                simulated execution; actual market execution is deliberately not implemented, and a
                buyback without a burn changes no supply.
              </p>
              <p>
                · Burns are the only operation that destroys EMBER, and each one reduces circulating
                supply exactly once (ledger BURN legs, the token_burns record and the supply endpoint
                are reconciled).
              </p>
              <p>
                · Supply is application-level accounting, not on-chain token supply. No market price
                or USD valuation is published, so none is shown.
              </p>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

/* ------------------------------------------------------------------ */
/* Presentational pieces                                              */
/* ------------------------------------------------------------------ */

function SectionHead({
  title,
  description,
  right,
}: {
  title: string;
  description: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mt-8 mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold tracking-tight text-white">{title}</h2>
        <p className="mt-0.5 text-[13px] text-[#8a8f9b]">{description}</p>
      </div>
      {right}
    </div>
  );
}

function BurnHero({
  supply,
  config,
  loadedAt,
}: {
  supply: EmberSupply;
  config: TokenomicsConfig;
  loadedAt: number | null;
}) {
  const stats: { label: string; value: string }[] = [
    { label: "Circulating", value: fmt(supply.circulatingSupply, 0) },
    { label: "Locked", value: fmt(supply.lockedSupply, 0) },
    { label: "Available", value: fmt(supply.availableSupply, 0) },
  ];
  const noneBurned = Number(supply.burnedSupply) === 0;
  const readAt = loadedAt
    ? new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section className="eh-hero relative flex min-h-[460px] flex-col overflow-hidden rounded-[14px] border border-[#ff6a1a]/30 bg-[#08080a] text-[#f4f1ee]">
      <div className="eh-hero-heat" aria-hidden="true" />

      <div className="relative z-[1] flex flex-1 flex-col p-6">
        <div className="grid flex-1 gap-8 lg:grid-cols-[minmax(0,1fr)_210px]">
          <div className="flex min-w-0 flex-col">
            <div className="flex flex-wrap gap-2">
              <span className="eh-chip">Burning tracked on-ledger</span>
              <span className="eh-chip eh-chip-green">One BURN leg per burn</span>
              {readAt && <span className="eh-chip eh-chip-muted">Live ledger · read {readAt}</span>}
            </div>

            <div className="mt-4 text-[13px] font-medium text-[#b9a79d]">Burned forever</div>
            <div className="eh-hero-number mt-1">
              {fmt(supply.burnedSupply, 2)}
              <small> EMBER</small>
            </div>
            <div className="mt-1 text-[13px] text-[#b9a79d]">
              {noneBurned
                ? "No burns recorded yet · supply falls only when a burn commits"
                : "Removed from circulating supply · no market price is published"}
            </div>

            <div className="mt-auto grid grid-cols-1 gap-2.5 pt-10 sm:grid-cols-3">
              {stats.map((stat) => (
                <div key={stat.label} className="rounded-[10px] bg-white/[0.05] px-3 py-2.5 ring-1 ring-inset ring-white/[0.04]">
                  <span className="text-[12px] text-[#b9a79d]">{stat.label}</span>
                  <b className="mt-0.5 block text-[17px] tabular-nums text-white">{stat.value}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="eh-coin-stage" aria-hidden="true">
            <div className="eh-coin-ring" />
            <div className="eh-coin-body">
              <div className="eh-coin-face">
                <div className="eh-coin-mark">
                  <strong>E</strong>
                  <i />
                  <small>Ember Token</small>
                </div>
              </div>
            </div>
            <div className="eh-coin-shadow" />
          </div>
        </div>
      </div>

      <div className="relative z-[1] grid items-center gap-3 border-t border-white/10 bg-[rgba(8,8,10,.7)] px-6 py-4 sm:grid-cols-[1fr_auto_1.4fr]">
        <div className="rounded-[10px] bg-white/[0.05] px-3 py-2.5 text-[12.5px]">
          <span className="text-[#b9a79d]">Treasury wallet</span>
          <b className="mt-0.5 block text-sm text-white">Debited by every burn</b>
        </div>
        <div className="text-center text-xs font-bold text-[#ff8a4a]">→</div>
        <div className="grid gap-2">
          <div className="rounded-[10px] bg-[#ff6a1a]/15 px-3 py-2.5 text-[12.5px]">
            <b className="block text-sm text-white">{config.directBurnPct}% direct burn</b>
            One BURN ledger leg · supply falls once
          </div>
          <div className="rounded-[10px] bg-[#3ddc97]/10 px-3 py-2.5 text-[12.5px]">
            <b className="block text-sm text-white">{config.buybackPct}% simulated buyback</b>
            Recorded at a price · no market order
          </div>
        </div>
      </div>

      <div className="relative z-[1] flex items-center gap-2 border-t border-white/[0.06] bg-[rgba(8,8,10,.85)] px-6 py-2.5 text-[12.5px] text-[#b9a79d]">
        <Lock className="h-3.5 w-3.5" />
        Every burn is one BURN ledger leg · supply reconciles exactly
      </div>
    </section>
  );
}

function UtilityRail({ config }: { config: TokenomicsConfig }) {
  const items = [
    {
      icon: <Flame className="h-3.5 w-3.5" />,
      lead: "DIRECT BURN",
      title: `${config.directBurnPct}% of the reference amount`,
      sub: "Debited from the treasury, supply falls once",
    },
    {
      icon: <CircleDollarSign className="h-3.5 w-3.5" />,
      lead: "SIMULATED BUYBACK",
      title: `${config.buybackPct}% of the reference amount`,
      sub: "Execution recorded at a price, never placed",
    },
    {
      icon: <Database className="h-3.5 w-3.5" />,
      lead: "LEDGER SUPPLY",
      title: "Circulating = issued − burned",
      sub: "Reconciled against BURN legs",
    },
    {
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      lead: "ADMIN-GATED WRITES",
      title: "PLATFORM_ADMIN",
      sub: "Preview stays open to every caller",
    },
  ];

  return (
    <section className="mt-8">
      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#ff6a1a]">
          EMBER utility
        </div>
        <h2 className="mt-1 text-lg font-bold text-white">What the split actually does</h2>
        <p className="mt-1 text-[13px] text-[#8a8f9b]">
          One token, two configured destinations — each recorded by the API, none invented here.
        </p>
      </div>

      <div className="grid grid-cols-1 border-y border-[#24272f] py-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item, index) => (
          <div
            key={item.lead}
            className={`min-w-0 px-4 py-2 ${
              index > 0 ? "lg:border-l lg:border-[#24272f]" : ""
            } ${index > 0 ? "sm:border-[#24272f] sm:border-t sm:pt-4 lg:border-t-0 lg:pt-2" : ""}`}
          >
            <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[#8a8f9b]">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[#ff6a1a]/10 text-[#ff6a1a]">
                {item.icon}
              </span>
              {item.lead}
            </div>
            <b className="mt-3 block text-sm tracking-[-0.01em] text-white">{item.title}</b>
            <small className="text-[11px] text-[#8a8f9b]">{item.sub}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function SupplyTiles({ supply }: { supply: EmberSupply }) {
  const total = Number(supply.totalIssuedSupply);
  const tiles = [
    {
      tag: "Ledger-derived",
      label: "Total issued",
      value: supply.totalIssuedSupply,
      note: "Application accounting · not on-chain supply",
      tone: "text-[#8a8f9b]",
    },
    {
      tag: `${pctOf(supply.circulatingSupply, total).toFixed(2)}% of issued`,
      label: "Circulating",
      value: supply.circulatingSupply,
      note: "Issued − burned",
      tone: "text-[#8a8f9b]",
    },
    {
      tag: `${pctOf(supply.lockedSupply, total).toFixed(2)}% of issued`,
      label: "Locked",
      value: supply.lockedSupply,
      note: "LP commitments and vault locks · still circulating",
      tone: "text-[#ffb020]",
    },
    {
      tag: "Deflationary",
      label: "Burned to date",
      value: supply.burnedSupply,
      note: "Destroyed forever · one BURN leg per burn",
      tone: "text-[#ff6a1a]",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="eh-tile rounded-[14px] border border-[#24272f] bg-[#14161b] p-4">
          <span className={`float-right rounded-full bg-[#1a1d23] px-2 py-0.5 text-[11px] font-bold ${tile.tone}`}>
            {tile.tag}
          </span>
          <span className="text-[12.5px] text-[#8a8f9b]">{tile.label}</span>
          <b className="mt-1 block text-xl font-extrabold tracking-[-0.01em] text-white">
            {fmt(tile.value, 0)} <small className="text-xs font-bold text-[#8a8f9b]">EMBER</small>
          </b>
          <span className="text-[12.5px] text-[#8a8f9b]">{tile.note}</span>
        </div>
      ))}
    </div>
  );
}

interface DonutSegment {
  key: string;
  label: string;
  value: string;
  color: string;
  start: number;
  end: number;
}

function segmentsFor(supply: EmberSupply): { segments: DonutSegment[]; total: number } {
  const total = Number(supply.totalIssuedSupply);
  const raw = [
    { key: "burned", label: "Burned", value: supply.burnedSupply, color: "#ff6a1a" },
    { key: "locked", label: "Locked", value: supply.lockedSupply, color: "#ffb020" },
    { key: "available", label: "Available", value: supply.availableSupply, color: "#5b8cff" },
  ];

  let cursor = 0;
  const segments = raw.map((segment) => {
    const pct = pctOf(segment.value, total);
    const start = cursor;
    cursor += pct;
    return { ...segment, start, end: cursor };
  });

  return { segments, total };
}

function SupplyDonut({
  supply,
  active,
  onActivate,
}: {
  supply: EmberSupply;
  active: number | null;
  onActivate: (index: number | null) => void;
}) {
  const { segments, total } = segmentsFor(supply);
  const selected = active !== null ? segments[active] : null;

  return (
    <div
      className={`relative mx-auto flex aspect-square w-[min(280px,100%)] items-center justify-center ${
        active !== null ? "eh-has-hover" : ""
      }`}
    >
      <svg viewBox="0 0 300 300" className="block h-full w-full overflow-visible">
        <circle cx={DONUT_CENTER} cy={DONUT_CENTER} r={95} fill="none" stroke="#1a1d23" strokeWidth={40} />
        {segments.map((segment, index) => {
          if (segment.end - segment.start <= 0.2) return null;
          const mid = -90 + ((segment.start + segment.end) / 2) * 3.6;
          const offset = active === index ? 9 : 0;
          const tx = Math.cos((mid * Math.PI) / 180) * offset;
          const ty = Math.sin((mid * Math.PI) / 180) * offset;

          return (
            <path
              key={segment.key}
              d={donutPath(segment.start, segment.end)}
              fill={segment.color}
              stroke="rgba(0,0,0,.4)"
              strokeWidth={1.2}
              className="eh-slice"
              style={{
                transformOrigin: "150px 150px",
                transform: `translate(${tx}px, ${ty}px)${active === index ? " scale(1.04)" : ""}`,
                opacity: active !== null && active !== index ? 0.32 : 1,
              }}
              onMouseEnter={() => onActivate(index)}
              onMouseLeave={() => onActivate(null)}
              onClick={() => onActivate(index)}
            />
          );
        })}
      </svg>

      <div className="pointer-events-none absolute flex h-[132px] w-[132px] flex-col items-center justify-center rounded-full border border-white/10 bg-[radial-gradient(circle,rgba(255,255,255,.04)_0%,rgba(16,18,22,.9)_75%)] px-2 text-center shadow-[0_4px_24px_rgba(0,0,0,.45)] backdrop-blur">
        <div
          className="max-w-[116px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={{
            color: selected?.color ?? "#8a8f9b",
            background: selected ? `${selected.color}22` : "rgba(255,255,255,.06)",
          }}
        >
          {selected ? selected.label : "Total issued"}
        </div>
        <div className="my-0.5 text-2xl font-extrabold leading-tight tracking-[-0.025em] text-white">
          {selected ? compactEmber(selected.value) : compactEmber(supply.totalIssuedSupply)}
        </div>
        <div className="text-[10.5px] leading-tight text-[#8a8f9b]">
          {selected
            ? `${pctOf(selected.value, total).toFixed(2)}% · ${fmt(selected.value, 2)} EMBER`
            : "Ledger-derived"}
        </div>
      </div>
    </div>
  );
}

function SupplyLegend({
  supply,
  active,
  onActivate,
}: {
  supply: EmberSupply;
  active: number | null;
  onActivate: (index: number | null) => void;
}) {
  const { segments, total } = segmentsFor(supply);

  return (
    <div className="grid content-start gap-2.5">
      {segments.map((segment, index) => (
        <button
          key={segment.key}
          type="button"
          onMouseEnter={() => onActivate(index)}
          onMouseLeave={() => onActivate(null)}
          onFocus={() => onActivate(index)}
          onBlur={() => onActivate(null)}
          onClick={() => onActivate(index)}
          className="rounded-xl border bg-[#1a1d23] px-3.5 py-3 text-left transition hover:-translate-y-0.5 hover:bg-[#14161b]"
          style={{
            borderColor: active === index ? segment.color : "transparent",
            boxShadow: active === index ? `0 6px 20px rgba(0,0,0,.22), 0 0 14px ${segment.color}33` : undefined,
          }}
        >
          <span className="flex items-center gap-2 text-[12.5px] text-[#8a8f9b]">
            <span
              className="h-2.5 w-2.5 rounded-[3px]"
              style={{ background: segment.color, boxShadow: `0 0 8px ${segment.color}` }}
            />
            {segment.label}
          </span>
          <b className="mt-0.5 block text-[17px] text-white">{fmt(segment.value, 0)}</b>
          <small className="text-xs text-[#8a8f9b]">
            {pctOf(segment.value, total).toFixed(2)}% of issued · {fmt(segment.value, 2)} EMBER
          </small>
        </button>
      ))}
    </div>
  );
}

function BurnActivityCard({
  records,
  total,
  last24h,
  recent,
}: {
  records: TokenomicsRecords;
  total: string;
  last24h: string;
  recent: TokenomicsRecords["burns"];
}) {
  const latest = records.burns[0];
  const max = Math.max(...recent.map((burn) => Number(burn.amount)), 1);

  return (
    <section className="eh-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-[12.5px] text-[#8a8f9b]">Your recorded burns</span>
        <span className="text-[12.5px] text-[#8a8f9b]">
          {records.burns.length} record{records.burns.length === 1 ? "" : "s"} · latest 50
        </span>
      </div>

      <div className="eh-velocity mt-1 text-[26px] font-bold text-[#ff6a1a]">
        {fmt(total, 2)} <small className="text-sm font-semibold text-[#8a8f9b]">EMBER burned</small>
      </div>

      <div className="mt-3 h-[90px]">
        {recent.length === 0 ? (
          <div className="grid h-full place-items-center rounded-[10px] border border-dashed border-[#2c3038] text-[11px] text-[#8a8f9b]">
            No burns recorded by this account yet.
          </div>
        ) : (
          <svg viewBox="0 0 300 90" preserveAspectRatio="none" className="block h-full w-full">
            {recent.map((burn, index) => {
              const width = 300 / Math.max(recent.length, 1);
              const height = Math.max(6, (Number(burn.amount) / max) * 76);
              return (
                <rect
                  key={burn.burnId}
                  x={index * width + width * 0.2}
                  y={90 - height}
                  width={width * 0.6}
                  height={height}
                  rx={3}
                  fill="#ff6a1a"
                  opacity={0.35 + (index / Math.max(recent.length, 1)) * 0.6}
                />
              );
            })}
          </svg>
        )}
      </div>
      <div className="text-[12.5px] text-[#8a8f9b]">Newest burn on the right</div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <FactRow label="Last 24 h" value={`${fmt(last24h, 2)} EMBER`} />
        <FactRow
          label="Last burn"
          value={latest ? `${fmt(latest.amount, 2)} · ${timeAgo(latest.burnedAt)}` : "—"}
        />
      </div>
    </section>
  );
}

function SupplyFacts({ supply, config }: { supply: EmberSupply; config: TokenomicsConfig }) {
  return (
    <section className="eh-card p-5">
      <div className="grid gap-2.5 text-[13px]">
        <FactRow label="Total issued" value={`${fmt(supply.totalIssuedSupply, 2)} EMBER`} />
        <FactRow label="Burned forever" value={`${fmt(supply.burnedSupply, 2)} EMBER`} />
        <FactRow label="Circulating" value={`${fmt(supply.circulatingSupply, 2)} EMBER`} />
        <FactRow label="Locked" value={`${fmt(supply.lockedSupply, 2)} EMBER`} />
        <FactRow label="Available" value={`${fmt(supply.availableSupply, 2)} EMBER`} />
        <FactRow label="Configured split" value={`${config.directBurnPct} / ${config.buybackPct}`} />
      </div>
      <p className="mt-3 text-[11px] text-[#8a8f9b]">
        Circulating = issued − burned. Available = circulating − locked. All five figures come from
        GET /ember/supply in one read.
      </p>
    </section>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] bg-[#1a1d23] px-3 py-2.5">
      <span className="text-[#8a8f9b]">{label}</span>
      <b className="text-right font-bold text-white">{value}</b>
    </div>
  );
}

/**
 * A section whose own read failed, while the rest of the page loaded.
 *
 * The alternative was to blank the whole page, which reports a two-second
 * backend restart as though the tokenomics data did not exist. Here the number
 * is replaced by an explicit "not read", so an empty figure can never be
 * mistaken for a zero: a burn total that was never fetched and a burn total of
 * zero have to look different on screen.
 */
function ReadUnavailable({ what, message }: { what: string; message: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-[#2c3038] p-6">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#ffb020]" />
        <div>
          <p className="text-xs font-semibold text-[#eceef2]">
            {what.charAt(0).toUpperCase() + what.slice(1)} not loaded
          </p>
          <p className="mt-1 text-[11px] text-[#8a8f9b]">
            This section was not read, so it shows nothing rather than zero. The rest of the page is
            unaffected.
          </p>
          <p className="mt-2 font-mono text-[11px] text-[#ffb020]">{message}</p>
          <p className="mt-2 text-[11px] text-[#8a8f9b]">
            A reload once the API is back is all this needs.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * MODULE 08 x MODULE 11 — how each outbox status is described to a reader.
 * The set is the backend's `ExchangeRevenueStatus`; nothing here invents one.
 */
const EXCHANGE_STATUS_ORDER = [
  "COMPLETED",
  "PENDING",
  "PROCESSING",
  "BLOCKED",
  "FAILED",
  "INELIGIBLE",
] as const;

const EXCHANGE_STATUS_TONE: Record<string, string> = {
  COMPLETED: "bg-[#3ddc97]/10 text-[#3ddc97]",
  PENDING: "bg-[#8a8f9b]/10 text-[#c5cfde]",
  PROCESSING: "bg-[#ff6a1a]/10 text-[#ff6a1a]",
  BLOCKED: "bg-[#ffb020]/10 text-[#ffb020]",
  FAILED: "bg-[#ffb020]/10 text-[#ffb020]",
  INELIGIBLE: "bg-[#5b8cff]/10 text-[#5b8cff]",
};

const EXCHANGE_STATUS_HINT: Record<string, string> = {
  COMPLETED: "allocation, buyback, execution and both burns recorded",
  PENDING: "revenue attributed, waiting for the next worker tick",
  PROCESSING: "claimed by one pass right now",
  BLOCKED: "a treasury guardrail refused the burn — retryable, never bypassed",
  FAILED: "a non-guardrail failure outlived the retry budget",
  INELIGIBLE: "the revenue policy attributed no INR, so nothing was queued",
};

/**
 * Each on-chain state is labelled with what it proves. `NOT_REQUIRED` is the
 * blockchain layer being switched off, so that EMBER left circulation on the
 * ledger and no chain transaction exists — the page must not blur the two.
 */
const BURN_STATE_LABEL: Record<string, string> = {
  NOT_REQUIRED: "Ledger only · blockchain layer off",
  PENDING: "Chain submission pending",
  SUBMITTED: "Submitted · awaiting confirmation",
  CONFIRMED: "Confirmed on Sepolia",
  FAILED: "Chain call failed",
};

const BURN_STATE_ORDER = ["CONFIRMED", "SUBMITTED", "PENDING", "NOT_REQUIRED", "FAILED"] as const;

/** Sum across on-chain states. Used only to label the total, never the states. */
function sumByChainState(byChainState: Record<string, string>): string {
  return Object.values(byChainState).reduce(
    (total, amount) => addDecimalStrings(total, amount),
    "0",
  );
}

/**
 * A zero has several causes and they mean different things to different people.
 * The sentence is built only from the policy and totals the API returned, so the
 * page explains the number instead of guessing at it.
 */
function explainExchangeRevenue(
  totals: ExchangeRevenueSummary["totals"],
  policy: ExchangeRevenueSummary["policy"],
): string {
  if (totals.ordersSeen === 0) {
    return "Nothing here yet: no settled USDT buy order has been put to the revenue policy. The queue is written inside the settlement transaction itself, so it records from the moment the bridge is deployed and does not backfill orders settled before it — a row written outside the transaction that moved the money would be a later judgement about the order, not a fact of it. A buy that failed, was refused or rolled back never reaches this queue at all, which is why an order you did not complete leaves no record.";
  }

  if (policy.mode === "VOLUME_LINKED") {
    if (Number(totals.basisInr) === 0) {
      return `${totals.ordersSeen} settled order${totals.ordersSeen === 1 ? "" : "s"} reached the policy and none contributed a rupee of volume it could be sized against, so nothing was queued.`;
    }
    return `Volume-linked mode: ₹${fmt(totals.basisInr)} of traded volume across ${totals.ordersSeen} settled order${totals.ordersSeen === 1 ? "" : "s"} sized the engine, and ₹${fmt(totals.revenueInr)} of it was revenue. That is not a contradiction — the rupees were never moved. Converting the volume to EMBER at the reference price gives the quantity the policy takes out of circulation, ${policy.baselineDirectBurnPct}/${policy.baselineBuybackPct} direct-burn to buyback at the baseline, and the EMBER itself comes out of the treasury's own inventory under the same reserve floor as any other burn. No fee was added to any order and nothing was deducted from a customer or a liquidity provider.`;
  }

  if (Number(totals.revenueInr) > 0) {
    return `The policy attributed ₹${fmt(totals.revenueInr)} of the ₹${fmt(totals.retainedInr)} margin that ${totals.ordersSeen} settled order${totals.ordersSeen === 1 ? "" : "s"} left after liquidity providers were paid. Those rupees buy EMBER at the reference price and are split by the adaptive policy — the ${policy.baselineDirectBurnPct}/${policy.baselineBuybackPct} baseline is what a healthy treasury applies.`;
  }

  if (policy.mode === "NONE") {
    return "The revenue policy is switched off (TOKENOMICS_EXCHANGE_REVENUE_MODE=NONE — the shipped default). Every settled order is recorded with its reason and nothing is queued, so the exchange cannot fund a burn until the business sets a revenue mode and a rate.";
  }

  if (Number(totals.retainedInr) === 0) {
    return `${totals.ordersSeen} settled order${totals.ordersSeen === 1 ? "" : "s"} reached the policy and every one retained ₹0.00: the settlement pays the customer's INR out to liquidity providers to the paisa, so the platform keeps nothing to burn. That is the exchange's real economics today, not a switch — charging a fee or widening a spread is the business decision that would change it.`;
  }

  return "A margin exists, but the configured rate attributes no whole paisa of it, so no order cleared the rupee scale the engine records at.";
}

/**
 * MODULE 08 x MODULE 11 — the exchange's contribution to the burn engine: the
 * policy that decided the figures, the rupees a settlement actually left behind,
 * what the allocations promised from them, and what has been destroyed.
 *
 * The blocks stay apart on purpose. Customer principal is not revenue, an
 * allocation is not a burn, and a ledger burn is not a chain confirmation — one
 * merged figure would let the page make all three claims at once.
 *
 * "Attributed" and "sized the engine" are also kept apart, and they only differ
 * under VOLUME_LINKED: there the engine is measured against traded volume while
 * the platform's income stays ₹0.00. Showing one number for both would turn
 * turnover into revenue on the dashboard, which is the exact claim the backend
 * split the columns to stop.
 */
function ExchangeRevenueCard({
  summary,
  supply,
}: {
  summary: ExchangeRevenueSummary;
  supply: EmberSupply;
}) {
  const { policy, totals, byStatus } = summary;
  const isVolumeBasis = policy.mode === "VOLUME_LINKED";
  const backlog = EXCHANGE_STATUS_ORDER.filter(
    (state) => state !== "COMPLETED" && state !== "INELIGIBLE",
  ).reduce((sum, state) => sum + (byStatus[state]?.count ?? 0), 0);
  const burnedStates = BURN_STATE_ORDER.filter(
    (state) => totals.burnedEmberByChainState[state] !== undefined,
  );

  return (
    <section className="eh-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8a8f9b]">
            {isVolumeBasis ? "Settled USDT orders" : "Settled USDT buy orders"}
          </div>
          <div className="mt-1 text-sm font-bold text-white">
            {totals.ordersSeen} order{totals.ordersSeen === 1 ? "" : "s"} considered ·{" "}
            {totals.eligibleOrders} funded tokenomics · {totals.allocationsRecorded} allocation
            {totals.allocationsRecorded === 1 ? "" : "s"} recorded
          </div>
        </div>
        <span className="eh-chip eh-chip-muted">GET /tokenomics/exchange-revenue · platform-wide</span>
      </div>

      <p className="mt-3 rounded-[10px] border border-[#24272f] bg-[#1a1d23] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#c5cfde]">
        {explainExchangeRevenue(totals, policy)}
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#8a8f9b]">
            Rupees behind the orders
          </h3>
          <div className="mt-2 grid gap-2 text-[13px]">
            <FactRow label="Customers paid" value={`₹${fmt(totals.customerInr)}`} />
            <FactRow label="Left as platform margin" value={`₹${fmt(totals.retainedInr)}`} />
            <FactRow label="Claimed as revenue" value={`₹${fmt(totals.revenueInr)}`} />
            <FactRow
              label={isVolumeBasis ? "Traded volume sized the engine" : "Revenue-sized engine"}
              value={`₹${fmt(totals.basisInr)}`}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[#6f7580]">
            {isVolumeBasis ? (
              <>
                The engine is measured against volume, and volume is not income — the revenue line
                above is the true ₹0.00, not a rounding. No rupee moved because of it: the same
                settlement credited the same LPs and charged the customer the same quote, and the
                EMBER this sizing destroys comes from the treasury&apos;s own holdings.
              </>
            ) : (
              <>
                Revenue is the margin a settlement leaves after every counterparty has been paid —
                never the purchase amount. Customer principal and LP funds cannot reach the burn
                engine by this path; each order&apos;s LP credit is listed per row below.
              </>
            )}
          </p>
        </div>

        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#8a8f9b]">
            What the allocations promised
          </h3>
          <div className="mt-2 grid gap-2 text-[13px]">
            <FactRow label="Reference amount allocated" value={`₹${fmt(totals.allocatedReferenceInr)}`} />
            <FactRow
              label="Direct-burn share"
              value={`${fmt(totals.allocatedDirectBurnEmber, 4)} EMBER`}
            />
            <FactRow
              label="Simulated buyback share"
              value={`${fmt(totals.allocatedBuybackEmber, 4)} EMBER`}
            />
            <FactRow
              label="EMBER actually destroyed"
              value={`${fmt(sumByChainState(totals.burnedEmberByChainState), 4)} EMBER`}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[#6f7580]">
            Promised and destroyed are different numbers for as long as burns are blocked or queued.
            An allocation destroys nothing; only a burn does.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#8a8f9b]">
            Engine backlog
          </h3>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
              backlog === 0 ? "bg-[#3ddc97]/10 text-[#3ddc97]" : "bg-[#ffb020]/10 text-[#ffb020]"
            }`}
          >
            {backlog === 0 ? "Nothing waiting" : `${backlog} waiting`}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {EXCHANGE_STATUS_ORDER.map((state) => {
            const block = byStatus[state];
            if (!block) return null;
            return (
              <div
                key={state}
                title={EXCHANGE_STATUS_HINT[state]}
                className={`min-w-[150px] flex-1 rounded-[10px] px-3 py-2.5 ${EXCHANGE_STATUS_TONE[state]}`}
              >
                <div className="text-[10px] font-extrabold uppercase tracking-[0.12em]">{state}</div>
                <div className="mt-0.5 text-sm font-bold tabular-nums">
                  {block.count} order{block.count === 1 ? "" : "s"}
                </div>
                <div className="text-[11px] opacity-80">
                  {isVolumeBasis
                    ? `₹${fmt(block.basisInr)} sized`
                    : `₹${fmt(block.revenueInr)} attributed`}
                </div>
              </div>
            );
          })}
          {EXCHANGE_STATUS_ORDER.every((state) => !byStatus[state]) && (
            <div className="grid w-full place-items-center rounded-[10px] border border-dashed border-[#2c3038] p-6 text-[11px] text-[#8a8f9b]">
              No settled USDT order has been put to the revenue policy yet.
            </div>
          )}
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#8a8f9b]">
          Engine burns by on-chain state
        </h3>
        <div className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
          {burnedStates.map((state) => (
            <FactRow
              key={state}
              label={BURN_STATE_LABEL[state]}
              value={`${fmt(totals.burnedEmberByChainState[state] ?? "0", 4)} EMBER`}
            />
          ))}
          {burnedStates.length === 0 && (
            <div className="grid place-items-center rounded-[10px] border border-dashed border-[#2c3038] p-5 text-[11px] text-[#8a8f9b] sm:col-span-2">
              The engine has recorded no burns yet.
            </div>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[#6f7580]">
          Whole-platform burn is {fmt(supply.burnedSupply, 4)} EMBER and circulating supply is{" "}
          {fmt(supply.circulatingSupply, 2)} EMBER, both from GET /ember/supply — those count every
          BURN leg in the ledger, not only this engine&apos;s.
        </p>
      </div>

      <div className="mt-5 grid gap-2 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
        <PolicyFact
          label="Sizing mode"
          value={
            policy.mode === "NONE"
              ? "Switched off"
              : policy.mode === "VOLUME_LINKED"
                ? "Traded volume"
                : `${policy.bps} bps of retained margin`
          }
          sub={
            policy.mode === "VOLUME_LINKED"
              ? "treasury-funded, no fee charged"
              : policy.mode === "NONE"
                ? undefined
                : "revenue basis"
          }
        />
        <PolicyFact
          label="Baseline split"
          value={`${policy.baselineDirectBurnPct} / ${policy.baselineBuybackPct}`}
          sub={policy.splitIsAdaptive ? "adaptive to treasury health" : "fixed"}
        />
        <PolicyFact label="Reference EMBER price" value={`₹${fmt(policy.emberPrice)} per EMBER`} />
        <PolicyFact
          label="Background worker"
          value={policy.workerEnabled ? "Running" : "Not running"}
          sub={policy.workerEnabled ? "drains the queue on its tick" : "an admin pass is required"}
        />
      </div>
    </section>
  );
}

function PolicyFact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[10px] bg-[#1a1d23] px-3 py-2.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#8a8f9b]">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-white">{value}</div>
      {sub && <div className="text-[10.5px] text-[#6f7580]">{sub}</div>}
    </div>
  );
}

function ExchangeBurnCell({ burn }: { burn: ExchangeRevenueBurnRef | null }) {
  if (!burn) {
    return <span className="text-[#6f7580]">—</span>;
  }

  return (
    <span
      title={`${BURN_STATE_LABEL[burn.onChainStatus] ?? burn.onChainStatus}${burn.onChainTxHash ? ` · ${burn.onChainTxHash}` : ""}`}
    >
      {fmt(burn.amount, 4)}
      <span className="ml-1 text-[10px] text-[#6f7580]">
        {burn.onChainStatus === "CONFIRMED" ? "on-chain" : "ledger"}
      </span>
    </span>
  );
}

/**
 * One row per settled order the engine was asked to consider, keyed by its
 * source USDT order id. A SELL and an unattributed BUY appear here as refusals
 * with their reason; they never appear as allocations.
 *
 * Under a volume basis every row's revenue is ₹0.00 by design, so the last money
 * column switches to the figure the row was actually sized against — with the
 * revenue still one hover away, because the two must never be merged into one
 * number that could be read either way.
 */
function ExchangeRevenueLedger({
  recent,
  isVolumeBasis,
}: {
  recent: ExchangeRevenueEventRecord[];
  isVolumeBasis: boolean;
}) {
  return (
    <section className="eh-card mt-4 overflow-hidden px-3.5 py-2">
      {recent.length === 0 ? (
        <div className="grid place-items-center rounded-[10px] border border-dashed border-[#2c3038] p-8 text-xs text-[#8a8f9b]">
          No settled USDT order has reached the revenue policy yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-left">
            <thead>
              <tr>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Source order</th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Settled</th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Side</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">Paid</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">To LPs</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">Retained</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">
                  {isVolumeBasis ? "Sized on" : "Attributed"}
                </th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">
                  Split applied
                </th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">
                  Direct burn
                </th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">
                  Buyback burn
                </th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Buyback record</th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((event) => (
                <tr key={event.eventId} className="border-t border-[#24272f]">
                  <td className="px-2 py-3 font-mono text-[11.5px] text-[#8a8f9b]">
                    <span title={`USDT order ${event.orderId}`}>{shortId(event.orderId)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-[12.5px] text-[#8a8f9b]">
                    <span title={formatTimestamp(event.detectedAt)}>
                      {timeAgo(event.detectedAt)}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-[12.5px] font-bold text-white">{event.side}</td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#a6b2c4]">
                    ₹{fmt(event.customerInr)}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#a6b2c4]">
                    ₹{fmt(event.lpInrSettled)}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#a6b2c4]">
                    ₹{fmt(event.retainedInr)}
                  </td>
                  <td
                    className="px-2 py-3 text-right font-mono text-[12.5px] font-bold text-white"
                    title={
                      isVolumeBasis
                        ? `Sized on ₹${fmt(event.basisInr)} of volume; ₹${fmt(event.revenueInr)} claimed as revenue`
                        : `₹${fmt(event.revenueInr)} attributed from ₹${fmt(event.retainedInr)} retained margin`
                    }
                  >
                    ₹{fmt(isVolumeBasis ? event.basisInr : event.revenueInr)}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#a6b2c4]">
                    {event.allocation
                      ? `${event.allocation.directBurnPct} / ${event.allocation.buybackPct}`
                      : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#ff6a1a]">
                    <ExchangeBurnCell burn={event.directBurn} />
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#a6b2c4]">
                    <ExchangeBurnCell burn={event.buybackBurn} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-[11.5px] text-[#8a8f9b]">
                    {event.buybackStatus ? (
                      <span title={event.buybackId ?? undefined}>
                        {event.buybackStatus === "RECORDED_SIMULATED_EXECUTION"
                          ? "execution recorded · simulated"
                          : "proposed · simulated"}
                        {event.buybackExecutedEmber
                          ? ` · ${fmt(event.buybackExecutedEmber, 4)} EMBER`
                          : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${EXCHANGE_STATUS_TONE[event.status] ?? "bg-[#1a1d23] text-[#c5cfde]"}`}
                      title={event.detail ?? event.reasonCode}
                    >
                      {event.status} · {event.reasonCode}
                    </span>
                    {event.status !== "COMPLETED" && event.status !== "INELIGIBLE" && (
                      <span className="ml-2 font-mono text-[10.5px] text-[#6f7580]">
                        attempt {event.attempts}/{event.maxAttempts}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="px-2 py-2 text-[12.5px] text-[#8a8f9b]">
        Newest first · the split column is what the adaptive policy applied to this order, which the
        configured baseline is overridden by as treasury health changes. Buybacks are recorded
        simulations — no EMBER was bought from a market.
      </p>
    </section>
  );
}

interface LedgerEntry {
  id: string;
  at: string;
  kind: "burn" | "buyback" | "allocation";
  label: string;
  ember: string | null;
  inr: string | null;
  status: string;
  buyback?: TokenomicsRecords["buybacks"][number];
}

function LedgerCard({
  entries,
  total,
  showActions,
  busy,
  burnedBuybackIds,
  isAdmin,
  onRecordExecution,
  onBurnBuyback,
}: {
  entries: LedgerEntry[];
  total: number;
  showActions: boolean;
  busy: string | null;
  burnedBuybackIds: Set<string>;
  isAdmin: boolean;
  onRecordExecution: (buybackId: string, executedPrice: string) => void;
  onBurnBuyback: (buybackId: string) => void;
}) {
  return (
    <section className="eh-card overflow-hidden px-3.5 py-2">
      {entries.length === 0 ? (
        <div className="grid place-items-center rounded-[10px] border border-dashed border-[#2c3038] p-8 text-xs text-[#8a8f9b]">
          No records in this view yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Time</th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Event</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">EMBER</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-[#8a8f9b]">
                  Reference
                </th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Record</th>
                <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Status</th>
                {showActions && (
                  <th className="px-2 py-2 text-xs font-medium text-[#8a8f9b]">Action</th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.kind}-${entry.id}`} className="border-t border-[#24272f]">
                  <td className="whitespace-nowrap px-2 py-3 text-[12.5px] text-[#8a8f9b]">
                    <span title={formatTimestamp(entry.at)}>{timeAgo(entry.at)}</span>
                  </td>
                  <td className="px-2 py-3 text-[13px] text-white">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={`grid h-7 w-7 place-items-center rounded-lg ${
                          entry.kind === "burn"
                            ? "bg-[#ff6a1a]/10 text-[#ff6a1a]"
                            : entry.kind === "buyback"
                              ? "bg-[#3ddc97]/10 text-[#3ddc97]"
                              : "bg-[#5b8cff]/10 text-[#5b8cff]"
                        }`}
                      >
                        {entry.kind === "burn" ? (
                          <Flame className="h-3.5 w-3.5" />
                        ) : entry.kind === "buyback" ? (
                          <CircleDollarSign className="h-3.5 w-3.5" />
                        ) : (
                          <Database className="h-3.5 w-3.5" />
                        )}
                      </span>
                      {entry.label}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] font-bold text-white">
                    {entry.ember ? fmt(entry.ember, 6) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[12.5px] text-[#a6b2c4]">
                    {entry.inr ? `₹${fmt(entry.inr)}` : "—"}
                  </td>
                  <td className="px-2 py-3 font-mono text-[11.5px] text-[#8a8f9b]">
                    {shortId(entry.id)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                        entry.kind === "burn"
                          ? "bg-[#ff6a1a]/10 text-[#ff6a1a]"
                          : entry.kind === "buyback"
                            ? "bg-[#3ddc97]/10 text-[#3ddc97]"
                            : "bg-[#5b8cff]/10 text-[#5b8cff]"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  {showActions && (
                    <td className="px-2 py-3">
                      {entry.buyback ? (
                        <BuybackActions
                          buyback={entry.buyback}
                          busy={busy}
                          isBurned={burnedBuybackIds.has(entry.buyback.buybackId)}
                          isAdmin={isAdmin}
                          onRecordExecution={onRecordExecution}
                          onBurnBuyback={onBurnBuyback}
                        />
                      ) : (
                        <span className="text-[10px] font-mono text-[#6f7580]">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="px-2 py-2 text-[12.5px] text-[#8a8f9b]">
        Showing {entries.length} of {total} record{total === 1 ? "" : "s"} · per-account, newest
        first
      </p>
    </section>
  );
}

function PreviewFact({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono text-[#8a8f9b]">{label}</div>
      <div className={`mt-0.5 font-mono font-bold ${tone}`}>{value}</div>
      <div className="text-[10px] font-mono text-[#8a8f9b]">{sub}</div>
    </div>
  );
}

function BuybackActions({
  buyback,
  busy,
  isBurned,
  isAdmin,
  onRecordExecution,
  onBurnBuyback,
}: {
  buyback: TokenomicsRecords["buybacks"][number];
  busy: string | null;
  isBurned: boolean;
  isAdmin: boolean;
  onRecordExecution: (buybackId: string, executedPrice: string) => void;
  onBurnBuyback: (buybackId: string) => void;
}) {
  const [price, setPrice] = useState("");
  const actionBusy = busy === `execute:${buyback.buybackId}` || busy === `burn:${buyback.buybackId}`;

  if (!isAdmin) {
    return (
      <span className="text-[10px] font-mono text-[#6f7580]">
        {buyback.status === "SIMULATED" ? "Requires PLATFORM_ADMIN" : "—"}
      </span>
    );
  }

  if (buyback.status === "SIMULATED") {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="₹ price"
          aria-label={`Execution price for buyback ${buyback.buybackId}`}
          className="w-20 rounded border border-[#24272f] bg-[#1a1d23] px-2 py-1 text-[11px] font-mono text-white outline-none placeholder:text-[#4a5568] focus:border-[#ff6a1a]"
        />
        <button
          type="button"
          onClick={() => onRecordExecution(buyback.buybackId, price)}
          disabled={!price || actionBusy}
          className="flex items-center gap-1 rounded border border-[#24272f] bg-[#1a1d23] px-2 py-1 text-[10px] font-bold text-white transition hover:bg-[#23262d] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {actionBusy && <Loader2 className="h-3 w-3 animate-spin" />}
          Record execution
        </button>
      </div>
    );
  }

  if (isBurned) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-mono font-bold text-[#ff6a1a]">
        <Flame className="h-3 w-3" />
        BURNED
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onBurnBuyback(buyback.buybackId)}
      disabled={actionBusy}
      className="flex items-center gap-1 rounded border border-[#ff6a1a]/40 bg-[#ff6a1a]/15 px-2 py-1 text-[10px] font-bold text-[#ff6a1a] transition hover:bg-[#ff6a1a]/25 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {actionBusy && <Loader2 className="h-3 w-3 animate-spin" />}
      <Flame className="h-3 w-3" />
      Burn this buyback
    </button>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center rounded-[14px] border border-[#24272f] bg-[#14161b] p-16">
      <div className="flex items-center gap-3 font-mono text-sm text-[#8a8f9b]">
        <Loader2 className="h-4 w-4 animate-spin text-[#ff6a1a]" />
        <span>Loading tokenomics records and supply…</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page-scoped styles for the molten hero                             */
/* ------------------------------------------------------------------ */

const EMBER_PAGE_CSS = `
.eh-hero { box-shadow: 0 24px 70px -34px rgba(255,90,20,.55), inset 0 2px 0 rgba(255,255,255,.02); }
.eh-hero-heat {
  position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 2;
  background:
    linear-gradient(180deg, rgba(255,120,40,.10), transparent 26%, transparent 74%, rgba(255,90,20,.07)),
    radial-gradient(120% 62% at 50% 118%, rgba(255,106,26,.16), transparent 62%);
  animation: eh-heat 5.2s ease-in-out infinite; mix-blend-mode: screen;
}
@keyframes eh-heat { 0%, 100% { opacity: .62 } 50% { opacity: 1 } }
.eh-hero-number {
  font-size: 46px; font-weight: 800; letter-spacing: -.025em; line-height: 1.1; color: #fff;
  text-shadow: 0 0 22px rgba(255,106,26,.45), 0 0 44px rgba(255,106,26,.18);
  overflow-wrap: anywhere;
}
.eh-hero-number small { font-size: 16px; color: #ff8a4a; font-weight: 700; }
@media (max-width: 520px) { .eh-hero-number { font-size: 34px } }
.eh-chip {
  display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
  border-radius: 99px; padding: 3px 10px; font-size: 12px; font-weight: 700;
  background: rgba(255,106,26,.16); color: #ff8a4a;
}
.eh-chip-green { background: rgba(61,220,151,.14); color: #4ee0a0; }
.eh-chip-muted { background: rgba(255,255,255,.06); color: #c5cfde; }
.eh-card {
  background: #14161b; border: 1px solid #24272f; border-radius: 14px;
  transition: transform .34s cubic-bezier(.34,1.4,.5,1), border-color .3s ease, box-shadow .34s ease;
}
.eh-card:hover {
  transform: translateY(-3px); border-color: rgba(255,106,26,.3);
  box-shadow: 0 18px 44px -22px rgba(255,90,20,.5), 0 0 0 1px rgba(255,106,26,.06);
}
.eh-tile { transition: border-color .3s ease, box-shadow .3s ease, transform .3s cubic-bezier(.34,1.5,.5,1); }
.eh-tile:hover {
  transform: translateY(-2px); border-color: rgba(255,106,26,.28);
  box-shadow: 0 14px 34px -18px rgba(255,90,20,.5);
}
.eh-slice {
  cursor: pointer;
  transition: transform .38s cubic-bezier(.34,1.56,.64,1), filter .28s ease, opacity .22s ease;
}
.eh-has-hover .eh-slice { filter: saturate(.9); }
.eh-coin-stage {
  position: relative; width: 210px; height: 210px; display: none;
  place-items: center; justify-self: center; align-self: center;
  perspective: 900px; pointer-events: none;
}
@media (min-width: 1024px) { .eh-coin-stage { display: grid; } }
.eh-coin-stage::before {
  content: ""; position: absolute; inset: 4px; border-radius: 50%;
  background: radial-gradient(circle at 50% 48%, rgba(255,138,55,.16), rgba(255,106,26,.05) 46%, transparent 68%);
  filter: blur(12px);
}
.eh-coin-ring {
  position: absolute; inset: 6px; border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0 9%, rgba(255,204,128,.62) 17%, transparent 27%, transparent 54%, rgba(255,151,64,.42) 65%, transparent 76%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
  opacity: .8; animation: eh-orbit 16s linear infinite;
}
.eh-coin-body {
  position: relative; width: 164px; height: 164px; padding: 5px; border-radius: 50%;
  background: conic-gradient(from 210deg, #6d3d15, #ffdf9a 9%, #b47826 24%, #4a270f 39%, #eab75c 56%, #7a4418 73%, #ffd98e 88%, #6d3d15);
  border: 1px solid rgba(255,226,164,.5);
  box-shadow:
    inset 0 0 0 2px rgba(255,240,196,.14),
    0 22px 36px -18px rgba(0,0,0,.92),
    0 0 30px rgba(255,106,26,.18);
  transform-style: preserve-3d; animation: eh-float 6s ease-in-out infinite;
}
.eh-coin-face {
  position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: 50%;
  display: grid; place-items: center;
  background: radial-gradient(circle at 48% 27%, #3a2412 0%, #19120c 54%, #0a0908 100%);
  border: 1px solid rgba(255,184,82,.5);
  box-shadow: inset 0 0 22px rgba(255,128,32,.16), inset 0 -14px 20px rgba(0,0,0,.66), inset 0 10px 18px rgba(255,204,125,.07);
}
.eh-coin-face::before {
  content: ""; position: absolute; inset: 0; opacity: .18;
  background-image: radial-gradient(rgba(255,153,0,.82) .7px, transparent .9px);
  background-size: 8px 8px;
}
.eh-coin-face::after {
  content: ""; position: absolute; inset: -25%;
  background: linear-gradient(112deg, transparent 34%, rgba(255,245,207,.22) 48%, transparent 60%);
  animation: eh-shine 6s ease-in-out infinite;
}
.eh-coin-mark {
  position: relative; z-index: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: #ffdf96;
  text-shadow: 0 3px 8px rgba(0,0,0,.85);
}
.eh-coin-mark strong {
  font-size: 54px; line-height: .9; font-weight: 800;
  background: linear-gradient(#fff0bd, #ffc452 55%, #bd6416);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 3px 5px rgba(0,0,0,.75));
}
.eh-coin-mark i { width: 30px; height: 2px; margin: 6px 0 5px; border-radius: 9px; background: rgba(255,174,61,.72); }
.eh-coin-mark small { font-size: 7.5px; letter-spacing: .18em; text-transform: uppercase; font-weight: 800; color: rgba(255,194,101,.86); }
.eh-coin-shadow {
  position: absolute; bottom: 4px; width: 96px; height: 12px; border-radius: 50%;
  background: rgba(0,0,0,.62); filter: blur(10px); animation: eh-shadow 6s ease-in-out infinite;
}
@keyframes eh-float {
  0%, 100% { transform: translateY(0) rotateY(-6deg); }
  50% { transform: translateY(-7px) rotateY(7deg); }
}
@keyframes eh-orbit { to { transform: rotate(360deg); } }
@keyframes eh-shine { 0%, 28% { transform: translateX(-80%) rotate(12deg); } 72%, 100% { transform: translateX(80%) rotate(12deg); } }
@keyframes eh-shadow { 0%, 100% { transform: scaleX(1); opacity: .7; } 50% { transform: scaleX(.8); opacity: .4; } }
@media (prefers-reduced-motion: reduce) {
  .eh-hero-heat, .eh-coin-ring, .eh-coin-body, .eh-coin-face::after, .eh-coin-shadow { animation: none !important; }
  .eh-card, .eh-tile, .eh-slice { transition: none !important; }
}
`;
