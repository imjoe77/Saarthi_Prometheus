"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Eye,
  EyeOff,
  Flame,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Unlock,
  Wallet as WalletIcon,
  X,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import { walletStyles } from "@/lib/design/wallet-styles";
import {
  ApiError,
  createDeposit,
  createWallet,
  getAssets,
  getBalances,
  getDeposits,
  getPaymentsProvider,
  getTransactions,
  getUsdtQuote,
  getWallet,
  verifyDeposit,
  type AssetSummary,
  type BalanceSummary,
  type DepositSummary,
  type PaymentsProviderInfo,
  type TransactionSummary,
  type TransactionTypeName,
  type WalletSummary,
} from "@/lib/api-client";
import { addDecimalStrings, compareDecimalStrings, multiplyDecimalStrings, roundDecimalString } from "@/lib/decimal";
import { openRazorpayCheckout } from "@/lib/razorpay-checkout";

/**
 * MODULE 03 — the wallet page, in the Digital Wallet design.
 *
 * Everything on screen is ledger truth from the BFF: the wallet, its per-asset
 * balances and its transaction pages. Two things the reference design shows are
 * deliberately absent because the backend has no source for them:
 *
 *  - USD valuations. The platform prices in INR and only USDT has a market
 *    price, so a USDT balance is valued at the live 1-USDT bid and EMBER is
 *    shown as unpriced. There is no invented "portfolio value".
 *
 * Adding funds IS available, because Module 03b gives it a source: the deposit
 * is a real ledger movement, so the INR that arrives is spendable INR on the
 * USDT exchange, the EMBER hub and the staking book. The payment rail is the
 * part that may be simulated, and the modal says which rail is in force rather
 * than implying money moved when it did not.
 */

const TRANSACTION_PAGE_SIZE = 25;

/** Quick-pick amounts for the add-funds sheet, in rupees. */
const DEPOSIT_PRESETS = ["1000", "5000", "10000", "50000"];

/** Display order for the asset rail; anything else follows alphabetically. */
const ASSET_ORDER = ["INR", "USDT", "EMBER"];

interface AssetLook {
  color: string;
  mark: string;
}

const ASSET_LOOK: Record<string, AssetLook> = {
  INR: { color: "#ffaa00", mark: "₹" },
  USDT: { color: "#26a17b", mark: "₮" },
  EMBER: { color: "#ff5a1f", mark: "E" },
};

const FALLBACK_LOOK: AssetLook = { color: "#8a93a5", mark: "•" };

function lookFor(symbol: string): AssetLook {
  return ASSET_LOOK[symbol] ?? { ...FALLBACK_LOOK, mark: symbol.slice(0, 1) || "•" };
}

const TYPE_PRESENTATION: Record<
  TransactionTypeName,
  { label: string; polarity: "in" | "out" | "neutral"; Icon: React.ComponentType<{ className?: string }> }
> = {
  DEPOSIT: { label: "Deposit", polarity: "in", Icon: ArrowDownLeft },
  WITHDRAWAL: { label: "Withdrawal", polarity: "out", Icon: ArrowUpRight },
  TRANSFER_IN: { label: "Transfer in", polarity: "in", Icon: ArrowDownLeft },
  TRANSFER_OUT: { label: "Transfer out", polarity: "out", Icon: ArrowUpRight },
  LOCK: { label: "Lock", polarity: "neutral", Icon: Lock },
  UNLOCK: { label: "Unlock", polarity: "neutral", Icon: Unlock },
  ADJUSTMENT: { label: "Adjustment", polarity: "neutral", Icon: SlidersHorizontal },
  BURN: { label: "Burn", polarity: "out", Icon: Flame },
};

const TRANSACTION_TYPES: TransactionTypeName[] = [
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "LOCK",
  "UNLOCK",
  "ADJUSTMENT",
  "BURN",
];

const TRANSACTION_STATUSES = ["COMPLETED", "PENDING", "FAILED", "REVERSED"] as const;

function presentationFor(type: TransactionTypeName) {
  return TYPE_PRESENTATION[type] ?? { label: type, polarity: "neutral" as const, Icon: SlidersHorizontal };
}

function signedAmount(type: TransactionTypeName, amount: string): string {
  const { polarity } = presentationFor(type);

  if (polarity === "in") return `+${amount}`;
  if (polarity === "out") return `-${amount}`;
  return amount;
}

function polarityClass(type: TransactionTypeName): string {
  const { polarity } = presentationFor(type);

  if (polarity === "in") return "wlt-amount-in";
  if (polarity === "out") return "wlt-amount-out";
  return "wlt-amount-flat";
}

/** Groups the integer part in threes, leaving the fraction untouched. */
function groupDigits(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const [whole = "0", fraction] = digits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** Trims a fixed-point string for display without losing the magnitude. */
function formatUnits(raw: string, maxPlaces = 6): string {
  const [whole = "0", fraction = ""] = raw.split(".");
  const trimmed = fraction.slice(0, maxPlaces).replace(/0+$/, "");

  return groupDigits(trimmed.length > 0 ? `${whole}.${trimmed}` : whole);
}

/** Exactly two decimals, rounded HALF_UP, as money. */
function formatMoney(raw: string): string {
  return groupDigits(roundDecimalString(raw, 2));
}

function isZeroDecimal(raw: string): boolean {
  return /^0*(\.0*)?$/.test(raw);
}

/**
 * Validates a top-up amount the way the backend will validate it.
 *
 * The browser check is for the person's benefit, not the ledger's: the backend
 * refuses a malformed amount on its own. Checking here means the mistake is
 * caught before a request is made, and the ceiling is quoted from the same
 * configured value the API enforces.
 */
function validateDepositAmount(raw: string, maxInr: string | null): string | null {
  const trimmed = raw.trim();

  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return "Enter an amount in rupees, with at most two decimal places.";
  }

  if (isZeroDecimal(trimmed)) {
    return "The amount must be greater than zero.";
  }

  if (maxInr !== null && compareDecimalStrings(trimmed, maxInr) > 0) {
    return `A single top-up may not exceed ₹${maxInr}.`;
  }

  return null;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  return "Something went wrong while talking to the Prometheus API.";
}

/**
 * A top-up the browser can still finish: started on the Razorpay rail, not yet
 * credited, and carrying the checkout that reopens its order. A settled deposit
 * has nothing left to pay, and a simulated one never needed a checkout.
 */
function isResumable(deposit: DepositSummary): boolean {
  return deposit.status === "PENDING" && deposit.checkout !== null;
}

interface WalletSnapshot {
  wallet: WalletSummary | null;
  assets: AssetSummary[];
  balances: BalanceSummary[];
  transactions: TransactionSummary[];
  nextCursor: string | null;
}

type LoadStatus = "loading" | "ready" | "error";

/** Reads the whole wallet view. Sets no state, so an effect can call it freely. */
async function fetchSnapshot(): Promise<WalletSnapshot> {
  const wallet = await getWallet();

  if (!wallet) {
    return { wallet: null, assets: [], balances: [], transactions: [], nextCursor: null };
  }

  const [assets, balances, page] = await Promise.all([
    getAssets(),
    getBalances(),
    getTransactions({ limit: TRANSACTION_PAGE_SIZE }),
  ]);

  return { wallet, assets, balances, transactions: page.items, nextCursor: page.nextCursor };
}

type Row = AssetSummary & { held: BalanceSummary | null };

/** Every supported asset, ordered, joined with whatever balance the wallet holds. */
function balanceRows(assets: AssetSummary[], balances: BalanceSummary[]): Row[] {
  const bySymbol = new Map(balances.map((balance) => [balance.asset.symbol, balance]));

  const ordered = [...assets].sort((left, right) => {
    const leftIndex = ASSET_ORDER.indexOf(left.symbol);
    const rightIndex = ASSET_ORDER.indexOf(right.symbol);
    if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
    if (leftIndex !== -1) return -1;
    if (rightIndex !== -1) return 1;
    return left.symbol.localeCompare(right.symbol);
  });

  return ordered.map((asset) => ({ ...asset, held: bySymbol.get(asset.symbol) ?? null }));
}

function unitsOf(row: Row): string {
  return row.held ? addDecimalStrings(row.held.available, row.held.locked) : "0";
}

/** INR price of one unit, or null when the platform cannot price the asset. */
function priceOf(symbol: string, usdtInr: string | null): string | null {
  if (symbol === "INR") return "1";
  if (symbol === "USDT") return usdtInr;
  return null;
}

function valueOf(row: Row, usdtInr: string | null): string | null {
  const price = priceOf(row.symbol, usdtInr);
  if (price === null) return null;

  return multiplyDecimalStrings(unitsOf(row), price);
}

export default function WalletPage() {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [balances, setBalances] = useState<BalanceSummary[]>([]);
  const [transactions, setTransactions] = useState<TransactionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // MODULE 03b - adding funds. `depositKeyRef` holds the idempotency key for
  // the amount currently in the sheet, so a retry of the SAME intent replays
  // the original deposit instead of crediting the wallet twice, while a
  // different amount is a different intent and gets its own key.
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("5000");
  const [depositStage, setDepositStage] = useState<"idle" | "starting" | "paying">("idle");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositDone, setDepositDone] = useState<DepositSummary | null>(null);
  const [provider, setProvider] = useState<PaymentsProviderInfo | null>(null);
  const depositKeyRef = useRef<{ amount: string; key: string } | null>(null);

  // MODULE 03b - an unfinished top-up, and which one is being resumed right now.
  // On the Razorpay rail a deposit whose sheet was closed stays PENDING with its
  // order intact; listing it here is what makes that visible and resumable
  // instead of an orphan the user can neither see nor clear.
  const [pendingDeposits, setPendingDeposits] = useState<DepositSummary[]>([]);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TransactionTypeName | "ALL">("ALL");
  const [statusFilter, setStatusFilter] = useState<(typeof TRANSACTION_STATUSES)[number] | "ALL">("ALL");

  // The USDT price is read from the exchange's own quote endpoint rather than
  // guessed: the wallet values a USDT balance at the live 1-USDT bid.
  const [price, setPrice] = useState<{
    tick: number;
    value: string | null;
    status: "live" | "fallback" | null;
    note: string | null;
  }>({
    tick: -1,
    value: null,
    status: null,
    note: null,
  });
  const [priceTick, setPriceTick] = useState(0);

  const applySnapshot = useCallback((snapshot: WalletSnapshot) => {
    setWallet(snapshot.wallet);
    setAssets(snapshot.assets);
    setBalances(snapshot.balances);
    setTransactions(snapshot.transactions);
    setNextCursor(snapshot.nextCursor);
    setStatus("ready");
  }, []);

  const load = useCallback(async () => {
    try {
      applySnapshot(await fetchSnapshot());
    } catch (loadError) {
      setError(messageFor(loadError));
      setStatus("error");
    }
  }, [applySnapshot]);

  useEffect(() => {
    let active = true;

    // State is applied inside the promise callback, never synchronously in the
    // effect body, so this reads as a subscription rather than a render that
    // cascades into another.
    fetchSnapshot()
      .then((snapshot) => {
        if (active) applySnapshot(snapshot);
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
  }, [applySnapshot]);

  useEffect(() => {
    let active = true;
    const tick = priceTick;

    getUsdtQuote("SELL", "1")
      .then((quote) => {
        if (active) {
          setPrice({ tick, value: quote.prometheusPrice, status: quote.pricing.status, note: null });
        }
      })
      .catch((quoteError: unknown) => {
        if (!active) return;
        setPrice({
          tick,
          value: null,
          status: null,
          note:
            quoteError instanceof ApiError
              ? quoteError.message
              : "The USDT price could not be read right now.",
        });
      });

    return () => {
      active = false;
    };
  }, [priceTick]);

  // Which payment rail is in force, read once the add-funds sheet opens. It is
  // a description of the platform, not of the user, so it is fetched lazily
  // rather than on every page load.
  useEffect(() => {
    if (!depositOpen || provider !== null) return;

    let active = true;

    getPaymentsProvider()
      .then((info) => {
        if (active) setProvider(info);
      })
      .catch(() => {
        // The sheet falls back to its default wording; the deposit itself will
        // still fail loudly if the provider cannot be reached.
      });

    return () => {
      active = false;
    };
  }, [depositOpen, provider]);

  // The unfinished top-up is read with the page, not with the sheet: it belongs
  // to the wallet view rather than to one dialog, and a listing failure must
  // not shadow the balances that are already on screen. State is applied in the
  // promise callback rather than in the effect body, like the snapshot load.
  useEffect(() => {
    let active = true;

    getDeposits()
      .then((deposits) => {
        if (active) setPendingDeposits(deposits.filter(isResumable));
      })
      .catch(() => {
        // Deliberately silent: the resume strip is a convenience, and an error
        // banner for it would only confuse a page whose ledger loaded fine.
      });

    return () => {
      active = false;
    };
  }, []);

  /** Re-reads unfinished top-ups, for after a deposit settles or is resumed. */
  const loadPendingDeposits = useCallback(async () => {
    try {
      const deposits = await getDeposits();
      setPendingDeposits(deposits.filter(isResumable));
    } catch {
      // Same deliberate silence as above.
    }
  }, []);

  const refresh = useCallback(() => {
    setError(null);
    setStatus("loading");
    setPriceTick((tick) => tick + 1);
    void load();
  }, [load]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);

    try {
      await createWallet();
      await load();
    } catch (createError) {
      setError(messageFor(createError));
      setStatus("error");
    } finally {
      setCreating(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;

    setLoadingMore(true);

    try {
      const page = await getTransactions({ cursor: nextCursor, limit: TRANSACTION_PAGE_SIZE });
      setTransactions((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (loadMoreError) {
      setError(messageFor(loadMoreError));
    } finally {
      setLoadingMore(false);
    }
  };

  // ---------------------------------------------------------------------------
  // MODULE 03b - adding funds
  // ---------------------------------------------------------------------------

  const openDeposit = useCallback(() => {
    setDepositOpen(true);
    setDepositAmount("5000");
    setDepositStage("idle");
    setDepositError(null);
    setDepositDone(null);
    depositKeyRef.current = null;
  }, []);

  const closeDeposit = useCallback(() => {
    if (depositStage !== "idle") return;
    setDepositOpen(false);
  }, [depositStage]);

  const submitDeposit = useCallback(async () => {
    const problem = validateDepositAmount(depositAmount, provider?.maxDepositInr ?? null);

    if (problem !== null) {
      setDepositError(problem);
      return;
    }

    const amount = depositAmount.trim();
    const pending = depositKeyRef.current;
    const clientRequestId =
      pending && pending.amount === amount ? pending.key : crypto.randomUUID();
    depositKeyRef.current = { amount, key: clientRequestId };

    setDepositStage("starting");
    setDepositError(null);

    try {
      const deposit = await createDeposit({ clientRequestId, amountInr: amount });

      // A checkout means the money has not arrived yet: the deposit is PENDING
      // and the wallet is only credited once Razorpay confirms the payment.
      if (deposit.checkout !== null) {
        setDepositStage("paying");

        const payment = await openRazorpayCheckout(deposit.checkout);

        if (payment === null) {
          setDepositStage("idle");
          setDepositError(
            "The payment sheet was closed before the payment completed. Nothing was credited — you can try again.",
          );
          return;
        }

        const confirmed = await verifyDeposit(deposit.id, {
          razorpayOrderId: payment.razorpay_order_id,
          razorpayPaymentId: payment.razorpay_payment_id,
          razorpaySignature: payment.razorpay_signature,
        });

        setDepositDone(confirmed);
        setDepositStage("idle");
        void loadPendingDeposits();
        await load();
        return;
      }

      setDepositDone(deposit);
      setDepositStage("idle");
      void loadPendingDeposits();
      await load();
    } catch (submitError) {
      setDepositStage("idle");
      setDepositError(messageFor(submitError));
    }
  }, [depositAmount, provider, load, loadPendingDeposits]);

  /**
   * Reopens the SAME order behind an unfinished top-up.
   *
   * Nothing is created here: the deposit row and the Razorpay order it holds
   * are reused, so paying settles the top-up the user already started rather
   * than leaving a second, competing one. Closing the sheet again simply leaves
   * it pending and still listed.
   */
  const resumeDeposit = useCallback(
    async (deposit: DepositSummary) => {
      if (deposit.checkout === null) return;

      setResumingId(deposit.id);
      setDepositError(null);

      try {
        const payment = await openRazorpayCheckout(deposit.checkout);

        if (payment === null) {
          return;
        }

        const confirmed = await verifyDeposit(deposit.id, {
          razorpayOrderId: payment.razorpay_order_id,
          razorpayPaymentId: payment.razorpay_payment_id,
          razorpaySignature: payment.razorpay_signature,
        });

        setPendingDeposits((previous) => previous.filter((item) => item.id !== deposit.id));
        setDepositDone(confirmed);
        setDepositOpen(true);
        await load();
      } catch (resumeError) {
        setError(messageFor(resumeError));
      } finally {
        setResumingId(null);
      }
    },
    [load],
  );

  /** The one unfinished top-up worth offering to resume, if there is one. */
  const unfinished = pendingDeposits[0] ?? null;

  const rows = useMemo(() => balanceRows(assets, balances), [assets, balances]);
  const selected = useMemo(
    () => rows.find((row) => row.symbol === selectedSymbol) ?? rows[0] ?? null,
    [rows, selectedSymbol],
  );

  const priceBusy = status === "ready" && price.tick !== priceTick;
  const usdtInr = price.value;

  const totals = useMemo(() => {
    let total = "0";
    let available = "0";
    let locked = "0";
    const unpriced: string[] = [];

    for (const row of rows) {
      if (!row.held) continue;

      const rowPrice = priceOf(row.symbol, usdtInr);
      if (rowPrice === null) {
        if (!isZeroDecimal(unitsOf(row))) unpriced.push(row.symbol);
        continue;
      }

      total = addDecimalStrings(total, multiplyDecimalStrings(unitsOf(row), rowPrice));
      available = addDecimalStrings(available, multiplyDecimalStrings(row.held.available, rowPrice));
      locked = addDecimalStrings(locked, multiplyDecimalStrings(row.held.locked, rowPrice));
    }

    return { total, available, locked, unpriced };
  }, [rows, usdtInr]);

  const selectedUnits = selected ? unitsOf(selected) : "0";
  const selectedAvailable = selected?.held?.available ?? "0";
  const selectedLocked = selected?.held?.locked ?? "0";
  const selectedValue = selected ? valueOf(selected, usdtInr) : null;
  const availableShare = useMemo(() => {
    if (selected === null || !selected.held) return 0;
    const total = Number(selectedUnits);
    if (!Number.isFinite(total) || total <= 0) return 0;

    // A bar width, not a money figure: the ratio only needs display precision.
    return Math.min(100, Math.max(0, (Number(selectedAvailable) / total) * 100));
  }, [selected, selectedUnits, selectedAvailable]);

  const assetTransactions = useMemo(
    () => (selected ? transactions.filter((tx) => tx.asset.symbol === selected.symbol) : []),
    [transactions, selected],
  );

  const filteredTransactions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return assetTransactions.filter((tx) => {
      const matchesQuery =
        query.length === 0 ||
        tx.id.toLowerCase().includes(query) ||
        tx.type.toLowerCase().includes(query) ||
        tx.amount.toLowerCase().includes(query) ||
        (tx.note ?? "").toLowerCase().includes(query);
      const matchesType = typeFilter === "ALL" || tx.type === typeFilter;
      const matchesStatus = statusFilter === "ALL" || tx.status === statusFilter;

      return matchesQuery && matchesType && matchesStatus;
    });
  }, [assetTransactions, searchQuery, typeFilter, statusFilter]);

  const filtersActive = searchQuery.trim().length > 0 || typeFilter !== "ALL" || statusFilter !== "ALL";
  const masked = hidden ? "••••••" : null;

  const walletStatusLabel = wallet ? "WALLET ACTIVE" : "NO WALLET YET";

  return (
    <AppShell>
      <style dangerouslySetInnerHTML={{ __html: walletStyles }} />

      <div className="wlt-page">
        <div className="wlt-head">
          <div>
            <div className="wlt-eyebrow">
              <span className="dot" />
              <span>Wallet &amp; activity ledger</span>
              <span>·</span>
              <b>{walletStatusLabel}</b>
            </div>
            <h1 className="wlt-title">Digital Wallet</h1>
            <p className="wlt-sub">
              Balances and ledger movements recorded by the Prometheus accounting boundary. USDT is
              valued at the live 1-USDT bid; EMBER is not priced because the platform has no market
              for it.
            </p>
          </div>

          <div className="wlt-head-actions">
            <button
              type="button"
              onClick={refresh}
              className="wlt-btn ghost"
              aria-label="Reload wallet data"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
            <button
              type="button"
              onClick={() => setHidden((value) => !value)}
              className="wlt-icon-btn"
              aria-label={hidden ? "Show balances" : "Hide balances"}
              title={hidden ? "Show balances" : "Hide balances"}
            >
              {hidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {error && (
          <div className="wlt-alert" style={{ marginTop: 18 }}>
            <AlertTriangle className="w-4 h-4" />
            <div style={{ flex: 1 }}>
              <b>Could not load wallet data</b>
              {error}
            </div>
            <button type="button" onClick={refresh} className="wlt-btn" style={{ padding: "5px 10px" }}>
              Retry
            </button>
          </div>
        )}

        {status === "loading" && (
          <div className="wlt-loading" style={{ marginTop: 18 }}>
            <Loader2 className="w-4 h-4 wlt-spin" />
            <span>Reading the wallet ledger…</span>
          </div>
        )}

        {status === "ready" && !wallet && (
          <div className="wlt-noWallet" style={{ marginTop: 18 }}>
            <div className="wlt-noWallet-icon">
              <WalletIcon className="w-6 h-6" />
            </div>
            <div>
              <h2>No wallet yet</h2>
              <p>
                Create your wallet to start tracking balances and ledger movements. Once it exists
                you can add funds to it, and that top-up is recorded as a real deposit in the
                ledger.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="wlt-btn primary"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 wlt-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {creating ? "Creating…" : "Create wallet"}
            </button>
          </div>
        )}

        {status === "ready" && wallet && (
          <div className="wlt-layout">
            {unfinished !== null && (
              <div className="wlt-resume" role="status">
                <div className="wlt-resume-copy">
                  <b>Unfinished top-up</b>
                  <span>
                    You started ₹{formatMoney(unfinished.amount)} and the payment sheet was closed before it
                    completed. Nothing has been credited — resuming pays for this same top-up, not a new one.
                  </span>
                </div>
                <div className="wlt-resume-actions">
                  <button
                    type="button"
                    className="wlt-btn primary"
                    onClick={() => void resumeDeposit(unfinished)}
                    disabled={resumingId !== null}
                  >
                    {resumingId === unfinished.id && <Loader2 className="w-3.5 h-3.5 wlt-spin" />}
                    Resume payment
                  </button>
                  <button
                    type="button"
                    className="wlt-btn ghost"
                    onClick={() =>
                      setPendingDeposits((previous) => previous.filter((item) => item.id !== unfinished.id))
                    }
                    disabled={resumingId !== null}
                  >
                    Not now
                  </button>
                </div>
              </div>
            )}
            <div className="wlt-left">
              <section className="wlt-card lift wlt-total">
                <div className="wlt-total-k">Priced holdings</div>
                <div className="wlt-total-v">
                  {masked ?? (
                    <>
                      <span className="cur">₹</span>
                      {formatMoney(totals.total)}
                    </>
                  )}
                </div>
                <p className="wlt-total-note">
                  {priceBusy
                    ? "Reading the live USDT price…"
                    : usdtInr === null
                      ? "USDT is not priced right now, so this total covers INR only."
                      : `USDT valued at ₹${usdtInr} per unit${
                          price.status === "fallback"
                            ? " (indicative fallback — not a live quote)"
                            : ""
                        }. `}
                  {totals.unpriced.length > 0
                    ? `Not valued: ${totals.unpriced.join(", ")}.`
                    : "EMBER is excluded — it has no market price."}
                </p>

                <div className="wlt-split">
                  <div className="wlt-split-item">
                    <div className="wlt-split-k">Available</div>
                    <div className="wlt-split-v up">
                      {masked ?? `₹${formatMoney(totals.available)}`}
                    </div>
                  </div>
                  <div className="wlt-split-item">
                    <div className="wlt-split-k">Locked</div>
                    <div className="wlt-split-v amb">
                      {masked ?? `₹${formatMoney(totals.locked)}`}
                    </div>
                  </div>
                </div>

                <div className="wlt-actions">
                  <button type="button" className="wlt-action" onClick={openDeposit}>
                    <Plus className="w-3.5 h-3.5" />
                    Add funds
                  </button>
                  <Link className="wlt-action" href="/usdt-exchange">
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                    Buy USDT
                  </Link>
                  <Link className="wlt-action" href="/ember-hub">
                    <Flame className="w-3.5 h-3.5" />
                    Buy EMBER
                  </Link>
                  <Link className="wlt-action" href="/staking">
                    <Lock className="w-3.5 h-3.5" />
                    Lock EMBER
                  </Link>
                </div>
              </section>

              <section className="wlt-card wlt-assets">
                <div className="wlt-assets-k">Assets</div>
                <div className="wlt-coin-list">
                  {rows.map((row) => {
                    const look = lookFor(row.symbol);
                    const active = selected?.symbol === row.symbol;

                    return (
                      <button
                        key={row.symbol}
                        type="button"
                        onClick={() => {
                          setSelectedSymbol(row.symbol);
                          setSearchQuery("");
                          setTypeFilter("ALL");
                          setStatusFilter("ALL");
                        }}
                        className={`wlt-coin${active ? " on" : ""}`}
                        style={{ ["--coin" as string]: look.color }}
                        aria-pressed={active}
                      >
                        <span
                          className="wlt-coin-icon"
                          style={{
                            background: `${look.color}1f`,
                            border: `2px solid ${look.color}${active ? "" : "66"}`,
                            color: look.color,
                          }}
                        >
                          {look.mark}
                        </span>
                        <span className="wlt-coin-body">
                          <span className="wlt-coin-sym">{row.symbol}</span>
                          <span className="wlt-coin-bal">
                            {row.held ? (masked ?? formatUnits(unitsOf(row))) : "no balance yet"}
                          </span>
                        </span>
                        {active && <span className="wlt-coin-dot" />}
                      </button>
                    );
                  })}
                </div>
                <p className="wlt-rail-note">
                  Every asset the platform supports is listed, held or not. Adding funds is a real
                  ledger deposit, so the INR you top up is spendable on the exchange, the EMBER hub
                  and staking — the shortcuts above open those surfaces.
                </p>
              </section>
            </div>

            <div className="wlt-right">
              {selected && (
                <>
                  <section className="wlt-card wlt-detail">
                    <div className="wlt-detail-head">
                      <div
                        className="wlt-detail-icon"
                        style={{
                          background: `${lookFor(selected.symbol).color}1f`,
                          border: `2px solid ${lookFor(selected.symbol).color}`,
                          color: lookFor(selected.symbol).color,
                        }}
                      >
                        {lookFor(selected.symbol).mark}
                      </div>
                      <div>
                        <div className="wlt-detail-name">{selected.name}</div>
                        <div className="wlt-detail-sym">
                          {selected.symbol} · {selected.decimals} decimals
                        </div>
                      </div>
                      <span className={`wlt-kind k-${selected.kind.toLowerCase()}`}>{selected.kind}</span>
                    </div>

                    <div className="wlt-stats">
                      <div className="wlt-stat">
                        <div className="wlt-stat-k">Available</div>
                        <div className="wlt-stat-v">{masked ?? formatUnits(selectedAvailable)}</div>
                        <div className="wlt-stat-n">{selected.symbol}</div>
                      </div>
                      <div className="wlt-stat">
                        <div className="wlt-stat-k">Locked</div>
                        <div className="wlt-stat-v">{masked ?? formatUnits(selectedLocked)}</div>
                        <div className="wlt-stat-n">
                          {!selected.held
                            ? "No balance yet"
                            : isZeroDecimal(selectedLocked)
                              ? "Nothing locked"
                              : "Held in a lock or stake"}
                        </div>
                      </div>
                      <div className="wlt-stat">
                        <div className="wlt-stat-k">Value (INR)</div>
                        <div className="wlt-stat-v blue">
                          {masked ?? (selectedValue === null ? "—" : `₹${formatMoney(selectedValue)}`)}
                        </div>
                        <div className="wlt-stat-n">
                          {selectedValue === null
                            ? "No market price"
                            : selected.symbol === "INR"
                              ? "Face value"
                              : price.status === "fallback"
                                ? "Indicative fallback"
                                : "Indicative, live 1-USDT bid"}
                        </div>
                      </div>
                    </div>

                    <div className="wlt-splitline">
                      <div className="wlt-splitline-head">
                        <span>Available vs locked</span>
                        <b>{selected.held ? `${availableShare.toFixed(1)}% available` : "—"}</b>
                      </div>
                      <div className="wlt-bar">
                        <span
                          style={{
                            width: `${availableShare}%`,
                            background: lookFor(selected.symbol).color,
                          }}
                        />
                      </div>
                    </div>

                    <div className="wlt-detail-actions">
                      {selected.symbol === "INR" && (
                        <>
                          <button type="button" className="wlt-btn primary" onClick={openDeposit}>
                            <Plus className="w-3.5 h-3.5" />
                            Add funds
                          </button>
                          <Link className="wlt-btn" href="/usdt-exchange">
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                            Buy USDT with INR
                          </Link>
                        </>
                      )}
                      {selected.symbol === "USDT" && (
                        <Link className="wlt-btn primary" href="/usdt-exchange">
                          <ArrowLeftRight className="w-3.5 h-3.5" />
                          Open the USDT exchange
                        </Link>
                      )}
                      {selected.symbol === "EMBER" && (
                        <>
                          <Link className="wlt-btn primary" href="/ember-hub">
                            <Flame className="w-3.5 h-3.5" />
                            Buy EMBER
                          </Link>
                          <Link className="wlt-btn" href="/staking">
                            <Lock className="w-3.5 h-3.5" />
                            Lock EMBER
                          </Link>
                        </>
                      )}
                      <Link className="wlt-btn ghost" href="/activity">
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        Full activity
                      </Link>
                    </div>
                  </section>

                  <section className="wlt-card wlt-tx">
                    <div className="wlt-tx-head">
                      <div className="wlt-tx-title">
                        Transaction history · <span>{selected.symbol}</span>
                      </div>

                      <div className="wlt-filters">
                        <div className="wlt-search">
                          <Search className="w-3.5 h-3.5" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Search loaded rows…"
                            className="wlt-input"
                            aria-label="Search transactions"
                          />
                        </div>
                        <select
                          className="wlt-input"
                          value={typeFilter}
                          onChange={(event) =>
                            setTypeFilter(event.target.value as TransactionTypeName | "ALL")
                          }
                          aria-label="Filter by transaction type"
                        >
                          <option value="ALL">All types</option>
                          {TRANSACTION_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {presentationFor(type).label}
                            </option>
                          ))}
                        </select>
                        <select
                          className="wlt-input"
                          value={statusFilter}
                          onChange={(event) =>
                            setStatusFilter(
                              event.target.value as (typeof TRANSACTION_STATUSES)[number] | "ALL",
                            )
                          }
                          aria-label="Filter by status"
                        >
                          <option value="ALL">All statuses</option>
                          {TRANSACTION_STATUSES.map((value) => (
                            <option key={value} value={value}>
                              {value.charAt(0) + value.slice(1).toLowerCase()}
                            </option>
                          ))}
                        </select>
                        {filtersActive && (
                          <button
                            type="button"
                            className="wlt-btn"
                            style={{ padding: "7px 11px" }}
                            onClick={() => {
                              setSearchQuery("");
                              setTypeFilter("ALL");
                              setStatusFilter("ALL");
                            }}
                          >
                            <X className="w-3.5 h-3.5" />
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    {assetTransactions.length === 0 ? (
                      <div className="wlt-empty">
                        No ledger movements for {selected.symbol} yet.
                        <br />
                        Rows appear here as the platform records credits, locks and burns.
                      </div>
                    ) : filteredTransactions.length === 0 ? (
                      <div className="wlt-empty">
                        No loaded row matches these filters.
                        <br />
                        Filters apply to the rows already loaded — load more to widen the window.
                      </div>
                    ) : (
                      <div className="wlt-table-wrap">
                        <table className="wlt-table">
                          <thead>
                            <tr>
                              <th>Date &amp; time</th>
                              <th>Type</th>
                              <th style={{ textAlign: "right" }}>Amount</th>
                              <th style={{ textAlign: "right" }}>Value (INR)</th>
                              <th>Balance after</th>
                              <th>Reference</th>
                              <th style={{ textAlign: "right" }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredTransactions.map((tx) => {
                              const presentation = presentationFor(tx.type);
                              const Icon = presentation.Icon;
                              const price = priceOf(tx.asset.symbol, usdtInr);
                              const value =
                                price === null ? null : multiplyDecimalStrings(tx.amount, price);

                              return (
                                <tr key={tx.id}>
                                  <td className="mono dim" style={{ whiteSpace: "nowrap" }}>
                                    {formatTimestamp(tx.createdAt)}
                                  </td>
                                  <td>
                                    <span className="wlt-type">
                                      <i>
                                        <Icon className="w-3 h-3" />
                                      </i>
                                      {presentation.label}
                                    </span>
                                  </td>
                                  <td
                                    className={`num ${polarityClass(tx.type)}`}
                                    style={{ fontWeight: 700 }}
                                  >
                                    {masked ??
                                      `${signedAmount(tx.type, formatUnits(tx.amount))} ${tx.asset.symbol}`}
                                  </td>
                                  <td className="num dim">
                                    {masked ?? (value === null ? "—" : `₹${formatMoney(value)}`)}
                                  </td>
                                  <td className="mono dim">
                                    <div>{tx.availableAfter === null ? "—" : formatUnits(tx.availableAfter)}</div>
                                    {tx.lockedAfter !== null && !isZeroDecimal(tx.lockedAfter) && (
                                      <div style={{ fontSize: 10 }}>locked {formatUnits(tx.lockedAfter)}</div>
                                    )}
                                  </td>
                                  <td className="mono dim" style={{ maxWidth: 190 }}>
                                    <span title={tx.note ?? tx.id} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {tx.note ?? tx.id.slice(0, 8)}
                                    </span>
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    <span className={`wlt-pill ${tx.status.toLowerCase()}`}>{tx.status}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <p className="wlt-note">
                      Showing {filteredTransactions.length} of {assetTransactions.length} loaded row
                      {assetTransactions.length === 1 ? "" : "s"} for {selected.symbol}. The ledger
                      pages newest-first; filters never query the server.
                    </p>

                    {nextCursor && (
                      <div className="wlt-more">
                        <button
                          type="button"
                          onClick={() => void handleLoadMore()}
                          disabled={loadingMore}
                          className="wlt-btn ghost"
                        >
                          {loadingMore && <Loader2 className="w-3.5 h-3.5 wlt-spin" />}
                          {loadingMore ? "Loading…" : "Load more rows"}
                        </button>
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        )}

        {depositOpen && (
          <div
            className="wlt-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Add funds to your wallet"
          >
            <div className="wlt-modal">
              <div className="wlt-modal-head">
                <div>
                  <h2 className="wlt-modal-title">Add funds</h2>
                  <p className="wlt-modal-sub">
                    {provider?.provider === "razorpay"
                      ? "Pay by card, UPI or netbanking through Razorpay. The balance is credited once the payment is confirmed."
                      : "Top up your wallet in rupees. The credit is recorded as a real deposit, so the INR is spendable on the exchange, the EMBER hub and staking."}
                  </p>
                </div>
                <button
                  type="button"
                  className="wlt-close"
                  onClick={closeDeposit}
                  disabled={depositStage !== "idle"}
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="wlt-modal-body">
                {depositDone !== null ? (
                  <>
                    <div className="wlt-modal-success">
                      <b>₹{formatMoney(depositDone.amount)} is in your wallet.</b>
                      The deposit was recorded in the ledger and your INR balance has been updated.
                    </div>

                    <div className="wlt-modal-actions">
                      <button type="button" className="wlt-btn primary" onClick={closeDeposit}>
                        Done
                      </button>
                      <Link className="wlt-btn ghost" href="/usdt-exchange">
                        <ArrowLeftRight className="w-3.5 h-3.5" />
                        Buy USDT
                      </Link>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="wlt-field-label" htmlFor="deposit-amount">
                      Amount (INR)
                    </label>
                    <div className="wlt-amount">
                      <span className="cur">₹</span>
                      <input
                        id="deposit-amount"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={depositAmount}
                        onChange={(event) => {
                          setDepositAmount(event.target.value);
                          setDepositError(null);
                        }}
                        placeholder="5000"
                        disabled={depositStage !== "idle"}
                      />
                    </div>

                    <div className="wlt-presets">
                      {DEPOSIT_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={`wlt-preset${depositAmount.trim() === preset ? " on" : ""}`}
                          onClick={() => {
                            setDepositAmount(preset);
                            setDepositError(null);
                          }}
                          disabled={depositStage !== "idle"}
                        >
                          ₹{Number(preset).toLocaleString("en-IN")}
                        </button>
                      ))}
                    </div>

                    {depositError !== null && (
                      <div className="wlt-modal-failure">
                        <b>The top-up did not go through.</b>
                        {depositError}
                      </div>
                    )}

                    <div className="wlt-modal-note">
                      {provider?.provider === "razorpay" ? (
                        <>
                          <b>Paid through Razorpay.</b> The amount is held as pending until the
                          payment is confirmed, so an unfinished payment never credits your wallet.
                        </>
                      ) : (
                        <>
                          <b>Simulated payment rail.</b> No payment provider is involved, so no
                          money leaves your bank — but the credit itself is a genuine ledger
                          deposit, and the INR you receive is spendable on the exchange, the EMBER
                          hub and staking.
                        </>
                      )}
                    </div>

                    {provider?.maxDepositInr !== undefined && (
                      <p className="wlt-modal-hint">
                        A single top-up may not exceed ₹{provider.maxDepositInr}.
                      </p>
                    )}

                    <div className="wlt-modal-actions">
                      <button
                        type="button"
                        className="wlt-btn primary"
                        onClick={() => void submitDeposit()}
                        disabled={depositStage !== "idle"}
                      >
                        {depositStage === "starting" && (
                          <Loader2 className="w-3.5 h-3.5 wlt-spin" />
                        )}
                        {depositStage === "paying" && (
                          <Loader2 className="w-3.5 h-3.5 wlt-spin" />
                        )}
                        {depositStage === "paying"
                          ? "Waiting for payment…"
                          : depositStage === "starting"
                            ? "Adding funds…"
                            : provider?.provider === "razorpay"
                              ? "Pay ₹" + (depositAmount.trim() || "0")
                              : "Add ₹" + (depositAmount.trim() || "0") + " to wallet"}
                      </button>
                      <button
                        type="button"
                        className="wlt-btn ghost"
                        onClick={closeDeposit}
                        disabled={depositStage !== "idle"}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
