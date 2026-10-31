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
  on,
  sel,
  toast,
  type Binder,
  type BoundSlot,
} from "@/lib/design/wire";

/**
 * LIQUIDITY OPERATIONS — the designer's `liquidity_admin.html`, mounted
 * standalone and wired to MODULE 09/13.
 *
 * WHAT IS REAL HERE
 *  - "Aggregate available" and its threshold/shortfall line read
 *    `GET liquidity/overview`; the operations queue renders that same
 *    payload — the open shortfall request, a below-threshold warning, and the
 *    `commitmentsEnabled` configuration flag.
 *  - The provider-tier footnote reports whether commitments are enabled and
 *    this account's own LP registration (`GET liquidity/commitments/me`).
 *
 * WHAT IS ILLUSTRATIVE — and says so
 *  - There is no pool-registry, volume, fee, tier or TVL-history endpoint, so
 *    the pool table, the 24h volume and fee metrics, the pool-health metric,
 *    the tier thresholds and the 7-day chart keep the design's figures and
 *    each one carries an "illustrative / no endpoint" caption. The design's
 *    own demo toasts ("demo preview", "demo mode") are left intact.
 *
 * The wiring pattern (module `view` + `sync`, one module-level `wireX`,
 * binder-owned slots, capture-phase interception, delegated `on(…)`, a
 * complete cleanup) is documented in `app/staking/page.tsx`.
 */

type LoadStatus = "loading" | "ready" | "error";

interface LiquidityAdminView {
  status: LoadStatus;
  overview: LiquidityOverview | null;
  my: LiquidityMyCommitment | null;
  rolesLoading: boolean;
  isAdmin: boolean;
  error: string | null;
}

const view: LiquidityAdminView = {
  status: "loading",
  overview: null,
  my: null,
  rolesLoading: true,
  isAdmin: false,
  error: null,
};

/** Set by the wiring so a role change arriving later can re-apply the slots. */
let sync: (() => void) | null = null;

function esc(value: unknown): string {
  return String(value)
    .replace(/\r\n?/g, "\n") // the HTML parser folds CR to LF before anything else
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
}

/** Display formatting only — the ledger's decimal strings stay untouched. */
function money(value: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, 2).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

function shortDay(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

interface QueueItem {
  kind: string;
  title: string;
  body: string;
  time: string;
}

/**
 * The queue is the overview payload, not the design's sample notices: an open
 * shortfall request, a below-threshold warning, or the disabled-commitments
 * configuration — and nothing at all to review when the platform is healthy.
 */
function queueItems(): QueueItem[] {
  if (view.status === "loading") {
    return [
      {
        kind: "",
        title: "Reading the liquidity overview",
        body: "GET liquidity/overview is in flight.",
        time: "…",
      },
    ];
  }

  const overview = view.overview;
  if (!overview) {
    return [
      {
        kind: "critical",
        title: "Could not read the liquidity overview",
        body: view.error ?? "Unknown error.",
        time: "error",
      },
    ];
  }

  const items: QueueItem[] = [];
  if (overview.openRequest) {
    items.push({
      kind: "critical",
      title: "USDT shortfall request open",
      body:
        `${money(overview.openRequest.requiredUsdt)} USDT required against a ` +
        `${money(overview.openRequest.thresholdUsdt)} USDT threshold.`,
      time: shortDay(overview.openRequest.openedAt),
    });
  } else if (overview.belowThreshold) {
    items.push({
      kind: "critical",
      title: "Aggregate liquidity below threshold",
      body:
        `${money(overview.aggregateAvailableUsdt)} USDT available against a ` +
        `${money(overview.thresholdUsdt)} USDT threshold — shortfall ` +
        `${money(overview.shortfallUsdt)} USDT.`,
      time: "now",
    });
  } else {
    items.push({
      kind: "",
      title: "Nothing requires review",
      body:
        `Aggregate liquidity is at or above threshold: ` +
        `${money(overview.aggregateAvailableUsdt)} USDT available against ` +
        `${money(overview.thresholdUsdt)} USDT.`,
      time: "OK",
    });
  }

  if (!overview.commitmentsEnabled) {
    items.push({
      kind: "",
      title: "Provider commitments disabled",
      body: "Commitment mutations are off until approved EMBER slabs are configured.",
      time: "config",
    });
  }

  return items;
}

function queueHtml(): string {
  return queueItems()
    .map(
      (item) =>
        `<article class="notice${item.kind ? ` ${item.kind}` : ""}"><i></i>` +
        `<div><b>${esc(item.title)}</b><p>${esc(item.body)}</p></div>` +
        `<time>${esc(item.time)}</time></article>`,
    )
    .join("");
}

function wireLiquidityAdmin(root: HTMLElement): () => void {
  /* ------------------------------------------------------------------ *
   * Static panels the design never rebuilds, resolved once by heading.
   * ------------------------------------------------------------------ */
  const panelWith = (title: string): Element | null =>
    all(root, ".panel").find((entry) =>
      (entry.querySelector("h2")?.textContent ?? "").includes(title),
    ) ?? null;

  const queuePanel = panelWith("Operations queue");
  const registryPanel = panelWith("Pool registry");
  const tiersPanel = panelWith("Provider tiers");
  const activityPanel = panelWith("Liquidity activity");

  const within = (panel: Element | null, selector: string): Element | null =>
    panel?.querySelector(selector) ?? null;

  const queueBadge = within(queuePanel, ".panel-head .state");
  const queueList = within(queuePanel, ".notice-list");
  const registryCaption = within(registryPanel, ".panel-head p");
  const tiersCaption = within(tiersPanel, ".panel-head p");
  const tierFootnote = within(tiersPanel, ".tier-controls span");
  const activityCaption = within(activityPanel, ".panel-head p");
  const activityDelta = within(activityPanel, ".panel-head .positive");

  /* ------------------------------------------------------------------ *
   * A reload control, added with the design's own `.btn` styling into the
   * header action cluster (the previous page had a Reload button).
   * ------------------------------------------------------------------ */
  const topActions = sel(root, ".top-actions");
  if (topActions && !topActions.querySelector("#pbReload")) {
    topActions.insertAdjacentHTML(
      "beforeend",
      '<button class="btn" id="pbReload" type="button">Reload</button>',
    );
  }

  /* ------------------------------------------------------------------ *
   * Text slots: real figures where an endpoint exists, an explicit
   * "illustrative / no endpoint" caption where one does not.
   * ------------------------------------------------------------------ */
  const textSlots: BoundSlot[] = [];
  const addSlot = (at: string | Element | null, value: () => string): void => {
    if (at) textSlots.push({ at, value });
  };

  addSlot(".head p", () => {
    if (view.status === "loading") {
      return "Reading the real platform liquidity figures from the admin API…";
    }
    if (!view.overview) {
      return `The liquidity overview could not be read — ${view.error ?? "unknown error"}. The prototype panels below stay labelled as illustrative.`;
    }
    return (
      "Real platform liquidity sits beside clearly labelled prototype panels: the aggregate " +
      "threshold figures and the review queue come from GET liquidity/overview, while the pool " +
      "table, tiers and 7-day chart are illustrative."
    );
  });

  const aggregate = (): string =>
    view.overview ? `$${money(view.overview.aggregateAvailableUsdt)}` : view.status === "loading" ? "…" : "—";

  const thresholdLine = (): string => {
    const overview = view.overview;
    if (!overview) return view.status === "loading" ? "reading liquidity/overview…" : "liquidity/overview unavailable";
    return overview.belowThreshold
      ? `Threshold $${money(overview.thresholdUsdt)} · shortfall $${money(overview.shortfallUsdt)}`
      : `Threshold $${money(overview.thresholdUsdt)} · at or above`;
  };

  addSlot(".metrics > .metric:nth-child(1) small", () => "Aggregate available");
  addSlot(".metrics > .metric:nth-child(1) strong", aggregate);
  addSlot(".metrics > .metric:nth-child(1) span", thresholdLine);

  addSlot(
    ".metrics > .metric:nth-child(2) span",
    () => "Illustrative demo figure · no volume endpoint",
  );
  addSlot(
    ".metrics > .metric:nth-child(3) span",
    () => "Illustrative demo figure · no fee endpoint",
  );
  addSlot(
    ".metrics > .metric:nth-child(4) span",
    () => "Illustrative demo figure · no per-pool endpoint",
  );

  addSlot(registryCaption, () => "Illustrative prototype rows · there is no pool-registry endpoint.");

  addSlot(".admin-note", () => {
    const overview = view.overview;
    if (!overview) {
      return (
        "Pool rows, filters and controls are illustrative prototype data — nothing here submits " +
        (view.status === "loading"
          ? "a transaction. The real liquidity overview is still loading."
          : `a transaction. The overview could not be read — ${view.error ?? "unknown error"}.`)
      );
    }
    return (
      "Pool rows, filters and controls are illustrative prototype data — there is no " +
      "pool-registry endpoint and nothing here submits a transaction. Real platform liquidity: " +
      `${money(overview.aggregateAvailableUsdt)} USDT available against a ` +
      `${money(overview.thresholdUsdt)} USDT threshold` +
      (overview.belowThreshold
        ? `, shortfall ${money(overview.shortfallUsdt)} USDT`
        : " — at or above") +
      `; provider commitments ${overview.commitmentsEnabled ? "enabled" : "disabled"}.`
    );
  });

  addSlot(tiersCaption, () => "Illustrative thresholds · there is no tier endpoint.");
  addSlot(tierFootnote, () => {
    const mine = view.my;
    if (!mine) return view.status === "loading" ? "…" : "Commitment configuration unavailable.";
    if (!mine.commitmentsEnabled) {
      return "Provider commitments are disabled until approved EMBER slabs are configured.";
    }
    return mine.provider
      ? `Commitments enabled · LP registration on this account: ${mine.provider.status}`
      : "Commitments enabled · no LP registration on this account";
  });

  addSlot(activityCaption, () => "Illustrative TVL movement · there is no history endpoint.");
  addSlot(activityDelta, () => "illustrative");

  const binder: Binder = bindText(root, textSlots);

  const badgeText = (): string =>
    view.status === "loading" ? "…" : `${queueItems().length} open`;

  const queueBinder = queueList
    ? bindHtml(root, [{ at: queueList, value: () => queueHtml() }])
    : undefined;
  const badgeBinder = queueBadge
    ? bindText(root, [{ at: queueBadge, value: () => badgeText() }])
    : undefined;

  const syncNow = (): void => {
    binder.apply();
    queueBinder?.apply();
    badgeBinder?.apply();
  };
  sync = syncNow;

  /* ------------------------------------------------------------------ *
   * Reads. Failures surface in the design's own toast and leave the
   * widgets saying "…" rather than a number that was never read.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [overview, mine] = await Promise.all([
        getLiquidityOverview(),
        getMyLiquidityCommitment(),
      ]);
      if (cancelled) return;
      view.overview = overview;
      view.my = mine;
      view.status = "ready";
      view.error = null;
      syncNow();
    } catch (error: unknown) {
      if (cancelled) return;
      view.status = "error";
      view.error = apiMessage(error);
      toast(root, `Could not read the liquidity overview — ${apiMessage(error)}`);
      syncNow();
    }
  }

  /* Delegated: nothing stands between this button and the API. */
  const offReload = on(root, "#pbReload", "click", () => {
    toast(root, "Reloading the liquidity overview…");
    void refresh();
  });

  void refresh();

  return () => {
    cancelled = true;
    sync = null;
    offReload();
    cleanupAll(binder, queueBinder, badgeBinder)();
  };
}

export default function AdminLiquidityPage() {
  const { loading, hasRole } = useRoles();

  // Roles arrive from their own fetch; the wiring reads them from the shared
  // view, so mirror them across whenever they change and re-apply the slots.
  useEffect(() => {
    view.rolesLoading = loading;
    view.isAdmin = hasRole("PLATFORM_ADMIN");
    sync?.();
  }, [loading, hasRole]);

  return (
    <RoleGate roles={["PLATFORM_ADMIN"]}>
      <DesignFrame design={designs.liquidityAdmin} onReady={wireLiquidityAdmin} />
    </RoleGate>
  );
}
