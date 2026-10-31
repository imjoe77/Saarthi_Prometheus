import { ApiError } from "@/lib/api-client";

/**
 * DOM wiring helpers for the ported design pages (MODULE: design integration).
 *
 * The designs are complete interactive documents: their own scripts render and
 * re-render their mock figures. Backend wiring therefore cannot be a one-shot
 * "replace the text" — the design would write its sample values straight back
 * over the real ones on the next click. The binders below own the elements they
 * are given:
 *
 *  - `bindText` / `bindHtml` apply a value, then watch the subtree with a
 *    MutationObserver and re-apply whenever anything (the design's scripts
 *    included) writes elsewhere. The writer wins once, our value wins in the
 *    end, and the observer settles because re-applying an unchanged value does
 *    not mutate again.
 *  - Elements are re-resolved by selector when the design rebuilds their
 *    container, so a re-rendered list cannot quietly detach a live value.
 *  - `on` delegates from the mount root, so listeners survive the design
 *    replacing the markup beneath them.
 *
 * All of it runs inside `DesignFrame`'s `onReady(root)` and is torn down by the
 * cleanup it returns.
 */

export type WireCleanup = () => void;

/** A value that should be true on the page no matter what the design writes. */
export interface BoundSlot {
  /** Selector resolved inside the mount root, or a specific element. */
  at: string | Element;
  /** Current truth. Called on every application, so async data flows in via closure state. */
  value: () => string;
}

export interface Binder {
  /** Re-apply now (after a fetch resolves, or after an action changed the truth). */
  apply(): void;
  /** Stop watching — returned as the wiring cleanup. */
  cleanup(): void;
}

export function sel<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

export function all(root: ParentNode, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector));
}

/** Resolves a slot's element, re-resolving after the design rebuilt its container. */
function resolve(root: HTMLElement, slot: BoundSlot): Element | null {
  if (typeof slot.at === "string") return root.querySelector(slot.at);
  return slot.at.isConnected ? slot.at : null;
}

/**
 * Text slots the design must not be allowed to overwrite with sample values.
 *
 * ```ts
 * const binder = bindText(root, [{ at: "#available", value: () => balanceText }]);
 * load().then(() => binder.apply());
 * return binder.cleanup;
 * ```
 */
export function bindText(root: HTMLElement, slots: BoundSlot[]): Binder {
  let stopped = false;

  const apply = (): void => {
    if (stopped) return;
    for (const slot of slots) {
      const element = resolve(root, slot);
      if (!element) continue;
      const value = slot.value();
      if (element.textContent !== value) element.textContent = value;
    }
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { subtree: true, childList: true, characterData: true });

  return {
    apply,
    cleanup: () => {
      stopped = true;
      observer.disconnect();
    },
  };
}

/**
 * Like `bindText`, but for containers whose rows this wiring renders itself.
 * Compares `innerHTML` so a design re-render of the same container is replaced
 * again, while our own write settles immediately.
 */
export function bindHtml(root: HTMLElement, slots: BoundSlot[]): Binder {
  let stopped = false;

  const apply = (): void => {
    if (stopped) return;
    for (const slot of slots) {
      const element = resolve(root, slot);
      if (!element) continue;
      const value = slot.value();
      if (element.innerHTML !== value) element.innerHTML = value;
    }
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { subtree: true, childList: true, characterData: true });

  return {
    apply,
    cleanup: () => {
      stopped = true;
      observer.disconnect();
    },
  };
}

/**
 * Server-owned input values (a balance the MAX button copies, a disabled
 * state). Re-applies after clicks and changes — when the design's own handlers
 * set `.value` programmatically — but deliberately not on `input`, so a visitor
 * typing an amount is never interrupted.
 */
export function bindValue(root: HTMLElement, slots: BoundSlot[]): Binder {
  let stopped = false;
  const apply = (): void => {
    if (stopped) return;
    for (const slot of slots) {
      const element = resolve(root, slot);
      if (!(element instanceof HTMLInputElement)) continue;
      const value = slot.value();
      if (element.value !== value) element.value = value;
    }
  };

  apply();
  const debounced = (): void => {
    window.setTimeout(apply, 0);
  };
  root.addEventListener("click", debounced);
  root.addEventListener("change", debounced);
  const observer = new MutationObserver(debounced);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["disabled", "max", "min"],
  });

  return {
    apply,
    cleanup: () => {
      stopped = true;
      root.removeEventListener("click", debounced);
      root.removeEventListener("change", debounced);
      observer.disconnect();
    },
  };
}

/**
 * Delegated listener attached to the mount root, so it keeps working when the
 * design replaces the markup underneath it. Returns the removal function.
 */
export function on<K extends keyof HTMLElementEventMap>(
  root: HTMLElement,
  selector: string,
  type: K | "click" | "input" | "change" | "submit",
  handler: (event: HTMLElementEventMap[K], target: Element) => void,
): WireCleanup {
  const listener = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) {
      handler(event as HTMLElementEventMap[K], target);
    }
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

/** Runs `run` on the next task, after every design handler for the event. */
export function afterEvents(root: HTMLElement, events: string[], run: () => void): WireCleanup {
  const schedule = (): void => {
    window.setTimeout(run, 0);
  };
  for (const type of events) root.addEventListener(type, schedule);
  return () => {
    for (const type of events) root.removeEventListener(type, schedule);
  };
}

/**
 * Shows a message in the design's own toast. The designs disagree on the
 * visibility class (`show` here, `on` in the dashboards); setting both is
 * harmless — each page's stylesheet defines only its own — and means wiring
 * code never has to care which one it picked.
 *
 * The designs only ever dismiss the toast from *their own* `toast()`, so a
 * message raised from here would sit on the page until something else cleared
 * it. This schedules the dismissal they would have scheduled, re-armed by each
 * new message and keyed to the element so repeated calls share one timer.
 */
const toastTimers = new WeakMap<Element, number>();

export function toast(root: HTMLElement, message: string): void {
  const element = sel(root, "#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show", "on");

  const previous = toastTimers.get(element);
  if (previous !== undefined) window.clearTimeout(previous);

  toastTimers.set(
    element,
    window.setTimeout(() => {
      element.classList.remove("show", "on");
      toastTimers.delete(element);
    }, 6_000),
  );
}

/** Collapses a set of cleanups (binders and listeners) into one. */
export function cleanupAll(...items: Array<WireCleanup | Binder | undefined>): WireCleanup {
  return () => {
    for (const item of items) {
      if (!item) continue;
      if (typeof item === "function") item();
      else item.cleanup();
    }
  };
}

/** The standard way to speak an API failure to a human (house pattern). */
export function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}
