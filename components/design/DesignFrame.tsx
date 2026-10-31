"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";

import { useRoles } from "@/components/RoleProvider";
import { clearApiToken } from "@/lib/auth-actions";
import {
  applySidebarNav,
  bindSidebarNav,
  sidebarGroupsFor,
  unbindSidebarNav,
} from "@/lib/design/sidebar-nav";
import {
  applySidebarSignOut,
  removeSidebarSignOut,
  setSidebarSignOutActive,
} from "@/lib/design/sidebar-signout";
import type { DesignSpec } from "@/lib/design/types";

/**
 * What a ported design page scheduled while it was mounted (MODULE: design
 * integration).
 *
 * Populated by the wrapper that `scripts/extract-designs.mjs` puts around every
 * inline script: inside that wrapper the timer globals are shadowed, so only
 * design code is recorded here and only design code can be cancelled from here.
 * React's, Next's and the app's own timers are never touched.
 */
interface ScriptRegistry {
  intervals: number[];
  timeouts: number[];
  frames: number[];
}

declare global {
  interface Window {
    __pbReg?: ScriptRegistry;
  }
}

interface DesignFrameProps {
  /** One extracted design (`lib/design/generated/*`). */
  design: DesignSpec;
  /**
   * Called once the markup is mounted and the design's scripts have run, so
   * wiring can bind to the exact DOM the design built. Return a cleanup for
   * listeners/observers. Pass a module-level function, not an inline closure.
   */
  onReady?: (root: HTMLElement) => void | (() => void);
}

/**
 * Mounts one design page exactly as its original HTML document behaved.
 *
 * The three inert pieces — stylesheet, markup, scripts — are reassembled in the
 * browser, because a `<script>` injected through `innerHTML` parses but never
 * executes: the frame appends real script elements after the markup exists, in
 * the original document order, then hands the finished DOM to `onReady` for
 * backend wiring.
 *
 * Lifecycle details that make "standalone, as designed" work inside an SPA:
 *
 *  - `<title>` and `data-theme` are set for the duration of the mount and
 *    restored on unmount, so a theme toggle on one page cannot repaint the next
 *    and the browser tab names the right page.
 *  - External stylesheets (Google Fonts) are appended idempotently and removed
 *    on unmount; they are per-page, not global, so no other route pays for them.
 *  - The scripts run once per host element. React StrictMode re-runs effects
 *    against the same DOM, and a second run of the design's IIFEs would double
 *    every listener they install; a real navigation always gets a fresh host.
 *  - Timers the design scheduled are drained on unmount — deferred by a
 *    microtask and skipped while the host is still connected, so StrictMode's
 *    throwaway cleanup does not kill the animations it is about to re-use.
 */
export default function DesignFrame({ design, onReady }: DesignFrameProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Kept across StrictMode's second effect run so the intervals registered by
  // the first run are still cancellable when the page really goes away.
  const registryRef = useRef<ScriptRegistry | null>(null);
  // Read through a ref: pages re-render while wiring, and a fresh inline
  // closure every render would re-run the whole mount effect. The ref is only
  // written inside an effect — React refs are not render-time values.
  const onReadyRef = useRef<DesignFrameProps["onReady"]>(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  // The sign-out belongs to the sidebar, and the sidebar belongs to the design.
  // The button itself is injected into the mounted markup (the design owns
  // that DOM), so it is kept in a ref rather than rendered by React.
  const signOutRef = useRef<HTMLButtonElement | null>(null);
  // The session resolves after the design is mounted, so the button's
  // visibility follows it through a ref the mount effect can read at any time.
  const sessionEmailRef = useRef<string | null>(null);
  const { roles, activeRole, loading: rolesLoading } = useRoles();
  // Same RBAC model the AppShell sidebar renders: base set while the role
  // fetch is in flight, the persona-aware section list once it resolves.
  const navGroups = useMemo(
    () => sidebarGroupsFor(roles, activeRole, rolesLoading),
    [roles, activeRole, rolesLoading],
  );
  // The mount effect runs once per design but must apply the *current* nav
  // model, so it reads these through a ref refreshed on every render.
  const navRef = useRef({ groups: navGroups, pathname });
  const routerRef = useRef(router);
  useEffect(() => {
    navRef.current = { groups: navGroups, pathname };
    routerRef.current = router;
  });

  // The sidebar's sign-out only exists for a signed-in visitor. The session
  // arrives after the design is mounted, so both the ref and the injected
  // button follow it: the mount effect reads the ref when it builds the
  // button, and this effect re-checks the button whenever the session changes.
  useEffect(() => {
    sessionEmailRef.current = session?.user?.email ?? null;
    setSidebarSignOutActive(signOutRef.current, sessionEmailRef.current !== null);
  }, [session]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let wireCleanup: void | (() => void);

    const registry = registryRef.current ?? { intervals: [], timeouts: [], frames: [] };
    registryRef.current = registry;
    window.__pbReg = registry;

    const previousTitle = document.title;
    const previousTheme = document.documentElement.getAttribute("data-theme");
    document.title = design.title;
    if (design.theme) document.documentElement.setAttribute("data-theme", design.theme);

    // The design's own scripts read `<body data-view="…">` to choose which
    // workspace to show, so these go on before any script is appended — and
    // come off again on unmount, one navigation at a time.
    const previousBodyAttrs = Object.entries(design.bodyAttrs ?? {}).map(([name, value]) => {
      const previous = document.body.getAttribute(name);
      document.body.setAttribute(name, value);
      return [name, previous] as const;
    });

    const links = design.stylesheets.map((href) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
      return link;
    });

    // The sidebar's mock anchors are replaced with the app's real routes
    // *before* any script is appended: the design's `.molten` indicator IIFE
    // binds per-link listeners and captures the `.on` anchor at that moment,
    // so it must see the final markup (see `lib/design/sidebar-nav.ts`).
    applySidebarNav(host, navRef.current.groups, navRef.current.pathname);

    if (host.dataset.pbScripts !== "done") {
      for (const script of design.scripts) {
        const node = document.createElement("script");
        if (script.src) {
          // External scripts default to async insertion; forcing the in-order
          // list preserves the original document order between them.
          node.src = script.src;
          node.async = false;
        } else {
          node.textContent = script.code ?? "";
        }
        host.appendChild(node);
      }
      host.dataset.pbScripts = "done";
    }

    // Inline scripts run during insertion; the external one is still fetching.
    // Deferring by a task puts wiring strictly after every queued script, and
    // the disposed flag keeps StrictMode's cancelled run from wiring at all.
    const wireTimer = window.setTimeout(() => {
      if (disposed) return;
      // SPA navigation + indicator ownership, bound after the design's own
      // listeners so ours settle every contested event (see sidebar-nav.ts).
      bindSidebarNav(host, (href) => {
        void routerRef.current.push(href);
      });
      wireCleanup = onReadyRef.current?.(host) ?? undefined;

      // The design's sidebar carries the identity but no way out of the
      // account, so the exit is added to it here — after the page's own wiring
      // has filled that identity in.
      const signOutButton = applySidebarSignOut(host);
      signOutRef.current = signOutButton;

      if (signOutButton) {
        setSidebarSignOutActive(signOutButton, sessionEmailRef.current !== null);
        signOutButton.addEventListener("click", () => {
          void endSession();
        });
      }
    }, 0);
    return () => {
      disposed = true;
      window.clearTimeout(wireTimer);
      if (typeof wireCleanup === "function") wireCleanup();
      unbindSidebarNav(host);
      removeSidebarSignOut();
      signOutRef.current = null;

      for (const link of links) link.remove();
      document.title = previousTitle;
      if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", previousTheme);
      for (const [name, previous] of previousBodyAttrs) {
        if (previous === null) document.body.removeAttribute(name);
        else document.body.setAttribute(name, previous);
      }

      queueMicrotask(() => {
        if (host.isConnected) return; // StrictMode throwaway: keep animating.
        for (const id of registry.intervals) window.clearInterval(id);
        for (const id of registry.timeouts) window.clearTimeout(id);
        for (const id of registry.frames) window.cancelAnimationFrame(id);
        registry.intervals = [];
        registry.timeouts = [];
        registry.frames = [];
        if (registryRef.current === registry) registryRef.current = null;
      });
    };
  }, [design]);

  /**
   * Re-apply the sidebar when its inputs change after mount: the role fetch
   * resolving swaps the loading base set for the persona-aware list, and a
   * pathname change re-lights the active anchor. `applySidebarNav` is a no-op
   * when nothing changed (it tracks a signature on the nav element), and the
   * design's scripts only ever ran once, so a rebuilt sidebar keeps working:
   * our listeners were bound after the design's and own every contested event.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    applySidebarNav(host, navGroups, pathname);
  }, [navGroups, pathname]);

  /**
   * Keep the design's title in the tab for as long as it is mounted.
   *
   * The layout's `<title>` (React's hoisted metadata) is re-inserted by any
   * commit that touches the head — a role fetch resolving, a session updating
   * — and a commit does not re-render this component, so writing the title in
   * this component's own effects is not enough: the app's default title can
   * land *after* the last one of them. An observer on `<head>` closes that
   * gap by making the correction event-driven. Our own write re-triggers it,
   * but the values then agree, so it settles instead of looping.
   *
   * Unmount restoration stays with the mount effect above, whose cleanup is
   * the only place that runs last.
   */
  useEffect(() => {
    document.title = design.title;
    let disposed = false;
    const observer = new MutationObserver(() => {
      // The mount effect's cleanup restores the previous title during
      // unmount; a queued callback must not fight that write, so the flag is
      // raised before the observer is dropped.
      if (disposed) return;
      if (document.title !== design.title) document.title = design.title;
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [design]);

  return (
    <div ref={hostRef} data-pb-design="">
      <style>{design.css}</style>
      <div dangerouslySetInnerHTML={{ __html: design.html }} />
    </div>
  );
}

/**
 * Ends the session the way the AppShell's own sign-out does.
 *
 * The API token cookie is HttpOnly, so the server action is the only thing
 * that can retire it; Auth.js's `signOut` then clears the session cookie and
 * returns to the landing page. The order matters — the token goes first.
 */
async function endSession(): Promise<void> {
  await clearApiToken();
  await signOut({ redirectTo: "/" });
}
