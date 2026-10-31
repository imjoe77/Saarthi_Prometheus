"use client";

import React, { useEffect } from "react";
import { useSession } from "next-auth/react";

import DesignFrame from "@/components/design/DesignFrame";
import {
  getEmberHubOverview,
  getPortfolio,
  getTransactions,
  listCopyFollows,
  type CopyEligibility,
  type CopyFollow,
  type EmberHubStatement,
  type PortfolioSnapshotResponse,
  type TransactionSummary,
  type TransactionTypeName,
} from "@/lib/api-client";
import { designs } from "@/lib/design/generated";
import {
  apiMessage,
  bindHtml,
  bindText,
  cleanupAll,
  sel,
  toast,
  type Binder,
} from "@/lib/design/wire";

/**
 * The signed-in Overview — `designs/user_dashboard.html` mounted standalone and
 * wired to the ledger (the design-integration pattern is documented in
 * `app/staking/page.tsx`).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - Ledger truth: the four summary tiles are the wallet's state, the count of
 *    funded assets, the ledger's movement totals and the date of the last
 *    movement (`GET portfolio`); the activity panel is the caller's real
 *    transaction list (`GET wallets/me/transactions`); the holdings panel is
 *    the real portfolio, bar-for-bar showing each balance's locked share.
 *  - No valuation, anywhere. Prometheus stores no prices, so the design's
 *    "$12,480", its 30-day change and its rising trend line cannot be derived.
 *    The balance-trend panel keeps its shape but says it is illustrative, its
 *    balance reads "—", and the tiles are re-labelled to the four things the
 *    platform can actually measure.
 *  - The greeting, the sidebar identity and the account line come from the
 *    session, not from the design's "Elena A. · Account 0048".
 *  - Two panels read real endpoints the reference design never had: the
 *    traders the caller follows and their copy status (`GET copy/follows`),
 *    and EMBER's configured price with its display-only USDT/INR rate
 *    (`GET ember-hub/overview`). Both fail independently, so one unavailable
 *    endpoint cannot blank the ledger widgets.
 *  - Nothing on this page mutates state. The design's welcome questionnaire
 *    was removed: it duplicated the real wizard at `/onboarding`, which owns
 *    preferences now. This page only reads.
 *
 * The rest of the document (the Expert Trader and Liquidity Provider
 * workspaces inside the same file) stays hidden: the extractor carries
 * `<body data-view="user-view">` into `design.bodyAttrs`, so the design's own
 * workspace switcher picks this view before any script runs.
 */

type LoadStatus = "loading" | "ready" | "error";

interface DashboardIdentity {
  name: string;
  email: string;
}

interface DashboardView {
  status: LoadStatus;
  snapshot: PortfolioSnapshotResponse | null;
  recent: TransactionSummary[];
  identity: DashboardIdentity | null;
  error: string | null;
  follows: CopyFollow[];
  followsStatus: LoadStatus;
  ember: EmberHubStatement | null;
  emberStatus: LoadStatus;
}

const view: DashboardView = {
  status: "loading",
  snapshot: null,
  recent: [],
  identity: null,
  error: null,
  follows: [],
  followsStatus: "loading",
  ember: null,
  emberStatus: "loading",
};

/** Set by the wiring so a session change arriving later re-applies the slots. */
let sync: (() => void) | null = null;

const HEAD_COPY =
  "Your wallet, your recent ledger movement and the assets you hold, read straight from the " +
  "Prometheus ledger. Holdings are counted in units — nothing on this page is priced, because " +
  "the platform stores no market data.";

const TREND_COPY =
  "Illustrative shape · Prometheus records units in a ledger, not prices, so no trend is computed.";

const CHART_ALT =
  "Illustrative balance-trend shape — not portfolio data; Prometheus does not price holdings";

/** Display formatting only — ledger arithmetic stays in decimal strings. */
function fmt(value: string, digits = 4): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Full-precision display of a decimal string: group the integer, keep the
 *  fraction exactly as the API sent it. No rounding — this is not arithmetic. */
function amount(value: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function dateTimeLabel(value: string): string {
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The greeting's name: session first, e-mail local part after that. */
function firstName(): string {
  const identity = view.identity;
  if (!identity) return "there";
  const name = identity.name.trim();
  if (name) return name.split(/\s+/)[0];
  return identity.email.split("@")[0] || "there";
}

/** Sidebar account line: a real identity instead of the design's sample one. */
function identityCell(): string {
  const identity = view.identity;
  if (!identity) return "<b>Your account</b>sign in to personalise this desk";
  const name = identity.name.trim() || identity.email.split("@")[0] || "Your account";
  return `<b>${esc(name)}</b>${esc(identity.email || "signed in")}`;
}

/**
 * The four summary tiles. Each one is a figure the platform can measure; the
 * design's price-based tiles (total balance, 30-day change, invested,
 * available) are replaced rather than re-labelled, because none of them can be
 * derived without a price source.
 */
function kpiCell(index: number): string {
  const snapshot = view.snapshot;
  const activity = snapshot?.activity ?? null;
  const wallet = snapshot?.wallet ?? null;
  const pending = view.status === "loading";
  const failed = view.status === "error";

  if (index === 0) {
    const value = pending
      ? "…"
      : failed
        ? "—"
        : wallet
          ? wallet.status === "FROZEN"
            ? "Frozen"
            : "Active"
          : "None yet";
    const hint = pending
      ? "reading your ledger…"
      : failed
        ? "ledger unavailable"
        : wallet
          ? `opened ${dateLabel(wallet.createdAt)}`
          : "create one on the Wallet page";
    return `<small>Wallet</small><strong>${value}</strong><span>${esc(hint)}</span>`;
  }

  if (index === 1) {
    const composition = snapshot?.composition;
    const value = pending ? "…" : failed ? "—" : String(composition?.fundedAssetCount ?? 0);
    const hint = pending
      ? "counting your balances…"
      : failed
        ? "ledger unavailable"
        : `of ${composition?.assetCount ?? 0} assets tracked`;
    return `<small>Funded assets</small><strong>${value}</strong><span>${esc(hint)}</span>`;
  }

  if (index === 2) {
    const value = pending ? "…" : failed ? "—" : String(activity?.totalMovements ?? 0);
    const hint = pending
      ? "reading the ledger…"
      : failed
        ? "ledger unavailable"
        : activity
          ? `${activity.movementsLast30Days} in the last 30 days`
          : "no movements recorded yet";
    return `<small>Ledger movements</small><strong>${value}</strong><span>${esc(hint)}</span>`;
  }

  const value = pending ? "…" : failed ? "—" : activity ? dateLabel(activity.lastMovementAt) : "—";
  const hint = pending
    ? "checking the latest entry…"
    : failed
      ? "ledger unavailable"
      : activity
        ? `first entry ${dateLabel(activity.firstMovementAt)}`
        : "nothing recorded yet";
  return `<small>Latest movement</small><strong>${value}</strong><span>${esc(hint)}</span>`;
}

function placeholderRow(text: string): string {
  return (
    `<div class="allocation-row"><span>—</span>` +
    `<div class="allocation-track"></div><b>${esc(text)}</b></div>`
  );
}

/**
 * One row per holding. Units are not comparable across assets and are not
 * priced, so the bar cannot be a share of value: it shows the locked share of
 * that one balance, which is the only ratio the ledger derives for a holding.
 */
function allocationRows(): string {
  if (view.status === "loading") return placeholderRow("reading…");
  if (view.status === "error") return placeholderRow("unreadable");

  const holdings = view.snapshot?.holdings ?? [];
  if (holdings.length === 0) return placeholderRow("no holdings yet");

  const shown = holdings.slice(0, 6);
  const rows = shown.map((holding) => {
    const locked = holding.lockedShare;
    const pct = locked === null ? 0 : Math.round(locked * 100);
    const detail = locked === null ? "empty" : `${pct}% locked`;
    return (
      `<div class="allocation-row"><span>${esc(holding.asset.symbol)}</span>` +
      `<div class="allocation-track"><i style="width:${pct}%"></i></div>` +
      `<b>${detail}</b></div>`
    );
  });

  const rest = holdings.length - shown.length;
  if (rest > 0) {
    rows.push(
      `<div class="allocation-row"><span>+${rest}</span>` +
        `<div class="allocation-track"></div><b>see portfolio</b></div>`,
    );
  }
  return rows.join("");
}

const VERB: Record<TransactionTypeName, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  LOCK: "Locked",
  UNLOCK: "Unlocked",
  ADJUSTMENT: "Adjustment",
  BURN: "Burn",
};

/** Direction the ledger gives these types — never guessed from the amount. */
const CREDIT: TransactionTypeName[] = ["DEPOSIT", "TRANSFER_IN"];
const DEBIT: TransactionTypeName[] = ["WITHDRAWAL", "TRANSFER_OUT", "BURN"];

function activityRow(name: string, meta: string, value: string, positive: boolean): string {
  return (
    `<li><span><span class="activity-name">${esc(name)}</span>` +
    `<span class="activity-meta">${esc(meta)}</span></span>` +
    `<b class="activity-value${positive ? " positive" : ""}">${esc(value)}</b></li>`
  );
}

/** The latest ledger movements, newest first — real rows only. */
function activityRows(): string {
  if (view.status === "loading") return activityRow("Reading your ledger…", "", "…", false);
  if (view.status === "error") return activityRow("Movements could not be read", "", "—", false);
  if (view.recent.length === 0) {
    return activityRow("No movements yet", "This ledger has recorded nothing so far", "—", false);
  }

  return view.recent
    .slice(0, 6)
    .map((transaction) => {
      const positive = CREDIT.includes(transaction.type);
      const sign = positive ? "+" : DEBIT.includes(transaction.type) ? "−" : "";
      const symbol = transaction.asset.symbol;
      return activityRow(
        `${VERB[transaction.type]} ${symbol}`,
        `${dateTimeLabel(transaction.createdAt)} · ${transaction.status}`,
        `${sign}${fmt(transaction.amount)} ${symbol}`,
        positive,
      );
    })
    .join("");
}

/** The follow status in the copy engine's own words, shortened for a pill. */
const ELIGIBILITY_SHORT: Record<CopyEligibility, string> = {
  ELIGIBLE: "Copying",
  FOLLOW_NOT_ACTIVE: "Paused",
  STRATEGY_ARCHIVED: "Strategy archived",
  STRATEGY_NOT_ELIGIBLE: "Strategy not live",
  ALLOCATION_ROUNDED_TO_ZERO: "Rounds to zero",
  INSUFFICIENT_COPY_CASH: "Copy cash low",
  INSUFFICIENT_POSITION: "Nothing held to sell",
  PRICE_UNAVAILABLE: "Waiting on a price",
};

/** One followed trader: name, how much of each trade is mirrored, and status. */
function followRow(follow: CopyFollow): string {
  const copying = follow.status === "ACTIVE" && follow.eligibility === "ELIGIBLE";
  const label =
    follow.status === "ACTIVE"
      ? ELIGIBILITY_SHORT[follow.eligibility]
      : "Unfollowed";
  const pct = Math.max(1, Math.min(100, Math.round(Number(follow.allocationFraction) * 100)));
  const meta =
    follow.status === "ACTIVE"
      ? `${pct}% of each trade · followed ${dateLabel(follow.followedAt)}`
      : `stopped ${dateLabel(follow.unfollowedAt ?? follow.followedAt)}`;

  // A pending fill is a fact the copy engine reports: the expert has
  // committed a trade this follow's cursor has not reached yet. It is shown
  // only while the follow is active - a stopped follow's backlog is recorded
  // as refusals, not copies, so calling it "not yet copied" would promise
  // something that will not happen.
  const pending =
    follow.status === "ACTIVE" && follow.hasPendingEvents
      ? `<b class="follow-pill pending">Not yet copied</b>`
      : "";

  return (
    `<li><span><span class="activity-name">${esc(follow.strategyName)}</span>` +
    `<span class="activity-meta">${esc(meta)}</span></span>` +
    `<span class="follow-badges">${pending}` +
    `<b class="follow-pill${copying ? " on" : " off"}">${esc(label)}</b></span></li>`
  );
}

function followRows(): string {
  if (view.followsStatus === "loading") {
    return activityRow("Reading the traders you follow…", "", "…", false);
  }
  if (view.followsStatus === "error") {
    return activityRow("Your follows could not be read", "", "—", false);
  }
  if (view.follows.length === 0) {
    return activityRow(
      "You are not following anyone yet",
      "Open Copy trading to browse the catalogue",
      "—",
      false,
    );
  }
  return view.follows.slice(0, 6).map(followRow).join("");
}

/**
 * EMBER's price, exactly as the hub reports it. `baselinePriceInr` is
 * configuration — the platform publishes no market feed for EMBER — so the
 * card says so rather than implying a live quote. The USDT/INR rate is shown
 * only when the backend configured one; it is never used to derive a second
 * price here, because that would need a division the platform does not do.
 */
function emberQuote(): string {
  const pending = view.emberStatus === "loading";
  const failed = view.emberStatus === "error";
  const ember = view.ember;

  const price = pending ? "…" : failed || !ember ? "—" : `₹${amount(ember.baselinePriceInr)}`;
  const rate =
    !pending && !failed && ember?.usdtRateInr
      ? `<div class="ember-rate"><span>USDT / INR display rate</span>` +
        `<b>₹${amount(ember.usdtRateInr)}</b></div>`
      : "";

  return `<strong>${esc(price)}</strong><small>per EMBER</small>${rate}`;
}

/** The line under the heading — the only place the panel's honesty lives. */
function emberNote(): string {
  if (view.emberStatus === "loading") return "Reading the configured price…";
  if (view.emberStatus === "error") return "The EMBER price could not be read right now.";
  return "Configured hub price · a platform setting, not a live market quote";
}

function wireUserDashboard(root: HTMLElement): () => void {
  const chart = sel(root, ".home-chart");
  chart?.setAttribute("aria-label", CHART_ALT);

  const binder: Binder = bindText(root, [
    // Identity and page framing, from the session rather than the sample data.
    { at: ".home-head h1", value: () => `Good to see you, ${firstName()}` },
    { at: ".home-head p", value: () => HEAD_COPY },

    // The trend panel keeps its artwork but stops implying a measurement.
    { at: "#homePerformanceTitle + p", value: () => TREND_COPY },
    { at: ".home-balance", value: () => (view.status === "loading" ? "…" : "—") },

    // Holdings: units and a locked share, never a share of value.
    { at: "#homeAllocationTitle", value: () => "Holdings by asset" },
    {
      at: "#homeAllocationTitle + p",
      value: () => "Units held per asset · the bar shows how much of each balance is locked",
    },

    // EMBER's price: state first, then the source's own limits.
    { at: "#homeEmberNote", value: emberNote },
  ]);

  const htmlBinder: Binder = bindHtml(root, [
    { at: ".home-kpis", value: () => [0, 1, 2, 3].map(kpiCell).join("") },
    { at: ".allocation-list", value: allocationRows },
    { at: ".activity-list", value: activityRows },
    { at: "#homeFollowList", value: followRows },
    { at: "#homeEmberQuote", value: emberQuote },
    { at: ".me div", value: identityCell },
    {
      at: ".home-chart-note",
      value: () => `<i></i>Illustrative line · no price series exists on the platform`,
    },
  ]);

  const syncNow = (): void => {
    binder.apply();
    htmlBinder.apply();
  };
  sync = syncNow;

  /* ------------------------------------------------------------------ *
   * Reads. Failures surface in the design's own toast; the widgets keep
   * showing "…" / "—" rather than a number that was never read.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [snapshot, transactions] = await Promise.all([
        getPortfolio(),
        getTransactions({ limit: 6 }),
      ]);
      if (cancelled) return;
      view.snapshot = snapshot;
      view.recent = transactions.items;
      view.status = "ready";
      view.error = null;
      syncNow();
    } catch (error: unknown) {
      if (cancelled) return;
      view.status = "error";
      view.error = apiMessage(error);
      syncNow();
      toast(root, `Could not read your account — ${apiMessage(error)}`);
    }
  }

  /**
   * The two newer panels read on their own: a follow list or the configured
   * EMBER price being unavailable must not blank the ledger widgets that
   * already loaded, so neither failure is routed through `view.error`.
   */
  async function refreshFollows(): Promise<void> {
    try {
      const page = await listCopyFollows({ limit: 6 });
      if (cancelled) return;
      view.follows = page.items;
      view.followsStatus = "ready";
      syncNow();
    } catch {
      if (cancelled) return;
      view.followsStatus = "error";
      syncNow();
    }
  }

  async function refreshEmber(): Promise<void> {
    try {
      const ember = await getEmberHubOverview();
      if (cancelled) return;
      view.ember = ember;
      view.emberStatus = "ready";
      syncNow();
    } catch {
      if (cancelled) return;
      view.emberStatus = "error";
      syncNow();
    }
  }

  void refresh();
  void refreshFollows();
  void refreshEmber();

  return () => {
    cancelled = true;
    sync = null;
    cleanupAll(binder, htmlBinder)();
  };
}

export default function DashboardPage() {
  const { data: session } = useSession();

  // The greeting and the sidebar account line come from the session, which
  // resolves after the design has mounted: mirror it across and re-apply.
  useEffect(() => {
    view.identity = session?.user
      ? { name: session.user.name ?? "", email: session.user.email ?? "" }
      : null;
    sync?.();
  }, [session]);

  return (
    <>
      <DesignFrame design={designs.userDashboard} onReady={wireUserDashboard} />
      <style dangerouslySetInnerHTML={{ __html: DASHBOARD_OVERRIDES }} />
    </>
  );
}

/**
 * The one rule the reference design does not carry.
 *
 * The pending badge is new: the design had no copy engine to be late about,
 * so it has no rule for a follow whose expert has traded and whose copy has
 * not caught up. The amber is the design's own `--am` token, so the badge
 * follows the theme instead of carrying a colour of its own.
 */
const DASHBOARD_OVERRIDES = `
.follow-badges { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.follow-pill.pending {
  color: var(--am);
  background: color-mix(in srgb, var(--am) 14%, transparent);
  border-color: color-mix(in srgb, var(--am) 36%, transparent);
}
`;
