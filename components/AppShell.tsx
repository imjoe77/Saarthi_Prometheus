"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";

import AuthControls from "@/components/AuthControls";
import { useRoles } from "@/components/RoleProvider";
import { clearApiToken } from "@/lib/auth-actions";
import { bindMoltenNav, sidebarGroupsFor, syncMoltenNav } from "@/lib/design/sidebar-nav";
import { shellSidebarStyles } from "@/lib/design/shell-sidebar-styles";
import { type RoleName } from "@/lib/rbac";

/** Human labels for the sidebar's identity block (`.dside .me`). */
const ROLE_LABEL: Record<RoleName, string> = {
  USER: "Trader",
  EXPERT_TRADER: "Expert trader",
  LIQUIDITY_PROVIDER: "Liquidity provider",
  PLATFORM_ADMIN: "Platform admin",
};

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * MODULE 02 — the application chrome.
 *
 * A client component because it needs `useState` and `usePathname`. The session
 * arrives through `useSession()`, which reads Auth.js's own encrypted cookie and
 * exposes nothing an attacker did not already hold: the provider identity and
 * the address the user signed in with.
 *
 * The access token is deliberately absent from that cookie and never reaches
 * the browser. It lives in a separate HttpOnly cookie this component cannot read,
 * which is what keeps an XSS bug from exfiltrating a usable credential.
 *
 * The chrome around the session controls is the ported design sidebar
 * (MODULE: design integration): the fixed `nav.dside` rail with its two
 * labelled dock groups, the sliding `.molten` hover indicator and the `#menu`
 * collapse-to-top animation, ported verbatim by
 * `lib/design/shell-sidebar-styles.ts`. The anchors are React children built
 * from `sidebarGroupsFor()` — the same RBAC source and persona rewrites the
 * design-frame pages use — so every page in the shell shows one sidebar:
 * Next <Link> handles the SPA transition, the `.on` class lights the current
 * route (aliases included), and `bindMoltenNav` owns the indicator with
 * delegated listeners that survive React swapping the anchors when roles
 * resolve or the route changes.
 */
export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  // MODULE 13: role-aware navigation. Admin sees only the admin surface;
  // expert/liquidity entries appear only when the caller holds those roles.
  // While roles are still loading `sidebarGroupsFor` renders the base
  // (pre-RBAC) set so the sidebar does not flash empty; the API still denies
  // anything gated.
  const { roles, activeRole, loading: rolesLoading } = useRoles();
  const navGroups = useMemo(
    () => sidebarGroupsFor(roles, activeRole, rolesLoading),
    [roles, activeRole, rolesLoading],
  );

  const navRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Bind once per mount: every listener is delegated to the nav (or the
  // window), so React re-rendering the anchors inside never orphans them.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    return bindMoltenNav(nav);
  }, []);

  // Re-measure after React commits a new set of anchors: the role fetch
  // resolving, a persona change, or a route change moving the `.on` entry.
  useEffect(() => {
    const nav = navRef.current;
    if (nav) syncMoltenNav(nav);
  }, [navGroups, pathname]);

  // The design's #menu handler: toggle `.off`, then let the indicator
  // re-measure once the .45s collapse transition has settled.
  const toggleSidebar = () => {
    setCollapsed((was) => !was);
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 480);
  };

  const isCurrent = (item: (typeof navGroups)["platform"][number]): boolean =>
    item.href === pathname || item.aliases.includes(pathname);

  const anchor = (item: (typeof navGroups)["platform"][number]) => {
    const active = isCurrent(item);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={active ? "on" : undefined}
        aria-current={active ? "page" : undefined}
      >
        <span className="nic">
          <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: item.icon }} />
        </span>
        <span className="ntx">{item.name}</span>
      </Link>
    );
  };

  return (
    <div
      className={`pb-shell${collapsed ? " off" : ""} h-screen w-screen overflow-hidden bg-[#0B0D10] text-[#F3F4F6] font-sans antialiased select-none`}
    >
      <style dangerouslySetInnerHTML={{ __html: shellSidebarStyles }} />

      {/* LEFT SIDEBAR — the ported design rail. React owns the static shell
          (logo, group labels, docks, `.molten` markers, identity); the dock
          anchors are rebuilt from the RBAC model on every render. */}
      <nav className="dside" aria-label="Main" ref={navRef}>
        <Link href="/" className="logo">
          <Image
            src="/assets/prometheus-logo.png"
            alt=""
            width={36}
            height={36}
            priority
            className="mark"
          />
          <span className="wm">PROMETHEUS</span>
        </Link>

        {navGroups.platform.length > 0 && (
          <>
            <div className="grp">Platform</div>
            <div className="dock">
              <span className="molten" aria-hidden="true" />
              {navGroups.platform.map(anchor)}
            </div>
          </>
        )}
        {navGroups.finance.length > 0 && (
          <>
            <div className="grp">Finance</div>
            <div className="dock">
              <span className="molten" aria-hidden="true" />
              {navGroups.finance.map(anchor)}
            </div>
          </>
        )}

        {session?.user?.email && (
          <>
            <div className="me">
              <i aria-hidden="true" />
              <div>
                <b>{session.user.email.split("@")[0]}</b>
                {activeRole ? ROLE_LABEL[activeRole] : "Member"}
              </div>
            </div>

            {/* MODULE 02: sign-out lives with the identity it belongs to, so
                the rail answers "who am I" and "leave" in one place. The
                header's own Sign out control stays; this is the same action
                (clear the API token cookie, then end the Auth.js session),
                reachable without hunting for the header. The label folds away
                at narrow widths and in the collapsed rail (icon-only), so the
                button carries its own accessible name and tooltip rather than
                relying on the text. */}
            <button
              type="button"
              className="me-out"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                await clearApiToken();
                await signOut({ redirectTo: "/" });
              }}
            >
              <span className="nic" aria-hidden="true">
                <LogOut size={16} />
              </span>
              <span className="ntx">Sign out</span>
            </button>
          </>
        )}
      </nav>

      {/* MAIN CONTAINER */}
      <div className="pb-main">
        {/* TOP HEADER BAR */}
        <header className="h-16 shrink-0 border-b border-[#1B2028] bg-[#0E1116] px-6 flex items-center justify-between z-10">
          {/* The design's collapse toggle (its `#menu`), in the header's left slot. */}
          <button
            type="button"
            id="menu"
            className="menu-btn"
            aria-label="Toggle menu"
            aria-expanded={!collapsed}
            onClick={toggleSidebar}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          {/* MODULE 02: session controls, replacing the placeholder avatar. */}
          <AuthControls email={session?.user?.email ?? null} provider={session?.provider ?? null} />
        </header>

        {/* MAIN SCROLLABLE CONTENT */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-[#0B0D10]">
          {children}
        </main>
      </div>
    </div>
  );
}
