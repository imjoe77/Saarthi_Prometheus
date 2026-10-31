"use client";

import React, { useEffect } from "react";

import DesignFrame from "@/components/design/DesignFrame";
import RoleGate from "@/components/RoleGate";
import { useRoles } from "@/components/RoleProvider";
import {
  getLiquidityOverview,
  getMyLiquidityCommitment,
  type LiquidityMyCommitment,
  type LiquidityOverview,
} from "@/lib/api-client";
import { designs } from "@/lib/design/generated";
import {
  all,
  apiMessage,
  bindHtml,
  bindText,
  cleanupAll,
  sel,
  toast,
  type Binder,
} from "@/lib/design/wire";

/**
 * MODULE 13 — the Liquidity Provider dashboard: `designs/liquidity_dashboard.html`
 * mounted standalone and wired to the ledger (the design-integration pattern is
 * documented in `app/staking/page.tsx`).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - Ledger truth: `GET liquidity/commitments/me` feeds the "Committed USDT"
 *    tile and the EMBER the tier ladder is measured against;
 *    `GET liquidity/overview` feeds the platform-liquidity note (aggregate,
 *    configured threshold, open shortfall notice).
 *  - Illustrative, and labelled as such in place: the price range monitor, the
 *    three demo positions, the tier thresholds, the EMBER flow stats, the
 *    capital-allocation and 30-day return cards, the fee figures and the
 *    weighted-APR tile. The platform measures none of those, so every one of
 *    their captions says "illustrative"/"demo" — a mock figure is never allowed
 *    to stand as if it were real.
 *  - No mutation exists in `lib/api-client.ts` for adding, editing or removing
 *    liquidity, so nothing here invents one: "Add liquidity" and the dialog's
 *    "Save demo changes" are intercepted in the CAPTURE phase before the
 *    design's own handler runs, and the toast states that the capability is
 *    illustrative. The read-only preview dialogs (explore, history, manage)
 *    still open; their own copy marks them demo.
 *
 * HOW THE WIRING WORKS
 *  - `bindText`/`bindHtml` own their slots through MutationObservers, so the
 *    design cannot write its mock figures back over the ledger values.
 *  - Shared state lives at module scope (`view`) because `onReady` is a stable
 *    module-level callback; React mirrors the roles into it via `useRoles()`.
 *  - The design chooses its workspace from `<body data-view="lp-view">`, which
 *    the extractor drops with the body tag — its own switcher therefore falls
 *    back to `expert-view`. The wiring puts `#lp-view` back in front of it.
 */

type LoadStatus = "loading" | "ready" | "error";

interface DashboardView {
  status: LoadStatus;
  my: LiquidityMyCommitment | null;
  overview: LiquidityOverview | null;
  rolesLoading: boolean;
  canCommit: boolean;
  error: string | null;
}

const view: DashboardView = {
  status: "loading",
  my: null,
  overview: null,
  rolesLoading: true,
  canCommit: false,
  error: null,
};

/** Set by the wiring so a role change arriving later can re-apply the slots. */
let sync: (() => void) | null = null;

const LP_VIEW = "lp-view";

/** The design's `data-lp-open` mode that starts a commitment. */
const ADD_MODE = "add";

/** Display formatting only — ledger arithmetic stays in decimal strings. */
function fmt(value: string, digits = 2): string {
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

/** The commitment tile: "…" while loading, "—" when there is nothing to show. */
function committedFigure(): string {
  if (view.status === "loading") return "…";
  if (view.status === "error") return "—";
  const commitment = view.my?.commitment;
  return commitment ? fmt(commitment.usdtCommitted) : "—";
}

/** The design's note box: the platform's aggregate health, read from the API. */
function overviewNote(): string {
  const disclaimer = "Range, price and fee figures on this page are illustrative demo data.";
  if (view.status === "loading") return `Reading platform liquidity… ${disclaimer}`;
  if (view.status === "error") return `Platform liquidity could not be read. ${disclaimer}`;

  const overview = view.overview;
  if (!overview) return `Platform liquidity is unavailable. ${disclaimer}`;
  if (overview.openRequest) {
    return (
      `Shortfall notice open: ${fmt(overview.openRequest.requiredUsdt)} USDT required against a ` +
      `${fmt(overview.openRequest.thresholdUsdt)} USDT threshold ` +
      `(aggregate ${fmt(overview.aggregateAvailableUsdt)} USDT). ${disclaimer}`
    );
  }
  const state = overview.belowThreshold ? "BELOW THRESHOLD" : "OK";
  return (
    `Platform liquidity: ${fmt(overview.aggregateAvailableUsdt)} USDT available · ` +
    `${fmt(overview.thresholdUsdt)} USDT threshold · ${state}. ${disclaimer}`
  );
}

/** The tier ladder is EMBER-denominated, so it carries the real locked figure. */
function tierNote(): string {
  const base = "Illustrative tier ladder — thresholds are demo values.";
  if (view.status !== "ready") return base;
  const commitment = view.my?.commitment;
  if (!commitment) return `${base} No commitment is open yet, so no EMBER is locked.`;
  return `${base} Your ledger locks ${fmt(commitment.emberLocked, 4)} EMBER against this commitment.`;
}

/** Four summary tiles: one ledger figure, three design demos that say so. */
function summaryCell(index: number): string {
  switch (index) {
    case 0:
      return `<span>Committed USDT · ledger <b>${esc(committedFigure())}</b></span>`;
    case 1:
      return `<span>Fees earned · illustrative <b class="positive">+$1,284</b></span>`;
    case 2:
      return `<span>Positions · demo <b>3 positions</b></span>`;
    default:
      return `<span>Estimated weighted APR · illustrative <b class="positive">31.9%</b></span>`;
  }
}

/** The two EMBER flow counters have no feed behind them. */
function flowCell(index: number): string {
  return index === 0
    ? '<div class="lp-flow-stat"><small>EMBER pool buyers · 24h · illustrative</small>' +
        "<b>2,418</b><span>↑ 8.4% vs prior day</span></div>"
    : '<div class="lp-flow-stat"><small>EMBER · staked flow · illustrative</small>' +
        "<b>+3.8%</b><span>30 day price change</span></div>";
}

const INTRO =
  "Your committed capital and the platform's aggregate liquidity are read from the ledger. " +
  "Ranges, prices, fees and APRs on this page are illustrative demo data.";

const RANGE_NOTE =
  "Illustrative price path and range utilization — this demo has no market-data feed for your ranges.";

const POSITIONS_NOTE =
  "Demo rows — the platform does not track ranges, fee shares or APRs. " +
  "Your real commitment is summarised above.";

const ALLOCATION_NOTE =
  "Illustrative demo — how your deployed capital would have split across pools and generated fees.";

const RETURN_NOTE =
  "Illustrative demo — fees, impermanent loss and weighted APR below are not measured.";

function wireLiquidityDashboard(root: HTMLElement): () => void {
  // The design's workspace switcher read `<body data-view>`, which the extractor
  // drops, so it hid `#lp-view` and showed the Expert Trader workspace instead.
  for (const roleView of all(root, ".role-view")) {
    if (roleView instanceof HTMLElement) roleView.hidden = roleView.id !== LP_VIEW;
  }
  const crumb = sel(root, ".crumb b");
  if (crumb) crumb.textContent = "Liquidity Dashboard";

  const summarySpans = all(root, ".lp-summary > span");
  const extraHeadPs = all(root, ".lp-extra-head p");
  const flowStats = all(root, ".lp-context-side .lp-flow-stat");

  const binder: Binder = bindText(root, [
    // Page framing: what is real here and what is not.
    { at: ".lp-head p", value: () => INTRO },
    { at: ".lp-range-head p", value: () => RANGE_NOTE },
    { at: ".lp-positions-head p", value: () => POSITIONS_NOTE },

    // The signal card carries no feed: it says so, and its note carries the
    // one real signal on this page — the platform's liquidity health.
    { at: ".lp-insight .eyebrow", value: () => "POSITION SIGNAL · DEMO" },
    { at: ".lp-insight .lp-risk b", value: () => "One range needs a look · demo" },
    {
      at: ".lp-insight .lp-risk small",
      value: () => "EMBER / USDC is nearing its lower bound · illustrative demo data",
    },
    { at: ".lp-note", value: overviewNote },
    { at: ".lp-context-note", value: tierNote },

    // The two "extra" cards are pure design sample data.
    ...extraHeadPs.map((element, index) => ({
      at: element,
      value: () => (index === 0 ? ALLOCATION_NOTE : RETURN_NOTE),
    })),
  ]);

  const htmlBinder: Binder = bindHtml(root, [
    // Summary tiles: slot 0 is ledger truth, slots 1–3 are labelled demos.
    ...summarySpans.map((span, index) => ({ at: span, value: () => summaryCell(index) })),
    ...flowStats.map((stat, index) => ({ at: stat, value: () => flowCell(index) })),
    { at: ".lp-extra-total", value: () => "<b>$48,250</b>DEPLOYED · ILLUSTRATIVE" },
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
   * "Add liquidity" is the commitment action, and `lib/api-client.ts` exposes no
   * mutation for it. Captured here, the design's mock dialog never opens and no
   * mock commitment is ever made — the button says what the capability really is.
   */
  const onAddClick = (event: Event): void => {
    if (!closest(event, `[data-lp-open="${ADD_MODE}"]`)) return;
    event.stopPropagation();

    if (view.rolesLoading) {
      toast(root, "Reading your roles — try again in a moment.");
      return;
    }
    if (!view.canCommit) {
      toast(root, "Committing liquidity requires the Liquidity Provider role (or an administrator).");
      return;
    }
    if (view.my && !view.my.commitmentsEnabled) {
      toast(
        root,
        "Commitment mutations are disabled until approved EMBER slabs are configured — this design's add-liquidity flow is illustrative and nothing was submitted.",
      );
      return;
    }
    toast(
      root,
      "Adding liquidity is illustrative in this design: the Prometheus API exposes no commitment mutation, so nothing was submitted.",
    );
  };

  /** The dialog's save button would perform a mock mutation: refuse it plainly. */
  const onSaveClick = (event: Event): void => {
    if (!closest(event, "[data-lp-save]")) return;
    event.stopPropagation();
    const dialog = sel<HTMLDialogElement>(root, "#lpDialog");
    if (dialog?.open) dialog.close();
    toast(
      root,
      "Illustrative only — the design's position editor does not move funds and the API exposes no position or commitment mutation, so nothing was saved.",
    );
  };

  root.addEventListener("click", onAddClick, true);
  root.addEventListener("click", onSaveClick, true);

  /* ------------------------------------------------------------------ *
   * Reads. Failures surface in the design's own toast; the widgets keep
   * showing "…" / "—" rather than a number that was never read.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [my, overview] = await Promise.all([
        getMyLiquidityCommitment(),
        getLiquidityOverview(),
      ]);
      if (cancelled) return;
      view.my = my;
      view.overview = overview;
      view.status = "ready";
      view.error = null;
      syncNow();
    } catch (error: unknown) {
      if (cancelled) return;
      view.status = "error";
      view.error = apiMessage(error);
      syncNow();
      toast(root, `Could not read your liquidity data — ${apiMessage(error)}`);
    }
  }

  void refresh();

  return () => {
    cancelled = true;
    sync = null;
    root.removeEventListener("click", onAddClick, true);
    root.removeEventListener("click", onSaveClick, true);
    cleanupAll(binder, htmlBinder)();
  };
}

export default function LiquidityDashboardPage() {
  const { loading, hasRole } = useRoles();

  // Roles arrive from their own fetch; the wiring reads them from the shared
  // view, so mirror them across whenever they change and re-apply the slots.
  useEffect(() => {
    view.rolesLoading = loading;
    view.canCommit = hasRole("LIQUIDITY_PROVIDER", "PLATFORM_ADMIN");
    sync?.();
  }, [loading, hasRole]);

  return (
    <RoleGate roles={["LIQUIDITY_PROVIDER", "PLATFORM_ADMIN"]}>
      <DesignFrame design={designs.liquidityDashboard} onReady={wireLiquidityDashboard} />
    </RoleGate>
  );
}
