"use client";

import React, { useEffect } from "react";
import { useSession } from "next-auth/react";

import DesignFrame from "@/components/design/DesignFrame";
import RoleGate from "@/components/RoleGate";
import {
  getPortfolio,
  getStrategies,
  getTransactions,
  type PortfolioHolding,
  type PortfolioSnapshotResponse,
  type StrategySummary,
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
 * Expert portfolio — `designs/expert_portfolio.html` mounted standalone and
 * wired to the platform (the pattern is documented in `app/staking/page.tsx`).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - Real: the hero (assets tracked, movements and their 30-day count, wallet
 *    state, strategy count), the breakdown and holdings table (total, locked
 *    and available units per holding), the insight strip, the strategy panel
 *    (the caller's registry records with their true status) and the activity
 *    feed (real ledger movements) — from `GET portfolio`, `GET strategies` and
 *    `GET wallets/me/transactions`. The identity block is the session.
 *  - Labelled illustrative in place: the value chart (Prometheus stores no
 *    prices, so no value series, return or fee figure exists) and the strategy
 *    bars, whose width now means record status rather than capital the
 *    platform never allocates. The income panel keeps its own design note
 *    stating its figures are illustrative.
 *  - "Export portfolio statement" is captured in the CAPTURE phase: the design
 *    toasted "statement prepared", and the API exposes no such export.
 *
 * The design hides everything outside `.expert-portfolio-only` on this page:
 * its stylesheet keys off `<body data-page="portfolio">`, which the extractor
 * carries into `design.bodyAttrs`.
 */

type LoadStatus = "loading" | "ready" | "error";

interface DeskIdentity {
  name: string;
  email: string;
}

interface ExpertPortfolioView {
  status: LoadStatus;
  snapshot: PortfolioSnapshotResponse | null;
  strategies: StrategySummary[];
  recent: TransactionSummary[];
  identity: DeskIdentity | null;
  error: string | null;
}

const view: ExpertPortfolioView = {
  status: "loading",
  snapshot: null,
  strategies: [],
  recent: [],
  identity: null,
  error: null,
};

/** Set by the wiring so a session change arriving later re-applies the slots. */
let sync: (() => void) | null = null;

const HEAD_COPY =
  "Your capital as the Prometheus ledger records it: holdings, movements, composition and " +
  "strategy records. Units only — the platform stores no prices, so nothing here is valued.";

const CHART_SUB =
  "Illustrative shape · Prometheus stores no prices, so no value series, return or fee " +
  "figure exists.";

const BREAKDOWN_SUB = "Units held per asset · the bar shows how much of each balance is locked";

const BREAKDOWN_NOTE =
  "Units as recorded by the ledger · no price feed exists, so no value allocation can be computed.";

const STRATEGY_SUB = "Your strategy records from the registry · the platform allocates no capital";

const STRATEGY_NOTE =
  "Bars show record status, not capital · full = ACTIVE, dimmed = ARCHIVED.";

const HOLDINGS_SUB = "Units as recorded by the ledger · no prices, so no value or 30-day change";

const ACTIVITY_SUB = "Movements confirmed in the Prometheus ledger";

const IDENTITY_FALLBACK = "Your desk";

/** Columns the holdings table actually has after re-labelling. */
const HOLDING_COLUMNS = ["ASSET", "AVAILABLE", "LOCKED", "TOTAL"];

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

function displayName(): string {
  const identity = view.identity;
  if (!identity) return IDENTITY_FALLBACK;
  const name = identity.name.trim();
  if (name) return name;
  return identity.email.split("@")[0] || IDENTITY_FALLBACK;
}

function emailLine(): string {
  return view.identity?.email || "not signed in";
}

function identityCell(): string {
  const identity = view.identity;
  if (!identity) return "<b>Your account</b>sign in to personalise this desk";
  const name = identity.name.trim() || identity.email.split("@")[0] || "Your account";
  return `<b>${esc(name)}</b>${esc(identity.email || "signed in")}`;
}

function identityBlock(): string {
  const name = displayName();
  const initial = name.trim().charAt(0).toUpperCase() || "P";
  return (
    `<span class="pf-avatar">${esc(initial)}</span>` +
    `<span><b style="color:var(--ink)">${esc(name)}</b><br>${esc(emailLine())}</span>`
  );
}

/** The hero: assets tracked, movements and wallet state instead of a price. */
function heroBlock(): string {
  const snapshot = view.snapshot;
  const composition = snapshot?.composition;
  const activity = snapshot?.activity ?? null;
  const wallet = snapshot?.wallet ?? null;

  const value = figure("…", "—", String(composition?.assetCount ?? 0));
  const movements = figure("…", "—", String(activity?.totalMovements ?? 0));
  const last30 = figure("…", "—", String(activity?.movementsLast30Days ?? 0));
  const funded = figure("…", "—", String(composition?.fundedAssetCount ?? 0));
  const walletState = figure("…", "—", wallet ? (wallet.status === "FROZEN" ? "Frozen" : "Active") : "None yet");
  const strategies = figure("…", "—", String(view.strategies.length));

  return (
    `<section class="pf-hero"><div>` +
    `<span class="pf-value-label">Assets on record</span>` +
    `<strong class="pf-value">${esc(value)}</strong>` +
    `<div class="pf-change">Ledger movements <b>${esc(movements)}</b>` +
    `<span>${esc(last30)} in the last 30 days · units only, not priced</span></div>` +
    `</div><div class="pf-mini">` +
    `<div><span>Funded assets</span><b>${esc(funded)}</b></div>` +
    `<div><span>Wallet</span><b>${esc(walletState)}</b></div>` +
    `<div><span>Strategies</span><b>${esc(strategies)}</b></div>` +
    `</div></section>`
  );
}

/** Four figures under the illustrative chart, all of them ledger truth. */
function chartMetrics(): string {
  const activity = view.snapshot?.activity ?? null;
  const composition = view.snapshot?.composition;
  const cells: Array<[string, string]> = [
    ["Movements · all time", figure("…", "—", String(activity?.totalMovements ?? 0))],
    ["Latest movement", activity ? dateLabel(activity.lastMovementAt) : figure("…", "—", "—")],
    ["Funded assets", figure("…", "—", String(composition?.fundedAssetCount ?? 0))],
    ["Assets tracked", figure("…", "—", String(composition?.assetCount ?? 0))],
  ];
  return cells
    .map(([label, value]) => `<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`)
    .join("");
}

function breakdownRows(): string {
  if (view.status === "loading") {
    return `<div class="pf-asset"><span>Reading holdings <small>ledger</small></span>` +
      `<div class="pf-bar"><i style="width:0%"></i></div><b>…</b></div>`;
  }
  if (view.status === "error") {
    return `<div class="pf-asset"><span>Holdings unavailable <small>error</small></span>` +
      `<div class="pf-bar"><i style="width:0%"></i></div><b>—</b></div>`;
  }

  const holdings = view.snapshot?.holdings ?? [];
  if (holdings.length === 0) {
    return `<div class="pf-asset"><span>No holdings yet <small>wallet</small></span>` +
      `<div class="pf-bar"><i style="width:0%"></i></div><b>—</b></div>`;
  }

  return holdings
    .map((holding: PortfolioHolding) => {
      const pct = holding.lockedShare === null ? 0 : Math.round(holding.lockedShare * 100);
      return (
        `<div class="pf-asset"><span>${esc(holding.asset.symbol)} ` +
        `<small>${esc(holding.asset.kind)}</small></span>` +
        `<div class="pf-bar"><i style="width:${pct}%"></i></div>` +
        `<b>${esc(fmt(holding.total))}</b></div>`
      );
    })
    .join("");
}

/** Insight strip: the four things the platform can count, not simulated P&L. */
function insightCards(): string {
  const snapshot = view.snapshot;
  const activity = snapshot?.activity ?? null;
  const composition = snapshot?.composition;
  const wallet = snapshot?.wallet ?? null;
  const active = view.strategies.filter((s) => s.status === "ACTIVE").length;

  const cards: Array<[string, string, string]> = [
    [
      "Assets on record",
      figure("…", "—", String(composition?.fundedAssetCount ?? 0)),
      figure("…", "unavailable", `funded of ${composition?.assetCount ?? 0} tracked`),
    ],
    [
      "Ledger movements",
      figure("…", "—", String(activity?.totalMovements ?? 0)),
      activity
        ? `${activity.movementsLast30Days} in the last 30 days`
        : figure("…", "unavailable", "no movements recorded yet"),
    ],
    [
      "Wallet",
      figure("…", "—", wallet ? (wallet.status === "FROZEN" ? "Frozen" : "Active") : "None yet"),
      wallet ? `opened ${dateLabel(wallet.createdAt)}` : figure("…", "unavailable", "create one on the Wallet page"),
    ],
    [
      "Strategies",
      figure("…", "—", `${active} active`),
      figure("…", "registry unavailable", `${view.strategies.length} on record`),
    ],
  ];

  return cards
    .map(
      ([label, value, sub]) =>
        `<article class="pf-insight-card"><small>${esc(label)}</small>` +
        `<b>${esc(value)}</b><span>${esc(sub)}</span></article>`,
    )
    .join("");
}

/** Strategy records: the bar means status, because no capital is allocated. */
function strategyRows(): string {
  if (view.status === "loading") {
    return (
      `<div class="pf-strategy-row"><span>Reading your registry</span>` +
      `<div class="pf-strategy-bar"><i style="width:100%;opacity:.35"></i></div><b>…</b></div>`
    );
  }
  if (view.status === "error") {
    return (
      `<div class="pf-strategy-row"><span>Registry unavailable</span>` +
      `<div class="pf-strategy-bar"><i style="width:100%;opacity:.35"></i></div><b>—</b></div>`
    );
  }
  if (view.strategies.length === 0) {
    return (
      `<div class="pf-strategy-row"><span>No strategies yet</span>` +
      `<div class="pf-strategy-bar"><i style="width:100%;opacity:.2"></i></div><b>—</b></div>`
    );
  }

  return view.strategies
    .slice(0, 6)
    .map((strategy) => {
      const active = strategy.status === "ACTIVE";
      return (
        `<div class="pf-strategy-row"><span>${esc(strategy.name)}</span>` +
        `<div class="pf-strategy-bar"><i style="width:100%;opacity:${active ? 1 : 0.35}"></i></div>` +
        `<b>${esc(strategy.status)}</b></div>`
      );
    })
    .join("");
}

function holdingRows(): string {
  if (view.status === "loading") {
    return `<tr><td colspan="4" class="mu">Reading your holdings…</td></tr>`;
  }
  if (view.status === "error") {
    return `<tr><td colspan="4" class="mu">Holdings could not be read.</td></tr>`;
  }

  const holdings = view.snapshot?.holdings ?? [];
  if (holdings.length === 0) {
    return `<tr><td colspan="4" class="mu">No holdings yet — create a wallet to hold balances.</td></tr>`;
  }

  return holdings
    .map(
      (holding: PortfolioHolding) =>
        `<tr><td class="coin">${esc(holding.asset.symbol)}<small>${esc(holding.asset.name)}</small></td>` +
        `<td class="mono">${esc(fmt(holding.available))}</td>` +
        `<td class="mono">${esc(fmt(holding.locked))}</td>` +
        `<td class="mono">${esc(fmt(holding.total))}</td></tr>`,
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
    return `<div class="pf-event"><span>Reading your ledger…</span><b>…</b></div>`;
  }
  if (view.status === "error") {
    return `<div class="pf-event"><span>Movements could not be read</span><b>—</b></div>`;
  }
  if (view.recent.length === 0) {
    return `<div class="pf-event"><span>No movements recorded yet</span><b>—</b></div>`;
  }

  return view.recent
    .slice(0, 6)
    .map((transaction) => {
      const positive = CREDIT.includes(transaction.type);
      const sign = positive ? "+" : DEBIT.includes(transaction.type) ? "−" : "";
      const symbol = transaction.asset.symbol;
      return (
        `<div class="pf-event"><span>${esc(VERB[transaction.type])} ${esc(symbol)} · ` +
        `${esc(dateTimeLabel(transaction.createdAt))}</span>` +
        `<b${positive ? ' class="up"' : ""}>${esc(`${sign}${fmt(transaction.amount)} ${symbol}`)}</b></div>`
      );
    })
    .join("");
}

function wireExpertPortfolio(root: HTMLElement): () => void {
  const subs = all(root, ".expert-portfolio-only .pf-sub");
  const notes = all(root, ".expert-portfolio-only .pf-portfolio-note");
  const metricBlocks = all(root, ".expert-portfolio-only .pf-metrics");
  const holdingColumns = all(root, ".expert-portfolio-only .pf-table thead th");

  /** Slots by index, so a panel that keeps the design's own copy is untouched. */
  const textAt = (elements: Element[], index: number, value: () => string) =>
    elements[index] ? [{ at: elements[index] as Element, value }] : [];

  const binder: Binder = bindText(root, [
    { at: ".expert-portfolio-only .pf-head p", value: () => HEAD_COPY },
    ...textAt(subs, 0, () => CHART_SUB),
    ...textAt(subs, 1, () => BREAKDOWN_SUB),
    ...textAt(subs, 2, () => STRATEGY_SUB),
    // subs[3] — the income panel — keeps the design's own illustrative note.
    ...textAt(subs, 4, () => HOLDINGS_SUB),
    ...textAt(subs, 5, () => ACTIVITY_SUB),
    ...textAt(notes, 0, () => BREAKDOWN_NOTE),
    ...textAt(notes, 1, () => STRATEGY_NOTE),
    ...holdingColumns.map((element, index) => ({
      at: element,
      value: () => HOLDING_COLUMNS[index] ?? "",
    })),
  ]);

  const htmlBinder: Binder = bindHtml(root, [
    { at: ".expert-portfolio-only .pf-identity", value: identityBlock },
    { at: ".expert-portfolio-only .pf-hero", value: heroBlock },
    { at: ".me div", value: identityCell },
    ...metricBlocks.slice(0, 1).map((element) => ({ at: element, value: chartMetrics })),
    { at: ".expert-portfolio-only .pf-breakdown", value: breakdownRows },
    { at: ".expert-portfolio-only .pf-insights", value: insightCards },
    { at: ".expert-portfolio-only .pf-strategy-mix", value: strategyRows },
    { at: ".expert-portfolio-only .pf-table tbody", value: holdingRows },
    { at: ".expert-portfolio-only .pf-activity", value: activityRows },
  ]);

  const syncNow = (): void => {
    binder.apply();
    htmlBinder.apply();
  };
  sync = syncNow;

  /**
   * The design toasted "Portfolio statement prepared · demo preview" and the
   * API exposes no statement export, so the click is taken before its handler
   * and says what is really possible.
   */
  const onExportClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest("#pfExport") : null;
    if (!target || !root.contains(target)) return;
    event.stopPropagation();
    toast(
      root,
      "Statement export is a demo action in this design — the Prometheus API exposes no statement export.",
    );
  };

  root.addEventListener("click", onExportClick, true);

  /* ------------------------------------------------------------------ *
   * Reads. Failures surface in the design's own toast; the widgets keep
   * showing "…" / "—" rather than a number that was never read.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [snapshot, strategies, transactions] = await Promise.all([
        getPortfolio(),
        getStrategies({ page: 1, limit: 50 }),
        getTransactions({ limit: 6 }),
      ]);
      if (cancelled) return;
      view.snapshot = snapshot;
      view.strategies = strategies.items;
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
    root.removeEventListener("click", onExportClick, true);
    cleanupAll(binder, htmlBinder)();
  };
}

export default function ExpertPortfolioPage() {
  const { data: session } = useSession();

  // The identity block and the sidebar account line come from the session,
  // which resolves after the design has mounted: mirror it and re-apply.
  useEffect(() => {
    view.identity = session?.user
      ? { name: session.user.name ?? "", email: session.user.email ?? "" }
      : null;
    sync?.();
  }, [session]);

  return (
    <RoleGate roles={["EXPERT_TRADER", "PLATFORM_ADMIN"]}>
      <DesignFrame design={designs.expertPortfolio} onReady={wireExpertPortfolio} />
    </RoleGate>
  );
}
