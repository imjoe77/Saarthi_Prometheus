"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import DesignFrame from "@/components/design/DesignFrame";
import RoleGate from "@/components/RoleGate";
import {
  getEmberStakePositions,
  getEmberStakingConfig,
  getPortfolio,
  getStrategies,
  getTransactions,
  type EmberStakePosition,
  type EmberStakingConfig,
  type PortfolioSnapshotResponse,
  type StrategySummary,
  type TransactionSummary,
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
 * The Expert Trader desk — `designs/expert_dashboard.html` mounted standalone
 * and wired to the platform (the pattern is documented in
 * `app/staking/page.tsx`).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - Real, read from the APIs: the strategy cards and the "N of M active"
 *    badge are the caller's own strategy registry (`GET strategies`); the four
 *    summary tiles are strategies, funded assets, ledger movements and the last
 *    movement date (`GET portfolio`); the staked-coins table is the caller's
 *    EMBER positions with the configured APR marked as simulated
 *    (`GET ember-staking/positions`, `GET ember-staking/config`); the ledger
 *    table and its counters are real wallet movements
 *    (`GET wallets/me/transactions`); the identity lines are the session.
 *  - Real mutation: "＋ New strategy" opens `/expert/strategies/new`, and
 *    clicking a strategy card opens the Strategies page where the record's
 *    lifecycle is changed. The design's own toggle wrote into mock state, so
 *    it is never rendered.
 *  - Labelled illustrative, in place: the equity chart and its Sharpe /
 *    Sortino / drawdown strip, the P&L calendar, the achievements carousel,
 *    the desk-breakdown donut and its risk badges, and the whole open-positions
 *    panel (Prometheus keeps no position book — "Close All Profitable" and
 *    "Hedge All" are captured before the design can claim an execution).
 *
 * The Liquidity Provider workspace in the same file stays hidden: the
 * extractor carries `<body data-view="expert-view">` into `design.bodyAttrs`,
 * so the design's own workspace switcher picks this view before any script runs.
 */

type LoadStatus = "loading" | "ready" | "error";

interface DeskIdentity {
  name: string;
  email: string;
}

interface DeskView {
  status: LoadStatus;
  strategies: StrategySummary[];
  snapshot: PortfolioSnapshotResponse | null;
  recent: TransactionSummary[];
  stakes: EmberStakePosition[];
  config: EmberStakingConfig | null;
  identity: DeskIdentity | null;
  error: string | null;
}

const view: DeskView = {
  status: "loading",
  strategies: [],
  snapshot: null,
  recent: [],
  stakes: [],
  config: null,
  identity: null,
  error: null,
};

/** Set by the wiring so a session change arriving later re-applies the slots. */
let sync: (() => void) | null = null;

/** Set by the page so the wiring can route to the strategy pages. */
let navigate: ((href: string) => void) | null = null;

const STRATEGY_SUB =
  "Your strategy records from the registry · open the Strategies page to create, archive or " +
  "re-activate one — this desk does not trade them.";

const POSITION_SUB =
  "Illustrative panel · Prometheus keeps no position book, so there is no leverage, mark or " +
  "P&L to report here.";

const LEDGER_SUB =
  "Movements confirmed in the Prometheus ledger · execution route, price and proof columns are " +
  "not measured by the platform.";

const PERFORMANCE_SUB =
  "Illustrative demo series · Prometheus has no price feed, so no equity curve, benchmark or " +
  "P&L trace exists.";

const CALENDAR_META = "Illustrative sample · Prometheus records no profit or loss";

const DESK_BREAKDOWN_SUB =
  "Illustrative composite — the platform measures no risk score, hedge or beta. Staked rows " +
  "below are ledger truth.";

const SENT_NOTE =
  "<span>Illustrative · no hedge is executed</span><span>Beta <b>not measured</b></span>";

const POSITIONS_NOTE =
  "No position book exists · the platform records ledger movements, not open leverage";

const STRATEGY_CARD_LIMIT = 8;

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

function displayName(): string {
  const identity = view.identity;
  if (!identity) return "Your desk";
  const name = identity.name.trim();
  if (name) return name;
  return identity.email.split("@")[0] || "Your desk";
}

function emailLine(): string {
  return view.identity?.email || "not signed in";
}

/** Name block for the page heading and the hero card (highlight span kept). */
function nameCell(): string {
  return `<span class="name-highlight">${esc(displayName())}</span>`;
}

/** Sidebar account line: a real identity instead of the design's sample one. */
function identityCell(): string {
  const identity = view.identity;
  if (!identity) return "<b>Your account</b>sign in to personalise this desk";
  const name = identity.name.trim() || identity.email.split("@")[0] || "Your account";
  return `<b>${esc(name)}</b>${esc(identity.email || "signed in")}`;
}

function heroBadges(): string {
  return (
    `<span class="bd">EXPERT TRADER</span>` +
    `<span class="bd g">SIGNED IN</span>` +
    `<span class="bd u">LEDGER READ</span>`
  );
}

/* ------------------------------------------------------------------ *
 * Summary tiles — four figures the platform can measure, replacing the
 * design's equity / P&L / risk-utilisation / capital tiles, none of
 * which have a source in Prometheus.
 * ------------------------------------------------------------------ */
const KPI_LABELS = ["Strategies", "Funded assets", "Ledger movements", "Latest movement"];

function kpiCell(index: number): string {
  const composition = view.snapshot?.composition;
  const activity = view.snapshot?.activity ?? null;
  const pending = view.status === "loading";
  const failed = view.status === "error";

  let value = "—";
  let hint = failed ? "ledger unavailable" : "…";

  if (index === 0) {
    value = pending ? "…" : failed ? "—" : String(view.strategies.length);
    hint = pending
      ? "reading your registry…"
      : failed
        ? "registry unavailable"
        : `${view.strategies.filter((s) => s.status === "ACTIVE").length} active · ` +
          `${view.strategies.filter((s) => s.status === "ARCHIVED").length} archived`;
  } else if (index === 1) {
    value = pending ? "…" : failed ? "—" : String(composition?.fundedAssetCount ?? 0);
    hint = pending
      ? "counting balances…"
      : failed
        ? "ledger unavailable"
        : `of ${composition?.assetCount ?? 0} assets tracked`;
  } else if (index === 2) {
    value = pending ? "…" : failed ? "—" : String(activity?.totalMovements ?? 0);
    hint = pending
      ? "reading the ledger…"
      : failed
        ? "ledger unavailable"
        : activity
          ? `${activity.movementsLast30Days} in the last 30 days`
          : "no movements recorded yet";
  } else {
    value = pending ? "…" : failed ? "—" : activity ? dateLabel(activity.lastMovementAt) : "—";
    hint = pending
      ? "checking the latest entry…"
      : failed
        ? "ledger unavailable"
        : activity
          ? `first entry ${dateLabel(activity.firstMovementAt)}`
          : "nothing recorded yet";
  }

  return (
    `<div class="card"><span class="sm">${KPI_LABELS[index]}</span>` +
    `<b>${esc(value)}</b><span>${esc(hint)}</span></div>`
  );
}

/* ------------------------------------------------------------------ *
 * Strategy cards — the registry's own records, in the design's card.
 * ------------------------------------------------------------------ */
function strategyCard(strategy: StrategySummary): string {
  const active = strategy.status === "ACTIVE";
  const subtitle = strategy.description
    ? `${strategy.visibility} · ${strategy.description}`
    : `${strategy.visibility} · created ${dateLabel(strategy.createdAt)}`;

  return (
    `<div class="card sg" role="listitem" style="--c:var(--gold)">` +
    `<div class="sg-h"><span class="sg-ic" aria-hidden="true">◆</span>` +
    `<div class="sg-id"><b>${esc(strategy.name)}</b><small>${esc(subtitle)}</small></div></div>` +
    `<div class="sg-m">` +
    `<div><small>Status</small><b>${strategy.status}</b></div>` +
    `<div><small>Visibility</small><b>${strategy.visibility}</b></div>` +
    `<div><small>Created</small><b>${esc(dateLabel(strategy.createdAt))}</b></div>` +
    `<div><small>Updated</small><b>${esc(dateLabel(strategy.updatedAt))}</b></div>` +
    `</div>` +
    `<div class="sg-f"><span class="sg-pill${active ? " live" : ""}">${strategy.status}</span>` +
    `<span>on record · click to manage</span></div>` +
    `</div>`
  );
}

function strategyCards(): string {
  if (view.status === "loading") {
    return (
      `<div class="card sg" role="listitem"><div class="sg-h">` +
      `<div class="sg-id"><b>Reading your strategy registry…</b><small>GET /strategies</small></div>` +
      `</div></div>`
    );
  }
  if (view.status === "error") {
    return (
      `<div class="card sg" role="listitem"><div class="sg-h">` +
      `<div class="sg-id"><b>Strategies could not be read</b><small>${esc(view.error ?? "")}</small></div>` +
      `</div></div>`
    );
  }
  if (view.strategies.length === 0) {
    return (
      `<div class="card sg" role="listitem"><div class="sg-h">` +
      `<div class="sg-id"><b>No strategies yet</b><small>Use “＋ New strategy” to create one</small></div>` +
      `</div></div>`
    );
  }
  return view.strategies.slice(0, STRATEGY_CARD_LIMIT).map(strategyCard).join("");
}

function strategyBadge(): string {
  if (view.status === "loading") return "reading…";
  if (view.status === "error") return "unavailable";
  const active = view.strategies.filter((s) => s.status === "ACTIVE").length;
  return `${active} of ${view.strategies.length} active`;
}

/* ------------------------------------------------------------------ *
 * Staked coins: real positions with the configured (simulated) APR.
 * ------------------------------------------------------------------ */
function stakedRows(): string {
  if (view.status === "loading") {
    return `<tr><td colspan="5" class="mu">Reading your staking positions…</td></tr>`;
  }
  if (view.status === "error") {
    return `<tr><td colspan="5" class="mu">Staking positions could not be read.</td></tr>`;
  }
  if (view.stakes.length === 0) {
    return `<tr><td colspan="5" class="mu">No EMBER staking position on record yet.</td></tr>`;
  }

  const apr = view.config ? `${view.config.aprPercent}% APR · simulated` : "APR not loaded";
  return view.stakes
    .slice(0, 6)
    .map((position) => {
      const locked = position.status === "ACTIVE";
      const state = locked
        ? `LOCKED UNTIL ${dateLabel(position.lockUntil)}`
        : `UNSTAKED ${position.unstakedAt ? dateLabel(position.unstakedAt) : ""}`.trim();
      return (
        `<tr><td>EMBER</td><td>${esc(fmt(position.amount))}</td>` +
        `<td class="mu">no price feed</td><td class="up">${esc(apr)}</td>` +
        `<td${locked ? ' style="color:var(--am);font-weight:700"' : ' class="mu"'}>${esc(state)}</td></tr>`
      );
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Ledger table: the caller's real movements under the design's columns.
 * ------------------------------------------------------------------ */
function ledgerRow(transaction: TransactionSummary): string {
  const symbol = transaction.asset.symbol;
  return (
    `<tr><td>${esc(dateTimeLabel(transaction.createdAt))}</td>` +
    `<td><div class="tx-pair"><div><div class="tx-rr"><b>${esc(transaction.type)} ${esc(symbol)}</b>` +
    `<span class="tx-k">${esc(transaction.status)}</span></div></div></div></td>` +
    `<td class="mu">—</td><td class="mu">—</td><td class="r mu">—</td>` +
    `<td class="r">${esc(fmt(transaction.amount))} ${esc(symbol)}</td>` +
    `<td class="r mu">—</td><td class="r mu">—</td></tr>`
  );
}

function ledgerRows(): string {
  if (view.status === "loading") {
    return `<tr><td colspan="8" class="mu">Reading your ledger…</td></tr>`;
  }
  if (view.status === "error") {
    return `<tr><td colspan="8" class="mu">The ledger could not be read.</td></tr>`;
  }
  if (view.recent.length === 0) {
    return `<tr><td colspan="8" class="mu">No movements recorded yet.</td></tr>`;
  }
  return view.recent.slice(0, 8).map(ledgerRow).join("");
}

function ledgerChips(): Array<[string, string]> {
  const activity = view.snapshot?.activity ?? null;
  const wallet = view.snapshot?.wallet ?? null;
  if (view.status === "loading") {
    return [["Movements · all time", "…"], ["Last 30 days", "…"], ["Wallet", "…"]];
  }
  if (view.status === "error") {
    return [["Movements · all time", "—"], ["Last 30 days", "—"], ["Wallet", "—"]];
  }
  return [
    ["Movements · all time", String(activity?.totalMovements ?? 0)],
    ["Last 30 days", String(activity?.movementsLast30Days ?? 0)],
    ["Wallet", wallet ? (wallet.status === "FROZEN" ? "Frozen" : "Active") : "None yet"],
  ];
}

function wireExpertDashboard(root: HTMLElement): () => void {
  const handleLines = all(root, ".hero .mono");
  const txSubs = all(root, ".tx-sub");
  const txBadges = all(root, ".tx-bdg");
  // Captured before the first application, so the label cannot gain a second
  // " · illustrative" when a slot is re-applied.
  const ribLabels = all(root, ".rib .sm").map((element) => ({
    element,
    label: element.textContent ?? "",
  }));
  const chipSlots = all(root, "#lchips .tx-chip");

  const binder: Binder = bindText(root, [
    // Page framing: what is real on this desk and what is not.
    { at: ".hd .mu.mono", value: () => PERFORMANCE_SUB },
    { at: "#calMeta", value: () => CALENDAR_META },
    { at: "#calNet", value: () => "—" },
    { at: "#alloc h3 + div", value: () => DESK_BREAKDOWN_SUB },
    { at: "#tid", value: () => emailLine() },
    { at: "#cid", value: () => "Copy e-mail" },
    { at: ".idbox > small", value: () => "Signed-in account" },

    // Identity: the session, never the design's sample trader.
    ...handleLines.map((element, index) => ({
      at: element,
      value: () =>
        index === 0 ? emailLine() : `${emailLine()} · on the Prometheus registry`,
    })),

    // Panel captions and badges, index-ordered: strategies, positions, ledger.
    ...txSubs.slice(0, 1).map((element) => ({ at: element, value: () => STRATEGY_SUB })),
    ...txSubs.slice(1, 2).map((element) => ({ at: element, value: () => POSITION_SUB })),
    ...txSubs.slice(2, 3).map((element) => ({ at: element, value: () => LEDGER_SUB })),
    { at: "#sgN", value: strategyBadge },
    ...txBadges.slice(1, 2).map((element) => ({ at: element, value: () => "demo · no position book" })),
    ...txBadges.slice(2, 3).map((element) => ({ at: element, value: () => "from the ledger" })),

    // The performance strip is sampled by the design, so it says so.
    ...ribLabels.map(({ element, label }) => ({
      at: element,
      value: () => `${label} · illustrative`,
    })),
  ]);

  const htmlBinder: Binder = bindHtml(root, [
    { at: ".person-name", value: nameCell },
    { at: ".nm", value: nameCell },
    { at: ".badges", value: heroBadges },
    { at: ".me div", value: identityCell },
    { at: ".kpi", value: () => [0, 1, 2, 3].map(kpiCell).join("") },
    { at: "#sgs", value: strategyCards },
    { at: "#alloc .tw tbody", value: stakedRows },
    { at: ".sent", value: () => SENT_NOTE },
    { at: "#psum", value: () => POSITIONS_NOTE },
    { at: "#pb", value: () => `<tr><td colspan="9" class="mu">${POSITIONS_NOTE}</td></tr>` },
    { at: "#lb", value: ledgerRows },
    ...chipSlots.map((element, index) => ({
      at: element,
      value: () => {
        const [label, value] = ledgerChips()[index] ?? ["—", "—"];
        return `<small>${esc(label)}</small><b>${esc(value)}</b>`;
      },
    })),
  ]);

  const syncNow = (): void => {
    binder.apply();
    htmlBinder.apply();
  };
  sync = syncNow;

  const closest = (event: Event, selector: string): Element | null => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    return target && root.contains(target) ? target : null;
  };

  /**
   * The design's own strategy toggle wrote into a closure-local array and
   * toasted "paused · legs held" — no such capability exists, so the cards
   * carry the registry's records instead. A click anywhere on the panel opens
   * the Strategies page, where the lifecycle really is changed, and the
   * design's handlers are stopped first so they cannot write mock state back.
   */
  const onStrategyPanelClick = (event: Event): void => {
    if (!closest(event, "#sgs")) return;
    event.stopPropagation();
    if (closest(event, "#sgs .sg")) navigate?.("/expert/strategies");
  };

  /** "＋ New strategy" is a real route; the design toasted a demo stub. */
  const onNewStrategyClick = (event: Event): void => {
    if (!closest(event, "#sgAdd")) return;
    event.stopPropagation();
    navigate?.("/expert/strategies/new");
  };

  /**
   * "Close All Profitable" and "Hedge All" would execute mock trades in the
   * design. There is no position book behind them, so the click is taken in
   * the CAPTURE phase and says exactly that.
   */
  const onBulkAction = (event: Event): void => {
    const target = closest(event, "#cpb, #hgb");
    if (!target) return;
    event.stopPropagation();
    toast(
      root,
      target.id === "cpb"
        ? "Nothing was closed: Prometheus keeps no position book, so there are no profitable legs to close."
        : "Nothing was hedged: Prometheus keeps no position book and executes no hedge legs.",
    );
  };

  root.addEventListener("click", onStrategyPanelClick, true);
  root.addEventListener("click", onNewStrategyClick, true);
  root.addEventListener("click", onBulkAction, true);

  /* ------------------------------------------------------------------ *
   * Reads. Failures surface in the design's own toast; the widgets keep
   * showing "…" / "—" rather than a number that was never read.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [strategies, snapshot, transactions, stakes, config] = await Promise.all([
        getStrategies({ page: 1, limit: 50 }),
        getPortfolio(),
        getTransactions({ limit: 8 }),
        getEmberStakePositions(10),
        getEmberStakingConfig(),
      ]);
      if (cancelled) return;
      view.strategies = strategies.items;
      view.snapshot = snapshot;
      view.recent = transactions.items;
      view.stakes = stakes.items;
      view.config = config;
      view.status = "ready";
      view.error = null;
      syncNow();
    } catch (error: unknown) {
      if (cancelled) return;
      view.status = "error";
      view.error = apiMessage(error);
      syncNow();
      toast(root, `Could not read your desk — ${apiMessage(error)}`);
    }
  }

  void refresh();

  return () => {
    cancelled = true;
    sync = null;
    root.removeEventListener("click", onStrategyPanelClick, true);
    root.removeEventListener("click", onNewStrategyClick, true);
    root.removeEventListener("click", onBulkAction, true);
    cleanupAll(binder, htmlBinder)();
  };
}

export default function ExpertDashboardPage() {
  const router = useRouter();
  const { data: session } = useSession();

  useEffect(() => {
    navigate = (href: string) => router.push(href);
    view.identity = session?.user
      ? { name: session.user.name ?? "", email: session.user.email ?? "" }
      : null;
    sync?.();
    return () => {
      navigate = null;
    };
  }, [router, session]);

  return (
    <RoleGate roles={["EXPERT_TRADER", "PLATFORM_ADMIN"]}>
      <DesignFrame design={designs.expertDashboard} onReady={wireExpertDashboard} />
    </RoleGate>
  );
}
