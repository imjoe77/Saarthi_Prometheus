"use client";

import React, { useEffect } from "react";

import DesignFrame from "@/components/design/DesignFrame";
import { useRoles } from "@/components/RoleProvider";
import {
  ApiError,
  createEmberStake,
  getBalances,
  getEmberStakePositions,
  getEmberStakingConfig,
  type EmberStakePosition,
  type EmberStakingConfig,
} from "@/lib/api-client";
import { addDecimalStrings } from "@/lib/decimal";
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
 * EMBER Staking — the designer's `staking.html`, mounted standalone and wired
 * to the ledger (design-integration exemplar).
 *
 * WHAT THIS PAGE KEEPS HONEST
 *  - `amount` / `status` / `lockUntil` / balances are ledger truth: they are
 *    read from `GET ember-staking/positions` and `wallets/me/balances`, and the
 *    slide-to-stake completes through `POST ember-staking/stakes` — an
 *    idempotent call that locks real EMBER from the wallet.
 *  - Rewards are SIMULATED at the configured APR, computed at read time and
 *    never credited. Every widget that would imply otherwise is re-labelled:
 *    the "DEMO EXPERIENCE" badge, the claim button, the estimate block.
 *  - The design offers four lock periods; the platform has exactly one
 *    (`GET ember-staking/config`). The configured period is marked as the real
 *    choice, the other three are marked illustrative, and picking one says so.
 *
 * HOW THE WIRING WORKS (the pattern the other ported pages follow)
 *  - The design is a complete application: its own script writes its mock
 *    figures into these elements and rewrites them on every interaction. So
 *    binding is not a one-shot text replacement — `bindText`/`bindHtml` own
 *    their slots through MutationObservers, applying the real value whenever
 *    the design (or a fetch) writes anything: the design wins once, the
 *    ledger wins in the end.
 *  - Actions are intercepted in the CAPTURE phase on the mount root, before
 *    the design's own element listeners run: the slide-to-stake, MAX, the
 *    period picker and the claim button all end up here instead of mutating
 *    the design's closure-local mock state.
 *  - Shared state lives at module scope (`view`), because `onReady` is a stable
 *    callback that DesignFrame invokes once; React mirrors the roles into it.
 */
type LoadStatus = "loading" | "ready" | "error";

interface StakingView {
  status: LoadStatus;
  positions: EmberStakePosition[];
  /** Available EMBER in the caller's wallet ledger, as a decimal string. */
  available: string;
  config: EmberStakingConfig | null;
  canStake: boolean;
  rolesLoading: boolean;
  error: string | null;
}

const view: StakingView = {
  status: "loading",
  positions: [],
  available: "0",
  config: null,
  canStake: false,
  rolesLoading: true,
  error: null,
};

/** Set by the wiring so a role change arriving later can re-apply the slots. */
let sync: (() => void) | null = null;

const DAY_MS = 86_400_000;

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4 10-10"/></svg>';

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Display formatting only — ledger arithmetic stays in decimal strings. */
function fmt(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-IN", { maximumFractionDigits: 4 })
    : value;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function activePositions(): EmberStakePosition[] {
  return view.positions.filter((position) => position.status === "ACTIVE");
}

/** Summed with decimal strings: the total must stay exact. */
function lockedTotal(): string {
  return activePositions().reduce((sum, position) => addDecimalStrings(sum, position.amount), "0");
}

function simulatedRewardTotal(): string {
  return view.positions.reduce((sum, position) => addDecimalStrings(sum, position.simulatedReward), "0");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface LockProgress {
  pct: number;
  elapsed: string;
  remaining: string;
  start: string;
  end: string;
}

/** Progress of the newest active lock, judged against the moment of application. */
function lockProgress(): LockProgress {
  const newest = activePositions()[0];
  if (!newest) {
    return { pct: 0, elapsed: "No active lock", remaining: "—", start: "Not locked", end: "—" };
  }

  const startMs = new Date(newest.stakedAt).getTime();
  const endMs = new Date(newest.lockUntil).getTime();
  const totalMs = Math.max(1, endMs - startMs);
  const nowMs = Date.now();
  const totalDays = Math.max(1, Math.round(totalMs / DAY_MS));
  const elapsedDays = Math.min(totalDays, Math.max(0, Math.round((nowMs - startMs) / DAY_MS)));
  const remainingDays = Math.max(0, totalDays - elapsedDays);

  return {
    pct: Math.min(100, Math.max(0, ((nowMs - startMs) / totalMs) * 100)),
    elapsed: `${elapsedDays} / ${totalDays} days`,
    remaining: remainingDays > 0 ? `${remainingDays} days` : "expired · ready to unlock",
    start: `Locked · ${dateLabel(newest.stakedAt)}`,
    end: `Unlock · ${dateLabel(newest.lockUntil)}`,
  };
}

function wireStaking(root: HTMLElement): () => void {
  const timers: number[] = [];
  const later = (run: () => void, ms: number): void => {
    timers.push(window.setTimeout(run, ms));
  };

  const amountInput = sel<HTMLInputElement>(root, "#amount");
  const slide = sel<HTMLElement>(root, "#lockSlide");
  const handle = sel<HTMLElement>(root, "#slideHandle");
  const fill = sel<HTMLElement>(root, "#slideFill");
  const slideLabel = sel<HTMLElement>(root, "#slideLabel");
  const progressFill = sel<HTMLElement>(root, ".progress i");
  const positionRows = all(root, ".position-row");
  const progressRow = positionRows[1] ?? null;
  const progressTexts = progressRow ? Array.from(progressRow.querySelectorAll("b")) : [];
  const dateSpans = Array.from(root.querySelectorAll(".progress + div span"));
  const periodButtons = Array.from(root.querySelectorAll<HTMLElement>(".period"));
  /** Each period's `<small>` caption, kept with the button it belongs to. */
  const periodSlots = periodButtons
    .map((button) => ({ button, label: button.querySelector("small") as Element | null }))
    .filter((entry): entry is { button: HTMLElement; label: Element } => entry.label !== null);

  const claimRow = (): { header: string; rows: string } => {
    const header =
      '<div class="eyebrow">Your positions ' +
      '<button id="claimBtn" type="button" style="float:right;padding:4px 9px;border:1px solid var(--line);' +
      'border-radius:99px;background:var(--soft);color:var(--orange);font-size:9px;font-weight:800">' +
      "Rewards are simulated</button></div>";

    if (view.positions.length === 0) {
      return {
        header,
        rows:
          '<div class="history-row"><span>No positions yet<small>Slide to stake real EMBER — ' +
          "rewards accrue as a display-only simulation</small></span><b>—</b></div>",
      };
    }

    const rows = view.positions
      .slice(0, 6)
      .map((position) => {
        const state =
          position.status === "ACTIVE"
            ? `locks until ${dateLabel(position.lockUntil)}`
            : `unstaked ${position.unstakedAt ? dateLabel(position.unstakedAt) : ""}`;
        return (
          `<div class="history-row"><span>${esc(fmt(position.amount))} EMBER · ${position.status}` +
          `<small>${esc(state)}</small></span>` +
          `<b title="simulated — never credited">${esc(fmt(position.simulatedReward))} EMBER</b></div>`
        );
      })
      .join("");
    return { header, rows };
  };

  /**
   * Projected reward for the amount in the box: display-only arithmetic at the
   * configured APR. The ledger's own figure is `simulatedReward` on each
   * position, computed server-side — this is a preview of that same formula.
   */
  const projectionText = (): string => {
    const config = view.config;
    if (!config) return "…";
    const amount = Number(amountInput?.value ?? "");
    if (!Number.isFinite(amount) || amount <= 0) return "0.00 EMBER · projected, simulated";
    const reward = (amount * Number(config.aprPercent) * config.lockDays) / (100 * 365);
    return `${reward.toFixed(2)} EMBER · projected, simulated`;
  };

  const binder: Binder = bindText(root, [
    // Intro and badges: what the page actually is.
    { at: ".intro .demo", value: () => "REAL WALLET LOCK · SIMULATED REWARDS" },
    {
      at: ".intro p",
      value: () =>
        "Lock eligible EMBER for the configured period to participate in simulated protocol rewards. Staking is a token utility, not a long or short trade.",
    },
    {
      at: "p.note",
      value: () =>
        "Real EMBER is locked from your wallet until the lock expires. Reward figures are simulated at the configured APR — displayed, never credited.",
    },

    // Summary strip — all four tiles read from the ledger.
    { at: "#stakedTotal", value: () => fmt(lockedTotal()) },
    {
      at: "#tierLabel",
      value: () =>
        view.status === "loading" ? "reading your ledger…" : `${plural(activePositions().length, "active position")} · real lock`,
    },
    { at: "#available", value: () => (view.status === "loading" ? "…" : fmt(view.available)) },
    { at: "#available + em", value: () => "from your wallet ledger" },
    { at: "#rewardsTotal", value: () => fmt(simulatedRewardTotal()) },
    { at: "#rewardsTotal + em", value: () => "simulated · never credited" },
    { at: "#currentLock", value: () => (view.config ? `${view.config.lockDays} days` : "…") },
    {
      at: "#currentApy",
      value: () => (view.config ? `${view.config.aprPercent}% APR · simulated` : "APR not loaded yet"),
    },

    // The position panel.
    { at: "#vaultTitle + .sub", value: () => "Your real lock, its progress, and the simulated reward accruing against it." },
    { at: "#positionStaked", value: () => fmt(lockedTotal()) },
    {
      at: ".balance > span",
      value: () => "Held in your wallet ledger · not marked to market",
    },
    { at: "#positionLock", value: () => (view.config ? `${view.config.lockDays}-day lock` : "…") },
    {
      at: progressTexts[0] ?? "#positionLock",
      value: () => lockProgress().elapsed,
    },
    {
      at: progressTexts[1] ?? "#positionLock",
      value: () => lockProgress().remaining,
    },
    ...(dateSpans.length === 2
      ? [
          { at: dateSpans[0] as Element, value: () => lockProgress().start },
          { at: dateSpans[1] as Element, value: () => lockProgress().end },
        ]
      : []),

    // The stake form: only the configured period and APR are real.
    { at: "#stakeTitle + .sub", value: () => "One configured lock period — the other choices below are illustrative." },
    { at: "#daysLabel", value: () => (view.config ? `${view.config.lockDays} days` : "…") },
    { at: "#apyLabel", value: () => (view.config ? `${view.config.aprPercent}% APR · simulated` : "…") },
    { at: "#reward", value: () => projectionText() },
    ...periodSlots.map(({ button, label }) => ({
      at: label,
      value: () => {
        if (!view.config) return "…";
        return button.dataset.days === String(view.config.lockDays)
          ? `${view.config.aprPercent}% APR · real`
          : "illustrative";
      },
    })),
  ]);

  /** Renders the real positions; also owns the claim button (delegated below). */
  const historyBinder = bindHtml(root, [
    {
      at: ".history",
      value: () => {
        const { header, rows } = claimRow();
        return `${header}${rows}`;
      },
    },
  ]);

  const applyProgress = (): void => {
    if (!progressFill) return;
    const { pct } = lockProgress();
    // The design animates this bar to a fixed 68% with `fill: both`, which
    // would out-specify an inline width — switch the animation off first.
    progressFill.style.animation = "none";
    progressFill.style.width = `${pct.toFixed(1)}%`;
  };

  const syncNow = (): void => {
    binder.apply();
    historyBinder.apply();
    applyProgress();

    if (amountInput && view.available) amountInput.max = view.available;
    for (const button of periodButtons) {
      button.classList.toggle("active", button.dataset.days === String(view.config?.lockDays ?? ""));
    }
    // Reading roles is in flight or the caller may not stake: the slide is
    // inert until the backend would accept the call anyway.
    slide?.classList.toggle("disabled", view.rolesLoading || !view.canStake);
    slide?.setAttribute("aria-disabled", String(view.rolesLoading || !view.canStake));
  };
  sync = syncNow;

  /* ------------------------------------------------------------------ *
   * Slide-to-stake: the design's completion handlers are intercepted in
   * the capture phase, so its local `stake()` (which only mutates mock
   * numbers) never runs — this one calls the API instead.
   * ------------------------------------------------------------------ */
  let busy = false;

  const travel = (): number =>
    slide && handle ? Math.max(0, slide.clientWidth - handle.offsetWidth - 8) : 0;

  const fillTo = (progress: number): void => {
    if (!slide || !handle || !fill || !slideLabel) return;
    const clamped = Math.max(0, Math.min(1, progress));
    handle.style.transition = "transform .5s cubic-bezier(.34,1.56,.64,1)";
    handle.style.transform = `translateX(${(travel() * clamped).toFixed(1)}px)`;
    fill.style.width = `${(clamped * 100).toFixed(1)}%`;
    slideLabel.style.opacity = String(Math.max(0, 1 - clamped * 1.2));
    slide.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
  };

  const resetSlide = (): void => {
    if (!slide || !slideLabel || !handle) return;
    fillTo(0);
    slideLabel.textContent = "Slide or tap to stake";
    slideLabel.style.color = "";
    slide.classList.remove("ok", "err");
    handle.innerHTML = LOCK_SVG;
  };

  const refuse = (message: string): void => {
    slide?.classList.remove("ok");
    slide?.classList.add("err");
    if (slideLabel) {
      slideLabel.textContent = "Not staked";
      slideLabel.style.opacity = "1";
      slideLabel.style.color = "#fff";
    }
    toast(root, message);
    busy = false;
    later(resetSlide, 1_800);
  };

  const runStake = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    fillTo(1);
    if (handle) handle.innerHTML = '<span class="spin"></span>';
    if (slideLabel) slideLabel.style.opacity = "0";

    const amount = amountInput?.value.trim() ?? "";
    const config = view.config;

    if (view.rolesLoading) {
      refuse("Checking your roles — try again in a moment.");
      return;
    }
    if (!view.canStake) {
      refuse("Opening a position requires the Liquidity Provider role (or an administrator).");
      return;
    }
    if (!config) {
      refuse("The staking configuration has not loaded yet — try again shortly.");
      return;
    }

    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      refuse("Enter an amount of EMBER to stake.");
      return;
    }
    if (parsed > Number(view.available)) {
      refuse(`Your available balance is ${fmt(view.available)} EMBER.`);
      return;
    }

    try {
      const result = await createEmberStake({
        emberAmount: amount,
        clientRequestId: crypto.randomUUID(),
      });

      await refresh();
      slide?.classList.remove("err");
      slide?.classList.add("ok");
      if (handle) handle.innerHTML = CHECK_SVG;
      if (slideLabel) {
        slideLabel.textContent = "Staked";
        slideLabel.style.opacity = "1";
        slideLabel.style.color = "#fff";
      }
      toast(
        root,
        result.created
          ? `Locked ${fmt(result.position.amount)} EMBER until ${dateLabel(result.position.lockUntil)}.`
          : "That idempotency key was already used — nothing was locked twice.",
      );
      if (amountInput) amountInput.value = "";
      busy = false;
      later(resetSlide, 1_600);
    } catch (error: unknown) {
      if (handle) handle.innerHTML = LOCK_SVG;
      refuse(apiMessage(error));
    }
  };

  const isSlide = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest("#lockSlide") !== null;

  const onPointerUp = (event: Event): void => {
    if (!isSlide(event.target)) return;
    // Below the design's own completion threshold its handler resets the drag;
    // at or above it, this page owns the completion.
    const now = Number(slide?.getAttribute("aria-valuenow") ?? 0);
    if (now < 82) return;
    event.stopPropagation();
    void runStake();
  };

  const onClickCapture = (event: Event): void => {
    if (!isSlide(event.target)) return;
    event.stopPropagation();
    void runStake(); // a tap: the slide completes and stakes
  };

  const onKeyDownCapture = (event: Event): void => {
    if (!isSlide(event.target)) return;
    const key = (event as KeyboardEvent).key;
    // Arrow keys keep the design's own handle motion.
    if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
    event.stopPropagation();
    void runStake();
  };

  const closest = (event: Event, selector: string): Element | null => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    return target && root.contains(target) ? target : null;
  };

  const onMaxClick = (event: Event): void => {
    if (!closest(event, "#maxBtn")) return;
    event.stopPropagation();
    if (amountInput) amountInput.value = view.available;
    syncNow();
  };

  const onClaimClick = (event: Event): void => {
    if (!closest(event, "#claimBtn")) return;
    event.stopPropagation();
    toast(
      root,
      "Rewards are computed at read time from the configured APR and shown for information — they are never credited, so there is nothing to claim.",
    );
  };

  const onPeriodClick = (event: Event): void => {
    const button = closest(event, ".period");
    if (!button) return;
    event.stopPropagation();
    const config = view.config;
    if (!config) {
      toast(root, "The staking configuration has not loaded yet.");
      return;
    }
    const chosen = button.getAttribute("data-days");
    toast(
      root,
      chosen === String(config.lockDays)
        ? `This is the configured lock: ${config.lockDays} days at ${config.aprPercent}% APR.`
        : `Lock periods are set by the platform configuration — only ${config.lockDays} days at ${config.aprPercent}% APR is offered. The other periods are illustrative.`,
    );
    syncNow();
  };

  const onAmountInput = (): void => syncNow();

  root.addEventListener("pointerup", onPointerUp, true);
  root.addEventListener("click", onClickCapture, true);
  root.addEventListener("keydown", onKeyDownCapture, true);
  root.addEventListener("click", onMaxClick, true);
  root.addEventListener("click", onClaimClick, true);
  root.addEventListener("click", onPeriodClick, true);
  amountInput?.addEventListener("input", onAmountInput);

  /* ------------------------------------------------------------------ *
   * Reads. Failures surface in the design's own toast; the widgets keep
   * showing "…" rather than a number that was never read.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [positions, balances, config] = await Promise.all([
        getEmberStakePositions(50),
        loadBalances(),
        getEmberStakingConfig(),
      ]);
      if (cancelled) return;
      view.positions = positions.items;
      view.available = balances.find((row) => row.asset.symbol === "EMBER")?.available ?? "0";
      view.config = config;
      view.status = "ready";
      view.error = null;
      syncNow();
    } catch (error: unknown) {
      if (cancelled) return;
      view.status = "error";
      view.error = apiMessage(error);
      toast(root, `Could not read your staking data — ${apiMessage(error)}`);
    }
  }

  /** A visitor may have no wallet yet: 404 means "no balances", not failure. */
  async function loadBalances() {
    try {
      return await getBalances();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  }

  void refresh();

  return () => {
    cancelled = true;
    sync = null;
    for (const id of timers) window.clearTimeout(id);
    root.removeEventListener("pointerup", onPointerUp, true);
    root.removeEventListener("click", onClickCapture, true);
    root.removeEventListener("keydown", onKeyDownCapture, true);
    root.removeEventListener("click", onMaxClick, true);
    root.removeEventListener("click", onClaimClick, true);
    root.removeEventListener("click", onPeriodClick, true);
    amountInput?.removeEventListener("input", onAmountInput);
    cleanupAll(binder, historyBinder)();
  };
}

export default function EmberStakingPage() {
  const { loading, hasRole } = useRoles();

  // Roles arrive from their own fetch; the wiring reads them from the shared
  // view, so mirror them across whenever they change and re-apply the slots.
  useEffect(() => {
    view.rolesLoading = loading;
    view.canStake = hasRole("LIQUIDITY_PROVIDER", "PLATFORM_ADMIN");
    sync?.();
  }, [loading, hasRole]);

  return <DesignFrame design={designs.staking} onReady={wireStaking} />;
}
