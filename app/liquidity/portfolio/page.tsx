"use client";

import React, { useEffect } from "react";

import DesignFrame from "@/components/design/DesignFrame";
import RoleGate from "@/components/RoleGate";
import { useRoles } from "@/components/RoleProvider";
import {
  getMyLiquidityCommitment,
  type LiquidityMyCommitment,
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
 * MODULE 13 — the Liquidity Provider portfolio:
 * `designs/liquidity_provider_portfolio.html` mounted standalone and wired to
 * the ledger (the design-integration pattern is documented in
 * `app/staking/page.tsx`).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - Ledger truth: `GET liquidity/commitments/me` feeds the "Committed USDT"
 *    tile and the ledger line in the header — committed, available, consumed,
 *    EMBER locked, commitment status, registration date.
 *  - Illustrative, and labelled as such in place: the three pool rows, the fee
 *    table, the 30-day fee and net figures, the capital-allocation split and
 *    the estimated impermanent loss. The platform has no per-pool position or
 *    fee feed (there is no such endpoint in `lib/api-client.ts`), so each card
 *    says its numbers are demo data instead of letting them read as real.
 *  - `GET liquidity/overview` is not fetched here: this design has no
 *    platform-health widget to bind it to (it is bound on the dashboard).
 *  - No mutation exists for adding, editing or removing liquidity, so "Add
 *    liquidity" and the dialog's "Save demo changes" are intercepted in the
 *    CAPTURE phase — the design's mock handler never runs, no mock mutation
 *    happens, and the toast states the capability is illustrative. The
 *    read-only preview dialogs (fee activity, manage) still open.
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

interface PortfolioView {
  status: LoadStatus;
  my: LiquidityMyCommitment | null;
  rolesLoading: boolean;
  canCommit: boolean;
  error: string | null;
}

const view: PortfolioView = {
  status: "loading",
  my: null,
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

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** The commitment tile: "…" while loading, "—" when there is nothing to show. */
function committedFigure(): string {
  if (view.status === "loading") return "…";
  if (view.status === "error") return "—";
  const commitment = view.my?.commitment;
  return commitment ? fmt(commitment.usdtCommitted) : "—";
}

/** The header note: the caller's own ledger line, then the demo disclaimer. */
function ledgerNote(): string {
  const disclaimer = "Pool rows, fees and APRs below are illustrative demo figures.";
  if (view.status === "loading") return `Reading your liquidity ledger… ${disclaimer}`;
  if (view.status === "error") return `Your liquidity ledger could not be read. ${disclaimer}`;

  const my = view.my;
  if (!my) return disclaimer;
  if (!my.provider) return `You are not registered as a liquidity provider yet. ${disclaimer}`;
  if (!my.commitment) {
    return `Registered ${dateLabel(my.provider.registeredAt)} · no commitment opened yet. ${disclaimer}`;
  }

  const commitment = my.commitment;
  return (
    `Ledger: ${fmt(commitment.usdtCommitted)} USDT committed · ` +
    `${fmt(commitment.usdtAvailable)} available · ${fmt(commitment.usdtConsumed)} consumed · ` +
    `${fmt(commitment.emberLocked, 4)} EMBER locked (${esc(commitment.status)}, ` +
    `opened ${dateLabel(commitment.committedAt)}). ${disclaimer}`
  );
}

/** Four summary tiles: one ledger figure, three design demos that say so. */
function summaryCell(index: number): string {
  switch (index) {
    case 0:
      return `<span>Committed USDT · ledger <b>${esc(committedFigure())}</b></span>`;
    case 1:
      return `<span>Fees earned · 30d · illustrative <b class="positive">+$1,284</b></span>`;
    case 2:
      return `<span>Active positions · demo <b>3 pools</b></span>`;
    default:
      return `<span>Estimated net · 30d · illustrative <b class="positive">+$1,188</b></span>`;
  }
}

const HOLDINGS_NOTE =
  "Illustrative demo rows — the platform has no per-pool position or fee feed.";

const ALLOCATION_NOTE = "Illustrative demo shares — the pool split below is not measured.";

const ACTIVITY_NOTE =
  "Illustrative demo activity — the platform has no fee-activity feed.";

function wireLiquidityPortfolio(root: HTMLElement): () => void {
  // The design's workspace switcher read `<body data-view>`, which the extractor
  // drops, so it hid `#lp-view` and showed the Expert Trader workspace instead.
  for (const roleView of all(root, ".role-view")) {
    if (roleView instanceof HTMLElement) roleView.hidden = roleView.id !== LP_VIEW;
  }
  const crumb = sel(root, ".crumb b");
  if (crumb) crumb.textContent = "Portfolio";

  const summarySpans = all(root, ".lp-summary > span");
  const cardSubs = all(root, ".lp-portfolio-sub");
  const balanceFeet = all(root, ".lp-balance-foot");

  const binder: Binder = bindText(root, [
    // The ledger line: everything real this page has to say, then the label
    // that keeps the demo tables below from reading as measured data.
    { at: ".lp-portfolio-note", value: ledgerNote },
    // Each card's caption owns the mock figures inside it.
    ...cardSubs.map((element, index) => ({
      at: element,
      value: () =>
        index === 0 ? HOLDINGS_NOTE : index === 1 ? ALLOCATION_NOTE : ACTIVITY_NOTE,
    })),
    // The holdings card's own foot already says "illustrative demo estimates";
    // the allocation card's does not, so it is rewritten to say it plainly.
    ...(balanceFeet[1]
      ? [
          {
            at: balanceFeet[1],
            value: () =>
              "Illustrative: estimated impermanent loss " +
              '<b style="color:var(--dn)">−$96</b><br>estimated net after fees ' +
              '<b style="color:var(--up)">+$1,188</b> over 30 days — neither is measured.',
          },
        ]
      : []),
  ]);

  const htmlBinder: Binder = bindHtml(root, [
    // Summary tiles: slot 0 is ledger truth, slots 1–3 are labelled demos.
    ...summarySpans.map((span, index) => ({ at: span, value: () => summaryCell(index) })),
    {
      at: ".lp-allocation-total",
      value: () => "<strong>$48,250</strong><span>total supplied · illustrative</span>",
    },
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
      const my = await getMyLiquidityCommitment();
      if (cancelled) return;
      view.my = my;
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

export default function LiquidityPortfolioPage() {
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
      <DesignFrame design={designs.liquidityProviderPortfolio} onReady={wireLiquidityPortfolio} />
    </RoleGate>
  );
}
