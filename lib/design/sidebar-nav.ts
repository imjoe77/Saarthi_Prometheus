import { visibleNavSections, type NavSection, type RoleName } from "@/lib/rbac";

/**
 * The ported `nav.dside` sidebar, rewritten onto the app's real routes
 * (MODULE: design integration).
 *
 * The designs ship a sidebar whose links point at mock destinations
 * (`/discover`, `#trading-buddy`, duplicate entries). The layout around it —
 * the fixed rail, the two labelled dock groups, the sliding `.molten` hover
 * indicator and the `#menu` collapse-to-top animation — is kept exactly as
 * designed; only the anchors inside the docks are rebuilt, from the same
 * RBAC source the AppShell sidebar uses (`lib/rbac.ts`), including the
 * expert/liquidity persona rewrites of `/dashboard` and `/portfolio`.
 *
 * The design's own scripts interact with this markup in two places, and both
 * stay correct:
 *
 *  - the `#menu` collapse handler only toggles `.app.off` and never reads the
 *    anchors, so it is untouched;
 *  - the `.molten` IIFE binds per-link hover listeners and captures the `.on`
 *    anchor of *whatever markup exists when the scripts append* — hence
 *    `applySidebarNav` runs before script insertion. When the sidebar is
 *    rebuilt later (roles arriving, a persona change), the design's dock-level
 *    listeners are still bound to detached anchors; the listeners installed
 *    here are bound after the design's, so on every contested event (dock
 *    mouseleave, focusout, window resize) the fresh placement runs last and
 *    wins.
 *
 * Everything is scoped to `nav.dside`: designs with a different nav
 * (`nav.toplinks`, the admin chrome) are deliberately left alone.
 */

interface SidebarItem {
  name: string;
  href: string;
  aliases: string[];
  key: NavSection["iconKey"];
  /** Inner SVG markup, drawn in the design's own 24×24 stroke language. */
  icon: string;
}

export interface SidebarGroups {
  platform: SidebarItem[];
  finance: SidebarItem[];
}

/**
 * Icon geometry per nav key. The seven reused icons (`dashboard`, `usdt`,
 * `copy`, `portfolio`, `tokenomics`, `staking`, `treasury`) are verbatim from
 * the design's own dock anchors; the rest are drawn to match that same
 * 24×24, `fill:none; stroke:currentColor` language the design CSS applies to
 * `.dock a svg`.
 */
const ICONS: Record<NavSection["iconKey"], string> = {
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  onboarding:
    '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
  copy: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5M17 8v6M14 11h6"/>',
  usdt: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  portfolio: '<path d="M3 3v18h18M7 12l3-3 4 4 5-6"/>',
  tokenomics:
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h3.5a2 2 0 0 1 0 4h-2a2 2 0 0 0 0 4h4"/>',
  hub: '<path d="M6.5 8h11l-.9 12H7.4z"/><path d="M9.2 8a2.8 2.8 0 0 1 5.6 0"/>',
  staking: '<path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/>',
  blockchain:
    '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M11 7h4.5a2.5 2.5 0 0 1 2.5 2.5V13"/>',
  wallet:
    '<path d="M4 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-1-1V7z"/><path d="M4 7V6a2 2 0 0 1 2-2h9v3"/><path d="M16 13h2"/>',
  treasury: '<path d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18"/>',
  discover:
    '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  expert:
    '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  liquidity:
    '<path d="M12 3.5s5.2 5.6 5.2 9.2a5.2 5.2 0 0 1-10.4 0C6.8 9.1 12 3.5 12 3.5z"/>',
  sentinel:
    '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  admin: '<path d="M12 3l7.5 2.8V12c0 4.6-3.1 7.4-7.5 8.5C7.6 19.4 4.5 16.6 4.5 12V5.8z"/><path d="M9 12l2 2 4-4"/>',
};

/** Which dock group a nav key belongs to (mirrors the design's two-group rail). */
const PLATFORM_KEYS: ReadonlySet<NavSection["iconKey"]> = new Set([
  "dashboard",
  "onboarding",
  "copy",
  "usdt",
  "terminal",
  "discover",
  "sentinel",
  "expert",
  "liquidity",
  "blockchain",
  "treasury",
  "admin",
]);

/**
 * The pre-RBAC base set, shown only while the role fetch is still in flight —
 * the same nine ungated entries `components/AppShell.tsx` shows for the same
 * reason, so both sidebars agree during the load.
 */
const BASE_SECTIONS: ReadonlyArray<
  Pick<NavSection, "name" | "href" | "aliases" | "iconKey">
> = [
  { name: "Dashboard", href: "/dashboard", aliases: [], iconKey: "dashboard" },
  { name: "Onboarding", href: "/onboarding", aliases: [], iconKey: "onboarding" },
  { name: "Copy Trading", href: "/copy-trading", aliases: ["/copytrading"], iconKey: "copy" },
  { name: "USDT Exchange", href: "/usdt-exchange", aliases: ["/usdt"], iconKey: "usdt" },
  { name: "Portfolio", href: "/portfolio", aliases: [], iconKey: "portfolio" },
  { name: "EMBER & Tokenomics", href: "/tokenomics", aliases: ["/ember"], iconKey: "tokenomics" },
  { name: "EMBER Hub", href: "/ember-hub", aliases: ["/emberhub"], iconKey: "hub" },
  { name: "Wallet & Activity", href: "/wallet", aliases: ["/activity"], iconKey: "wallet" },
  { name: "Discover Strategies", href: "/discover", aliases: ["/strategies"], iconKey: "discover" },
];

/**
 * Rewrites a shared nav route onto the persona's own design variant, if it has
 * one — the same narrowing `components/AppShell.tsx` applies, so the two
 * sidebars send an expert to `/expert/dashboard`, not `/dashboard`.
 */
function personaRoute(href: string, activeRole: RoleName | null): string {
  if (activeRole === "EXPERT_TRADER" && (href === "/dashboard" || href === "/portfolio")) {
    return `/expert${href}`;
  }
  if (activeRole === "LIQUIDITY_PROVIDER" && (href === "/dashboard" || href === "/portfolio")) {
    return `/liquidity${href}`;
  }
  return href;
}

/** Builds the sidebar's items from the same RBAC source as the AppShell nav. */
export function sidebarGroupsFor(
  roles: RoleName[],
  activeRole: RoleName | null,
  rolesLoading: boolean,
): SidebarGroups {
  const items: SidebarItem[] =
    rolesLoading && roles.length === 0
      ? BASE_SECTIONS.map((section) => ({
          name: section.name,
          href: section.href,
          aliases: [...section.aliases],
          key: section.iconKey,
          icon: ICONS[section.iconKey],
        }))
      : visibleNavSections(roles).map((section) => ({
          name: section.name,
          // The persona variant counts as current for the shared route too
          // (the aliases carry the shared href), same as the AppShell.
          href: personaRoute(section.href, activeRole),
          aliases: [...section.aliases, section.href],
          key: section.iconKey,
          icon: ICONS[section.iconKey],
        }));

  const group = (wanted: boolean) =>
    items.filter((item) => PLATFORM_KEYS.has(item.key) === wanted);
  return { platform: group(true), finance: group(false) };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isCurrent(item: SidebarItem, pathname: string): boolean {
  return item.href === pathname || item.aliases.includes(pathname);
}

function anchorHtml(item: SidebarItem, active: boolean): string {
  return (
    `<a href="${escapeHtml(item.href)}"` +
    (active ? ' class="on" aria-current="page"' : "") +
    `><span class="nic"><svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg></span>` +
    `<span class="ntx">${escapeHtml(item.name)}</span></a>`
  );
}

/** Hides a `.grp`/`.dock` pair cleanly (author `display` rules beat `[hidden]`). */
function setGroupVisible(element: HTMLElement | undefined, visible: boolean): void {
  if (!element) return;
  element.hidden = !visible;
  element.style.display = visible ? "" : "none";
}

function activeAnchor(dock: HTMLElement): HTMLAnchorElement | null {
  return (
    dock.querySelector<HTMLAnchorElement>("a.on") ??
    dock.querySelector<HTMLAnchorElement>("a")
  );
}

/** The design's `.molten` placement, applied to the dock's own indicator. */
function placeMolten(dock: HTMLElement, anchor: HTMLAnchorElement | null, now = false): void {
  const marker = dock.querySelector<HTMLElement>(".molten");
  if (!marker || !anchor) return;
  if (now) marker.style.transition = "none";
  marker.style.top = `${anchor.offsetTop}px`;
  marker.style.height = `${anchor.offsetHeight}px`;
  marker.style.opacity = "1";
  if (now) {
    void marker.offsetHeight;
    marker.style.transition = "";
  }
}

const hoverAnchors = new WeakSet<HTMLAnchorElement>();

function bindAnchorHover(anchor: HTMLAnchorElement): void {
  if (hoverAnchors.has(anchor)) return;
  hoverAnchors.add(anchor);
  const move = () => {
    const dock = anchor.parentElement;
    if (dock) placeMolten(dock, anchor);
  };
  anchor.addEventListener("mouseenter", move);
  anchor.addEventListener("focus", move);
}

/**
 * Rebuilds every `nav.dside`'s dock anchors from `groups` and lights the entry
 * for `pathname`. Idempotent: a nav whose items and pathname are unchanged is
 * skipped, which also keeps the design's captured `.on` anchor alive.
 */
export function applySidebarNav(
  root: HTMLElement,
  groups: SidebarGroups,
  pathname: string,
): void {
  const signature = JSON.stringify([
    groups.platform.map((item) => item.href),
    groups.finance.map((item) => item.href),
    pathname,
  ]);

  for (const nav of root.querySelectorAll<HTMLElement>("nav.dside")) {
    const docks = Array.from(nav.querySelectorAll<HTMLElement>(":scope > .dock"));
    const labels = Array.from(nav.querySelectorAll<HTMLElement>(":scope > .grp"));
    if (docks.length === 0 || nav.dataset.pbNavSig === signature) continue;
    nav.dataset.pbNavSig = signature;

    // A two-dock design keeps the Platform/Finance split; a single-dock design
    // gets everything in its one dock.
    const plan: SidebarItem[][] =
      docks.length > 1
        ? [groups.platform, groups.finance]
        : [[...groups.platform, ...groups.finance]];

    docks.forEach((dock, index) => {
      for (const anchor of Array.from(dock.querySelectorAll("a"))) anchor.remove();
      const items = plan[index] ?? [];
      if (items.length > 0) {
        const fragment = document
          .createRange()
          .createContextualFragment(
            items.map((item) => anchorHtml(item, isCurrent(item, pathname))).join(""),
          );
        dock.appendChild(fragment);
        for (const anchor of dock.querySelectorAll("a")) bindAnchorHover(anchor);
      }
      // An empty group (an admin's Finance dock, a user's second dock) is
      // hidden outright so the collapse-to-top rail shows no dead divider.
      setGroupVisible(dock, items.length > 0);
      setGroupVisible(labels[index], items.length > 0);
      placeMolten(dock, activeAnchor(dock), true);
    });
  }
}

/* ------------------------------------------------------------------ *
 * SPA navigation + indicator ownership.                               *
 * Bound once per nav, after the design's scripts have run, so these  *
 * listeners always fire after the design's own (detached-anchor)     *
 * ones and settle every contested event.                             *
 * ------------------------------------------------------------------ */

const navigateByNav = new WeakMap<HTMLElement, (href: string) => void>();
const wiredNavs = new Set<HTMLElement>();

function onClick(event: MouseEvent): void {
  const nav = event.currentTarget as HTMLElement;
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor || !nav.contains(anchor)) return;
  const href = anchor.getAttribute("href");
  // Modified clicks and non-route hrefs (in-page `#…`) keep their native
  // behaviour; only a plain left click on a route becomes an SPA transition.
  if (!href || !href.startsWith("/")) return;
  event.preventDefault();
  navigateByNav.get(nav)?.(href);
}

function onDockLeave(event: MouseEvent): void {
  const dock = event.currentTarget as HTMLElement;
  placeMolten(dock, activeAnchor(dock));
}

function onDockFocusOut(event: FocusEvent): void {
  const dock = event.currentTarget as HTMLElement;
  if (!dock.contains(event.relatedTarget as Node | null)) {
    placeMolten(dock, activeAnchor(dock));
  }
}

function onWindowResize(): void {
  for (const nav of wiredNavs) {
    for (const dock of nav.querySelectorAll<HTMLElement>(".dock")) {
      placeMolten(dock, activeAnchor(dock), true);
    }
  }
}

/**
 * Takes ownership of SPA navigation and the `.molten` indicator for every
 * `nav.dside` under `root`, and updates the navigation callback used by links
 * already bound (pages re-render while wiring, so the callback is read through
 * this map at click time).
 */
export function bindSidebarNav(root: HTMLElement, navigate: (href: string) => void): void {
  for (const nav of root.querySelectorAll<HTMLElement>("nav.dside")) {
    navigateByNav.set(nav, navigate);
    if (wiredNavs.has(nav)) continue;
    wiredNavs.add(nav);
    nav.addEventListener("click", onClick);
    for (const dock of nav.querySelectorAll<HTMLElement>(".dock")) {
      dock.addEventListener("mouseleave", onDockLeave);
      dock.addEventListener("focusout", onDockFocusOut);
    }
    for (const anchor of nav.querySelectorAll<HTMLAnchorElement>("a")) {
      bindAnchorHover(anchor);
    }
    placeMoltenDock(nav);
  }
  if (wiredNavs.size > 0) window.addEventListener("resize", onWindowResize);
}

function placeMoltenDock(nav: HTMLElement): void {
  for (const dock of nav.querySelectorAll<HTMLElement>(".dock")) {
    placeMolten(dock, activeAnchor(dock), true);
  }
}

/** Removes every listener this module bound under `root` (page unmount). */
export function unbindSidebarNav(root: HTMLElement): void {
  for (const nav of root.querySelectorAll<HTMLElement>("nav.dside")) {
    if (!wiredNavs.has(nav)) continue;
    wiredNavs.delete(nav);
    nav.removeEventListener("click", onClick);
    for (const dock of nav.querySelectorAll<HTMLElement>(".dock")) {
      dock.removeEventListener("mouseleave", onDockLeave);
      dock.removeEventListener("focusout", onDockFocusOut);
    }
  }
  if (wiredNavs.size === 0) window.removeEventListener("resize", onWindowResize);
}

/* ------------------------------------------------------------------ *
 * React-rendered sidebar (AppShell).                                  *
 *                                                                    *
 * The AppShell renders the same `nav.dside` markup from React         *
 * (`components/AppShell.tsx`), so the anchors are real React children *
 * and navigation is plain Next <Link> — no preventDefault path, no    *
 * rebuild-on-signature. What must survive React swapping those        *
 * anchors (roles resolving, a route change) is the `.molten`          *
 * indicator, so every listener here is delegated to the nav or the    *
 * window rather than attached to an individual anchor. DesignFrame    *
 * pages keep the imperative path above; both share `placeMolten`, the *
 * dock geometry and the base/RBAC item builder.                       *
 * ------------------------------------------------------------------ */

/** Recomputes every dock's `.molten` placement under `nav`, right now. */
export function syncMoltenNav(nav: HTMLElement): void {
  placeMoltenDock(nav);
}

/**
 * Hover/focus tracking plus resize re-measurement for a React-rendered nav.
 * Returns the disposer to call on unmount (Safe under StrictMode's
 * mount → unmount → mount).
 */
export function bindMoltenNav(nav: HTMLElement): () => void {
  const anchorFor = (target: EventTarget | null): HTMLAnchorElement | null => {
    const element = (target as Element | null)?.closest?.("a");
    return element && nav.contains(element) ? (element as HTMLAnchorElement) : null;
  };

  // Pointer/focus enters an anchor: slide the indicator under it. Delegated,
  // so anchors React has just committed are covered without re-binding.
  const onOver = (event: Event): void => {
    const anchor = anchorFor(event.target);
    const dock = anchor?.parentElement;
    if (anchor && dock?.classList.contains("dock")) placeMolten(dock, anchor);
  };

  // Pointer/focus leaves a dock (or the window): settle back on the active
  // entry — the contract the design's own mouseleave/focusout handlers have.
  const onOut = (event: MouseEvent | FocusEvent): void => {
    const element = (event.target as Element | null)?.closest?.(".dock");
    if (!element || !nav.contains(element)) return;
    if (element.contains(event.relatedTarget as Node | null)) return;
    placeMolten(element as HTMLElement, activeAnchor(element as HTMLElement));
  };

  const onResize = (): void => placeMoltenDock(nav);

  nav.addEventListener("mouseover", onOver);
  nav.addEventListener("mouseout", onOut);
  nav.addEventListener("focusin", onOver);
  nav.addEventListener("focusout", onOut);
  window.addEventListener("resize", onResize);
  placeMoltenDock(nav);

  return () => {
    nav.removeEventListener("mouseover", onOver);
    nav.removeEventListener("mouseout", onOut);
    nav.removeEventListener("focusin", onOver);
    nav.removeEventListener("focusout", onOut);
    window.removeEventListener("resize", onResize);
  };
}
