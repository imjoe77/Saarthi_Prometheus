"use client";

import React, { useEffect } from "react";
import { useSession } from "next-auth/react";

import DesignFrame from "@/components/design/DesignFrame";
import {
  getPortfolio,
  getTransactions,
  type PortfolioHolding,
  type PortfolioSnapshotResponse,
  type TransactionSummary,
  type TransactionTypeName,
} from "@/lib/api-client";
import { designs } from "@/lib/design/generated";
import {
  all,
  apiMessage,
  bindHtml,
  bindText,
  cleanupAll,
  toast,
  type Binder,
} from "@/lib/design/wire";

/**
 * Personal Portfolio — `designs/user_portfolio.html` mounted standalone and
 * wired to the ledger (the design-integration pattern is documented in
 * `app/staking/page.tsx`).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - Real: the four pass cards (assets tracked, funded assets, movements and
 *    their 30-day count, wallet state), the assets table (total / locked /
 *    available units per holding) and the activity table (the caller's real
 *    ledger movements) all come from `GET portfolio` and
 *    `GET wallets/me/transactions`. The sidebar account line is the session.
 *  - Deliberately absent: value, allocation share, 30-day change and any
 *    performance figure. Prometheus stores no prices, so the design's
 *    "$12,480", "+5.26%" and per-asset valuations cannot be derived. The
 *    columns are re-labelled to the three quantities the ledger does hold
 *    (total, locked, available units) and the copy says so in place.
 *  - The design's welcome-questionnaire module is gone from this view: it
 *    duplicated the real, backend-backed wizard at `/onboarding`, which is the
 *    only place preferences are collected and summarised.
 *
 * The other two workspaces in the same file (Expert Trader, Liquidity
 * Provider) stay hidden: the extractor carries `<body data-view="user-view">`
 * into `design.bodyAttrs`, so the design's own switcher picks this view before
 * any script runs.
 */

type LoadStatus = "loading" | "ready" | "error";

interface PortfolioIdentity {
  name: string;
  email: string;
}

interface PortfolioViewState {
  status: LoadStatus;
  snapshot: PortfolioSnapshotResponse | null;
  recent: TransactionSummary[];
  identity: PortfolioIdentity | null;
  error: string | null;
}

const view: PortfolioViewState = {
  status: "loading",
  snapshot: null,
  recent: [],
  identity: null,
  error: null,
};

/** Set by the wiring so a session change arriving later re-applies the slots. */
let sync: (() => void) | null = null;

const INTRO_COPY =
  "Your holdings, your movements and how they are composed, read from the Prometheus ledger. " +
  "Units only: the platform stores no prices, so nothing on this page is valued and no " +
  "performance figure is shown.";

const ASSETS_HINT =
  "Units as recorded by the ledger · Prometheus keeps no prices, so value and 30-day change " +
  "cannot be shown.";

const ACTIVITY_HINT = "The latest movements in your wallet ledger.";

const ASSET_COLUMNS = ["Asset", "Total units", "Locked", "Available"];

/** Display formatting only — ledger arithmetic stays in decimal strings. */
function fmt(value: string, digits = 4): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
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

/** "…" while loading, "—" when a read failed — never a number that was not read. */
function figure(pending: string, failed: string, value: string): string {
  if (view.status === "loading") return pending;
  if (view.status === "error") return failed;
  return value;
}

function ticket(index: number): string {
  const snapshot = view.snapshot;
  const composition = snapshot?.composition;
  const activity = snapshot?.activity ?? null;
  const wallet = snapshot?.wallet ?? null;
  const holdings = snapshot?.holdings ?? [];

  let logo = "P";
  let type = "Portfolio pass";
  let label = "";
  let value = "…";
  let change = "…";
  let changeLabel = "";
  let details: Array<[string, string]> = [];
  let code = "PROMETHEUS LEDGER";
  let caption = "Read from your portfolio snapshot";

  if (index === 0) {
    label = "Assets on record";
    value = figure("…", "—", String(composition?.assetCount ?? 0));
    change = figure("…", "—", `${composition?.fundedAssetCount ?? 0} funded`);
    changeLabel = "of the assets tracked";
    details = [
      ["Wallet", wallet ? (wallet.status === "FROZEN" ? "Frozen" : "Active") : "None yet"],
      ["Opened", wallet ? dateLabel(wallet.createdAt) : "—"],
    ];
    code = activity ? `AS OF ${dateLabel(snapshot?.generatedAt ?? "")}` : "EMPTY LEDGER";
  } else if (index === 1) {
    logo = "↗";
    type = "Ledger";
    label = "Movements · all time";
    value = figure("…", "—", String(activity?.totalMovements ?? 0));
    change = figure("…", "—", String(activity?.movementsLast30Days ?? 0));
    changeLabel = "in the last 30 days";
    details = [
      ["First entry", activity ? dateLabel(activity.firstMovementAt) : "—"],
      ["Latest entry", activity ? dateLabel(activity.lastMovementAt) : "—"],
    ];
    code = "RECORDED ACTIVITY";
    caption = "From the ledger's activity summary";
  } else if (index === 2) {
    logo = "◈";
    type = "Composition";
    label = "Funded assets";
    value = figure("…", "—", String(composition?.fundedAssetCount ?? 0));
    change = figure("…", "—", String(composition?.byKind.TOKEN ?? 0));
    changeLabel = "tokens · counted by category, not value";
    details = [
      ["Stablecoins", String(composition?.byKind.STABLECOIN ?? 0)],
      ["Fiat", String(composition?.byKind.FIAT ?? 0)],
    ];
    code = `${composition?.assetCount ?? 0} ASSETS · TRACKED`;
    caption = "Categories are counts, not shares of value";
  } else {
    logo = "◎";
    type = "Wallet";
    label = "Wallet status";
    value = figure("…", "—", wallet ? (wallet.status === "FROZEN" ? "Frozen" : "Active") : "None yet");
    change = figure("…", "—", String(holdings.filter((h) => h.lockedShare !== null && h.lockedShare > 0).length));
    changeLabel = "balances with a locked part";
    details = [
      ["Holdings", String(holdings.length)],
      ["Prices", "none stored"],
    ];
    code = "UNITS ONLY";
    caption = "Prometheus stores no prices";
  }

  return (
    `<article class="user-ticket-wrap" tabindex="0"><div class="user-ticket">` +
    `<div class="user-ticket-top"><div class="user-ticket-head">` +
    `<span class="user-ticket-brand"><span class="user-ticket-logo">${logo}</span>PROMETHEUS</span>` +
    `<span class="user-ticket-type">${esc(type)}</span></div>` +
    `<span class="user-ticket-label">${esc(label)}</span>` +
    `<strong class="user-ticket-value">${esc(value)}</strong>` +
    `<div class="user-ticket-change"><b>${esc(change)}</b><span>${esc(changeLabel)}</span></div>` +
    `<div class="user-ticket-details">` +
    details
      .map(
        ([name, detail]) => `<div><span>${esc(name)}</span><b>${esc(detail)}</b></div>`,
      )
      .join("") +
    `</div></div>` +
    `<div class="user-ticket-stub"><div><div class="user-ticket-code">${esc(code)}</div>` +
    `<div class="user-ticket-caption">${esc(caption)}</div></div>` +
    `<div class="user-ticket-bars" aria-hidden="true"></div></div></div></article>`
  );
}

function assetRows(): string {
  if (view.status === "loading") {
    return `<tr><td colspan="4" class="mu">Reading your holdings…</td></tr>`;
  }
  if (view.status === "error") {
    return `<tr><td colspan="4" class="mu">Holdings could not be read.</td></tr>`;
  }

  const holdings = view.snapshot?.holdings ?? [];
  if (holdings.length === 0) {
    return `<tr><td colspan="4" class="mu">No holdings yet — a portfolio is a view of a wallet, and you do not have one.</td></tr>`;
  }

  return holdings
    .map((holding: PortfolioHolding) =>
      `<tr><td><b>${esc(holding.asset.name)}</b><br>` +
      `<span class="mu">${esc(holding.asset.symbol)} · ${esc(holding.asset.kind)}</span></td>` +
      `<td>${esc(fmt(holding.total))}</td>` +
      `<td>${esc(fmt(holding.locked))}</td>` +
      `<td>${esc(fmt(holding.available))}</td></tr>`,
    )
    .join("");
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

function activityRows(): string {
  if (view.status === "loading") {
    return `<tr><td colspan="2" class="mu">Reading your ledger…</td></tr>`;
  }
  if (view.status === "error") {
    return `<tr><td colspan="2" class="mu">Movements could not be read.</td></tr>`;
  }
  if (view.recent.length === 0) {
    return `<tr><td colspan="2" class="mu">No movements recorded yet.</td></tr>`;
  }

  return view.recent
    .slice(0, 8)
    .map((transaction) => {
      const positive = CREDIT.includes(transaction.type);
      const sign = positive ? "+" : DEBIT.includes(transaction.type) ? "−" : "";
      const symbol = transaction.asset.symbol;
      const value = `${sign}${fmt(transaction.amount)} ${symbol}`;
      return (
        `<tr><td><b>${esc(VERB[transaction.type])} ${esc(symbol)}</b><br>` +
        `<span class="mu">${esc(dateTimeLabel(transaction.createdAt))} · ${esc(transaction.status)}</span></td>` +
        `<td style="text-align:right"${positive ? ' class="up"' : ""}>${esc(value)}</td></tr>`
      );
    })
    .join("");
}

/** Sidebar account line: a real identity instead of the design's sample one. */
function identityCell(): string {
  const identity = view.identity;
  if (!identity) return "<b>Your account</b>sign in to personalise this desk";
  const name = identity.name.trim() || identity.email.split("@")[0] || "Your account";
  return `<b>${esc(name)}</b>${esc(identity.email || "signed in")}`;
}

function wireUserPortfolio(root: HTMLElement): () => void {
  const assetColumns = all(root, "#user-view #assets thead th");

  const binder: Binder = bindText(root, [
    { at: "#user-view .role-intro p", value: () => INTRO_COPY },
    { at: "#user-view #assets .hint", value: () => ASSETS_HINT },
    { at: "#user-view #activity .hint", value: () => ACTIVITY_HINT },
    // The design prices every column; the ledger holds units, so the columns
    // are re-labelled to what the rows below actually contain.
    ...assetColumns.map((element, index) => ({
      at: element,
      value: () => ASSET_COLUMNS[index] ?? "",
    })),
  ]);

  const htmlBinder: Binder = bindHtml(root, [
    { at: "#user-view .user-portfolio-cards", value: () => [0, 1, 2, 3].map(ticket).join("") },
    { at: "#user-view #assets tbody", value: assetRows },
    { at: "#user-view #activity tbody", value: activityRows },
    { at: ".me div", value: identityCell },
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
        getTransactions({ limit: 8 }),
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
      toast(root, `Could not read your portfolio — ${apiMessage(error)}`);
    }
  }

  void refresh();

  return () => {
    cancelled = true;
    sync = null;
    cleanupAll(binder, htmlBinder)();
  };
}

export default function PortfolioPage() {
  const { data: session } = useSession();

  // The sidebar account line comes from the session, which resolves after the
  // design has mounted: mirror it across and re-apply.
  useEffect(() => {
    view.identity = session?.user
      ? { name: session.user.name ?? "", email: session.user.email ?? "" }
      : null;
    sync?.();
  }, [session]);

  return <DesignFrame design={designs.userPortfolio} onReady={wireUserPortfolio} />;
}
