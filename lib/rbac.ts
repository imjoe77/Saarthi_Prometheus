/**
 * MODULE 13 — client-side role helpers and the route gate map.
 *
 * The browser never invents or trusts a role claim of its own: roles always
 * arrive from `GET /rbac/me` through the BFF, which is the same server-side
 * source the backend's RolesGuard uses. These helpers only answer "may this
 * client render this control?" - the API remains the authority.
 */

import type { RoleName } from "@/lib/api-client";

export type { RoleName };

/** True when the caller holds the listed role (any of them). */
export function hasAnyRole(roles: RoleName[], ...required: RoleName[]): boolean {
  return required.some((role) => roles.includes(role));
}

export function isAdmin(roles: RoleName[]): boolean {
  return roles.includes("PLATFORM_ADMIN");
}

export function isExpert(roles: RoleName[]): boolean {
  return roles.includes("EXPERT_TRADER");
}

export function isLiquidityProvider(roles: RoleName[]): boolean {
  return roles.includes("LIQUIDITY_PROVIDER");
}

/**
 * Which top-level navigation sections this role may see.
 *
 * A PLATFORM_ADMIN sees only the admin surface: mixing operational admin with
 * the consumer app in one nav would invite a mistargeted click on a production
 * action. Non-admins never see the admin entries at all.
 */
export interface NavSection {
  name: string;
  href: string;
  aliases: string[];
  /** Lucide icon component is supplied by the shell; this is just the key. */
  iconKey:
    | "dashboard"
    | "onboarding"
    | "copy"
    | "usdt"
    | "terminal"
    | "portfolio"
    | "tokenomics"
    | "hub"
    | "staking"
    | "blockchain"
    | "wallet"
    | "treasury"
    | "discover"
    | "expert"
    | "liquidity"
    | "sentinel"
    | "admin";
  roles?: RoleName[];
  adminOnly?: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  {
    name: "Dashboard",
    href: "/dashboard",
    aliases: [],
    iconKey: "dashboard",
  },
  {
    name: "Onboarding",
    href: "/onboarding",
    aliases: [],
    iconKey: "onboarding",
  },
  {
    name: "Copy Trading",
    href: "/copy-trading",
    aliases: ["/copytrading", "/copy_trading"],
    iconKey: "copy",
  },
  {
    name: "USDT Exchange",
    href: "/usdt-exchange",
    aliases: ["/usdt", "/usdtexchange", "/exchange"],
    iconKey: "usdt",
  },
  {
    // The candlestick board is a read of market data every signed-in caller
    // may already make, so it carries no `roles` gate — the same default as
    // Copy Trading above. Admins see the admin surface alone.
    name: "Terminal",
    href: "/terminal",
    aliases: ["/trading-terminal", "/charts"],
    iconKey: "terminal",
  },
  {
    name: "Portfolio",
    href: "/portfolio",
    aliases: [],
    iconKey: "portfolio",
  },
  {
    name: "EMBER & Tokenomics",
    href: "/tokenomics",
    aliases: ["/ember", "/ember-tokenomics", "/tokenomics/operations"],
    iconKey: "tokenomics",
  },
  {
    // The hub is open to every signed-in user: buying configured EMBER
    // inventory is not a privileged operation, so no `roles` gate it.
    name: "EMBER Hub",
    href: "/ember-hub",
    aliases: ["/emberhub", "/hub"],
    iconKey: "hub",
  },
  {
    // Reading one's own positions needs only a session, but opening one locks
    // real wallet value, so the entry only appears for provider-capable roles
    // (mirrors Liquidity; admins see the admin surface alone).
    name: "EMBER Staking",
    href: "/staking",
    aliases: ["/stake", "/stakes", "/ember-staking"],
    iconKey: "staking",
    roles: ["LIQUIDITY_PROVIDER", "PLATFORM_ADMIN"],
  },
  {
    name: "Blockchain (EMBER)",
    href: "/blockchain",
    aliases: ["/admin/blockchain"],
    iconKey: "blockchain",
    adminOnly: true,
  },
  {
    name: "Wallet & Activity",
    href: "/wallet",
    aliases: ["/activity"],
    iconKey: "wallet",
  },
  {
    name: "Discover Strategies",
    href: "/discover",
    aliases: ["/strategies"],
    iconKey: "discover",
  },
  {
    // MODULE 14 — Sentinel places a voice CALL, never a trade, so it is open
    // to ordinary users as well as experts (unlike the provider surfaces
    // above). Liquidity providers have no consumer alerting need and are
    // deliberately left out; admins see the admin surface alone.
    name: "Sentinel Alerts",
    href: "/sentinel",
    aliases: ["/sentinel/alerts"],
    iconKey: "sentinel",
    roles: ["USER", "EXPERT_TRADER"],
  },
  {
    name: "Expert Strategies",
    href: "/expert",
    aliases: ["/expert/strategies", "/expert/strategies/new"],
    iconKey: "expert",
    roles: ["EXPERT_TRADER", "PLATFORM_ADMIN"],
  },
  {
    name: "Liquidity",
    href: "/liquidity",
    aliases: ["/liquidity/activity"],
    iconKey: "liquidity",
    roles: ["LIQUIDITY_PROVIDER", "PLATFORM_ADMIN"],
  },
  {
    name: "Treasury Guardrails",
    href: "/treasury",
    aliases: ["/treasury-guardrails"],
    iconKey: "treasury",
    adminOnly: true,
  },
  {
    name: "Admin",
    href: "/admin",
    aliases: ["/admin/users", "/admin/activity", "/admin/health", "/admin/platform", "/admin/usdt"],
    iconKey: "admin",
    adminOnly: true,
  },
];

/** Filters the nav list down to what this role set may see. */
export function visibleNavSections(roles: RoleName[]): NavSection[] {
  if (isAdmin(roles)) {
    // Admin sees only the admin surface.
    return NAV_SECTIONS.filter((section) => section.adminOnly);
  }

  return NAV_SECTIONS.filter((section) => {
    if (section.adminOnly) return false;
    if (!section.roles) return true;
    return section.roles.some((role) => roles.includes(role));
  });
}
