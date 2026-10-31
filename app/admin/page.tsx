"use client";

import React, { useEffect } from "react";

import DesignFrame from "@/components/design/DesignFrame";
import RoleGate from "@/components/RoleGate";
import { useRoles } from "@/components/RoleProvider";
import {
  adminGrantRole,
  adminListAuditLogs,
  adminListRoleRequests,
  adminListUsers,
  adminRevokeRole,
  adminSetUserStatus,
  requestHealth,
  type AdminAuditLog,
  type AdminUser,
  type HealthStatus,
  type RoleName,
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
 * PLATFORM ADMIN — the platform-control room, mounted from
 * `designs.platform_admin.html` and wired to the admin API.
 *
 * WHAT IS REAL HERE (MODULE 13 read/write surface)
 *  - Header metrics: audit-record count (`adminListAuditLogs`), registered
 *    accounts (`adminListUsers`) and the pending role-request queue
 *    (`adminListRoleRequests("PENDING")`). "Platform mode" is the console's
 *    own pause flag and is labelled as such.
 *  - The action log renders the real audit trail; its search box and area
 *    filter operate on those records, and "Export CSV" writes them out.
 *  - Service status is the backend's own probe (`requestHealth`).
 *  - Account access review lists real accounts: "Apply role updates" runs
 *    `adminRevokeRole`/`adminGrantRole`, and the suspend button runs
 *    `adminSetUserStatus` behind a confirmation naming the account.
 *
 * WHAT IS ILLUSTRATIVE — and says so
 *  - Feature switches, the risk/access policy forms and the pause toggle have
 *    no backend. Their captions are rewritten to say "illustrative", the
 *    design's own toasts already say "local demo settings", and because the
 *    audit table is binder-owned they can never plant a fake log row there.
 *
 * HOW THE WIRING WORKS is documented at length in `app/staking/page.tsx`:
 * module-scope `view` + `sync`, one module-level `wireX(root)` passed as
 * `onReady`, binders that win in the end, capture-phase interception for the
 * actions whose mock handlers must not run, delegated `on(…)` listeners
 * everywhere else, and a cleanup that removes everything it added.
 */

type LoadStatus = "loading" | "ready" | "error";

interface PlatformAdminView {
  status: LoadStatus;
  users: AdminUser[];
  pendingRequests: number;
  audit: AdminAuditLog[];
  health: HealthStatus | null;
  healthError: string | null;
  /** The console's local pause flag — there is no backend equivalent. */
  paused: boolean;
  rolesLoading: boolean;
  isAdmin: boolean;
  error: string | null;
}

const view: PlatformAdminView = {
  status: "loading",
  users: [],
  pendingRequests: 0,
  audit: [],
  health: null,
  healthError: null,
  paused: false,
  rolesLoading: true,
  isAdmin: false,
  error: null,
};

/** Set by the wiring so a role change arriving later can re-apply the slots. */
let sync: (() => void) | null = null;

/**
 * Text-node escaping. `"` is deliberately left alone: the DOM serializes a
 * quote in text as a bare `"`, so escaping it here would make the value this
 * binder compares against differ from the element's own `innerHTML` forever.
 * U+00A0 is escaped because the serializer does escape it.
 */
function esc(value: unknown): string {
  return String(value)
    .replace(/\r\n?/g, "\n") // the HTML parser folds CR to LF before anything else
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
}

/** Attribute-value escaping: everything `esc` does, plus the quote. */
function escAttr(value: unknown): string {
  return esc(value).replace(/"/g, "&quot;");
}

/** Audit actions are `module.verb` (`role.grant`, `treasury.funding`, …). */
function areaOf(action: string): string {
  const [area] = action.split(".");
  return area || action;
}

function humanArea(area: string): string {
  return area.replace(/_/g, " ");
}

function detailText(entry: AdminAuditLog): string {
  if (entry.detail === null || entry.detail === undefined) return "";
  try {
    return JSON.stringify(entry.detail) ?? "";
  } catch {
    return "";
  }
}

function timestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = date.toLocaleDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/** A figure that is honest about not having loaded yet. */
function figure(value: number): string {
  if (view.status === "loading") return "…";
  if (view.status === "error") return "—";
  return String(value);
}

function searchText(entry: AdminAuditLog): string {
  return [entry.action, areaOf(entry.action), entry.actor.email, entry.id, detailText(entry)]
    .join(" ")
    .toLowerCase();
}

/** The audit rows the table and the CSV export both show. */
function visibleAudit(filter: string, query: string): AdminAuditLog[] {
  return view.audit.filter((entry) => {
    const area = areaOf(entry.action);
    if (filter !== "all" && area !== filter) return false;
    if (query && !searchText(entry).includes(query)) return false;
    return true;
  });
}

function auditRowsHtml(rows: AdminAuditLog[]): string {
  if (view.status === "loading") {
    return '<tr><td class="empty" colspan="6">Reading the admin audit log…</td></tr>';
  }
  if (view.status === "error") {
    return `<tr><td class="empty" colspan="6">Could not read the audit log — ${esc(
      view.error ?? "unknown error",
    )}</td></tr>`;
  }
  if (rows.length === 0) {
    return '<tr><td class="empty" colspan="6">No audit records match these filters.</td></tr>';
  }
  return rows
    .slice(0, 100)
    .map(
      (entry) =>
        `<tr><td class="mono">${esc(timestamp(entry.createdAt))}</td>` +
        `<td class="role">${esc(humanArea(areaOf(entry.action)))}</td>` +
        `<td><div class="event"${detailText(entry) ? ` title="${escAttr(detailText(entry))}"` : ""}>` +
        `<i class="dot"></i>${esc(entry.action)}</div></td>` +
        `<td>${esc(entry.actor.email)}</td>` +
        `<td>Recorded</td>` +
        `<td class="mono">${esc(entry.id)}</td></tr>`,
    )
    .join("");
}

/** Service status — a rendering of `GET /health`, never a client-side guess. */
function serviceHtml(): string {
  const head =
    '<div class="section-head"><div><h2>Service status</h2>' +
    "<p>Live probe from the backend (GET /health)</p></div>" +
    `<span class="badge">${
      view.status === "loading" && !view.health && !view.healthError
        ? "READING…"
        : view.healthError
          ? "PROBE UNAVAILABLE"
          : view.health?.status === "ok"
            ? "ALL UP"
            : "FAILURES"
    }</span></div>`;

  let rows = "";
  if (!view.health && !view.healthError) {
    rows =
      '<div class="health"><div><b>Backend probe</b><small>reading…</small></div><em>…</em></div>';
  } else if (view.healthError) {
    rows =
      `<div class="health"><div><b>Backend probe</b><small>${esc(view.healthError)}</small></div>` +
      '<em style="color:var(--red)">UNAVAILABLE</em></div>';
  } else {
    const checks = view.health?.checks ?? [];
    rows =
      checks.length === 0
        ? '<div class="health"><div><b>Backend probe</b><small>no checks reported</small></div>' +
          '<em style="color:var(--amber)">UNKNOWN</em></div>'
        : checks
            .map((check) => {
              const sub = check.error
                ? check.error
                : check.latencyMs !== undefined
                  ? `${check.latencyMs} ms · measured server-side`
                  : "measured server-side";
              const up = check.status === "up";
              return (
                `<div class="health"><div><b>${esc(check.name)}</b><small>${esc(sub)}</small></div>` +
                `<em style="color:${up ? "var(--green)" : "var(--red)"}">${up ? "UP" : "DOWN"}</em></div>`
              );
            })
            .join("");
  }

  const notice = view.healthError
    ? `<div class="notice">The health probe did not answer — ${esc(view.healthError)}</div>`
    : `<div class="notice">Measured server-side by the backend health probe. The full breakdown ` +
      "lives on <b>System health</b> (/admin/health).</div>";

  return `${head}${rows}${notice}`;
}

function accountRoleControl(user: AdminUser): string {
  const privileged = user.roles.filter((role) => role !== "USER");
  const locked = user.roles.includes("PLATFORM_ADMIN") || privileged.length > 1;
  if (locked) {
    return `<span class="role">${esc(user.roles.join(" · ") || "no roles")}</span>`;
  }
  const current = privileged[0] ?? "USER";
  // `selected="selected"` rather than the bare boolean: the binder compares its
  // own markup against the element's `innerHTML`, and the serializer writes
  // `selected=""` for a valueless attribute — which would never compare equal.
  const option = (value: string, label: string): string =>
    `<option value="${value}"${value === current ? ' selected="selected"' : ""}>${label}</option>`;
  return (
    `<select aria-label="${escAttr(`${user.email} role`)}" data-user="${escAttr(user.id)}" ` +
    `data-role="${escAttr(current)}" ` +
    'style="max-width:145px;padding:7px;border:1px solid var(--line);border-radius:8px;background:var(--panel)">' +
    option("USER", "Common user") +
    option("EXPERT_TRADER", "Expert trader") +
    option("LIQUIDITY_PROVIDER", "Liquidity provider") +
    "</select>"
  );
}

function reviewRowsHtml(): string {
  if (view.status === "loading") {
    return '<div class="health"><div><b>Reading accounts…</b><small>admin/users</small></div></div>';
  }
  if (view.status === "error") {
    return (
      `<div class="health"><div><b>Could not read accounts</b><small>${esc(
        view.error ?? "unknown error",
      )}</small></div></div>`
    );
  }
  if (view.users.length === 0) {
    return '<div class="health"><div><b>No accounts yet</b><small>admin/users returned an empty list</small></div></div>';
  }
  return view.users
    .slice(0, 6)
    .map(
      (user) =>
        `<div class="health"><div><b>${esc(user.email)}</b>` +
        `<small>${esc(user.status)} · ${esc(user.roles.join(" · ") || "no roles")}</small></div>` +
        `${accountRoleControl(user)}</div>`,
    )
    .join("");
}

/** Account access review — real accounts, real grant/revoke behind the button. */
function reviewHtml(): string {
  const intro =
    view.status === "loading"
      ? "Reading accounts from the admin API…"
      : view.status === "error"
        ? `Could not read accounts — ${esc(view.error ?? "unknown error")}`
        : "Real accounts from admin/users: set one role per account, then apply. Accounts holding " +
          "PLATFORM_ADMIN (or several privileged roles) are shown read-only.";

  const first = view.users[0];
  const suspendLabel = first ? `Suspend ${first.email}` : "Suspend account";

  return (
    "<h3>Account access review</h3>" +
    `<p>${intro}</p>` +
    reviewRowsHtml() +
    '<div class="control-actions">' +
    '<button class="action-btn" id="saveRoles" type="button">Apply role updates</button>' +
    `<button class="action-btn danger" id="suspendDemo" type="button">${esc(suspendLabel)}</button>` +
    "</div>" +
    '<div class="notice"><b>Least privilege:</b> user-facing actions stay in the account that owns ' +
    "the funds. Administrative controls are configuration and review surfaces.</div>"
  );
}

function wirePlatformAdmin(root: HTMLElement): () => void {
  /* ------------------------------------------------------------------ *
   * Static elements the design never rebuilds, resolved once.
   * ------------------------------------------------------------------ */
  const metricAt = (index: number, tag: "small" | "strong" | "span"): string =>
    `.metrics > .metric:nth-child(${index}) ${tag}`;

  const subsectionP = (title: string): Element | null => {
    const subsection = all(root, ".subsection").find((entry) =>
      (entry.querySelector("h3")?.textContent ?? "").includes(title),
    );
    return subsection?.querySelector("p") ?? null;
  };

  const serviceSection =
    all(root, ".section").find((entry) =>
      (entry.querySelector("h2")?.textContent ?? "").includes("Service status"),
    ) ?? null;

  const reviewSubsection =
    all(root, ".subsection").find((entry) =>
      (entry.querySelector("h3")?.textContent ?? "").includes("Account access review"),
    ) ?? null;

  /* ------------------------------------------------------------------ *
   * Two pieces the design does not ship, added with its own markup so
   * nothing is restyled:
   *  - the previous overview's quick links, as a sidebar group, so every
   *    admin screen stays reachable from here;
   *  - a reload control in the audit toolbar.
   * ------------------------------------------------------------------ */
  const nav = sel(root, "nav.nav");
  if (nav && !nav.querySelector("[data-pb-admin-links]")) {
    nav.insertAdjacentHTML(
      "beforeend",
      '<div data-pb-admin-links="">' +
        '<div class="nav-label">MANAGEMENT</div>' +
        '<a href="/admin/platform"><span>◉</span>Capital &amp; controls</a>' +
        '<a href="/admin/usdt"><span>⇄</span>USDT distribution</a>' +
        '<a href="/admin/users"><span>☰</span>Users &amp; roles</a>' +
        '<a href="/admin/activity"><span>✎</span>Audit log</a>' +
        '<a href="/admin/health"><span>✚</span>System health</a>' +
        '<a href="/treasury"><span>▣</span>Treasury guardrails</a>' +
        "</div>",
    );
  }

  const tools = sel(root, ".audit-tools");
  if (tools && !tools.querySelector("#pbReload")) {
    tools.insertAdjacentHTML(
      "beforeend",
      '<button class="action-btn" id="pbReload" type="button">Reload</button>',
    );
  }

  /* ------------------------------------------------------------------ *
   * Text slots. Everything the design must not be allowed to state as
   * fact is owned here, including the labels that mark demo panels.
   * ------------------------------------------------------------------ */
  const textSlots: BoundSlot[] = [];
  const addSlot = (at: string | Element | null, value: () => string): void => {
    if (at) textSlots.push({ at, value });
  };

  addSlot(".top-right .badge", () => "LIVE ADMIN API · DEMO LABELLED");
  addSlot(
    ".side-foot",
    () =>
      "Counts, audit records and service health are live · policy forms stay in this browser.",
  );
  addSlot(
    ".intro p",
    () =>
      "Accounts, pending role requests, the audit trail and the backend health probe are read from " +
      "the admin API. The product-wide switches and policy forms below are illustrative demo state " +
      "stored in this browser.",
  );
  addSlot(
    ".intro .demo",
    () => "Scope: real counts and review history · illustrative policy, risk and feature settings.",
  );

  addSlot("#eventCount", () => figure(view.audit.length));
  addSlot("#eventCount + span", () => "Real records · admin/audit-logs");

  addSlot(metricAt(2, "small"), () => "Registered accounts");
  addSlot(metricAt(2, "strong"), () => figure(view.users.length));
  addSlot(metricAt(2, "span"), () => "Real count · admin/users");

  addSlot(metricAt(3, "small"), () => "Pending role requests");
  addSlot(metricAt(3, "strong"), () => figure(view.pendingRequests));
  addSlot(metricAt(3, "span"), () => "Real queue length · admin/role-requests");

  addSlot("#modeValue", () => (view.paused ? "Paused" : "Normal"));
  addSlot("#modeNote", () => "Illustrative console state · not a backend flag");

  addSlot(subsectionP("Product availability"), () =>
    "Illustrative switches: toggling one stores a preference in this browser and changes nothing on " +
      "the platform.",
  );
  addSlot(subsectionP("Risk and execution policy"), () =>
    "Illustrative demo policy — no backend reads these fields.",
  );
  addSlot(subsectionP("Administrative access policy"), () =>
    "Illustrative demo policy — not enforced by the backend.",
  );

  addSlot("#audit .section-head p", () => "Real audit records from the admin API.");
  addSlot(
    "#audit .footer-note",
    () =>
      "Records come from the admin API · Export CSV writes the rows currently shown, filters included.",
  );

  const binder: Binder = bindText(root, textSlots);

  /* ------------------------------------------------------------------ *
   * Containers this wiring renders itself.
   * ------------------------------------------------------------------ */
  const currentRows = (): AdminAuditLog[] =>
    visibleAudit(
      sel<HTMLSelectElement>(root, "#auditFilter")?.value ?? "all",
      (sel<HTMLInputElement>(root, "#auditSearch")?.value ?? "").trim().toLowerCase(),
    );

  const serviceBinder = serviceSection
    ? bindHtml(root, [{ at: serviceSection, value: () => serviceHtml() }])
    : undefined;

  const reviewBinder = reviewSubsection
    ? bindHtml(root, [{ at: reviewSubsection, value: () => reviewHtml() }])
    : undefined;

  const auditBinder = bindHtml(root, [{ at: "#auditRows", value: () => auditRowsHtml(currentRows()) }]);

  /**
   * The area filter lists the areas the real records actually carry
   * (`role`, `treasury`, `ember`, …) instead of the design's sample
   * categories, and is rebuilt only when that set changes so a selection
   * made by the operator is never clobbered.
   */
  let lastCategories = "";
  const syncFilterOptions = (): void => {
    const select = sel<HTMLSelectElement>(root, "#auditFilter");
    if (!select) return;
    const categories = Array.from(new Set(view.audit.map((entry) => areaOf(entry.action)))).sort();
    const key = categories.join("|");
    if (key === lastCategories) return;
    const previous = select.value;
    select.innerHTML = [
      '<option value="all">All areas</option>',
      ...categories.map(
        (area) => `<option value="${esc(area)}">${esc(humanArea(area))}</option>`,
      ),
    ].join("");
    select.value = categories.includes(previous) ? previous : "all";
    lastCategories = key;
  };

  const syncNow = (): void => {
    syncFilterOptions();
    binder.apply();
    serviceBinder?.apply();
    reviewBinder?.apply();
    auditBinder.apply();
  };
  sync = syncNow;

  /* ------------------------------------------------------------------ *
   * Reads.
   * ------------------------------------------------------------------ */
  let cancelled = false;

  async function refresh(): Promise<void> {
    try {
      const [users, requests, audit] = await Promise.all([
        adminListUsers(),
        adminListRoleRequests("PENDING"),
        adminListAuditLogs(),
      ]);
      if (cancelled) return;
      view.users = users;
      view.pendingRequests = requests.length;
      view.audit = audit;
      view.status = "ready";
      view.error = null;
      syncNow();
    } catch (error: unknown) {
      if (cancelled) return;
      view.status = "error";
      view.error = apiMessage(error);
      toast(root, `Could not read the platform overview — ${apiMessage(error)}`);
      syncNow();
    }
    void loadHealth();
  }

  /** The probe is reported on its own: a slow health endpoint must not hide the counts. */
  async function loadHealth(): Promise<void> {
    try {
      const health = await requestHealth();
      if (cancelled) return;
      view.health = health;
      view.healthError = null;
    } catch (error: unknown) {
      if (cancelled) return;
      view.health = null;
      view.healthError = apiMessage(error);
    }
    syncNow();
  }

  /* ------------------------------------------------------------------ *
   * Capture-phase interception: the design's mock handlers for these four
   * never run — the real API (or, for the demo-only pause, an honest
   * message) does.
   * ------------------------------------------------------------------ */
  const closest = (event: Event, selector: string): Element | null => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    return target && root.contains(target) ? target : null;
  };

  let applying = false;

  const onRoleUpdates = (event: Event): void => {
    if (!closest(event, "#saveRoles")) return;
    event.stopPropagation();
    void applyRoleUpdates();
  };

  async function applyRoleUpdates(): Promise<void> {
    if (view.rolesLoading) {
      toast(root, "Your roles are still loading — try again in a moment.");
      return;
    }
    if (!view.isAdmin) {
      toast(root, "Only a platform administrator can change account roles.");
      return;
    }
    if (applying) return;

    const selects = reviewSubsection
      ? Array.from(reviewSubsection.querySelectorAll<HTMLSelectElement>("select[data-user]"))
      : [];
    const changed = selects.filter((select) => select.value !== (select.dataset.role ?? "USER"));
    if (changed.length === 0) {
      toast(root, "No role changes were selected.");
      return;
    }

    applying = true;
    try {
      for (const select of changed) {
        const userId = select.dataset.user ?? "";
        const from = (select.dataset.role ?? "USER") as RoleName;
        const to = select.value as RoleName;
        // Least privilege first: an account never keeps a role it just lost.
        if (from !== "USER") await adminRevokeRole(userId, from);
        if (to !== "USER") {
          await adminGrantRole(userId, to as Exclude<RoleName, "USER" | "PLATFORM_ADMIN">);
        }
      }
      toast(root, `Updated ${changed.length} account${changed.length === 1 ? "" : "s"}.`);
    } catch (error: unknown) {
      toast(root, `Could not update roles — ${apiMessage(error)}`);
    } finally {
      applying = false;
      void refresh();
    }
  }

  const onSuspend = (event: Event): void => {
    if (!closest(event, "#suspendDemo")) return;
    event.stopPropagation();
    if (view.rolesLoading || !view.isAdmin) {
      toast(root, "Only a platform administrator can suspend an account.");
      return;
    }
    const target = view.users[0];
    if (!target) {
      toast(root, "There is no account to suspend yet.");
      return;
    }
    if (target.status === "SUSPENDED") {
      toast(root, `${target.email} is already suspended.`);
      return;
    }
    if (!window.confirm(`Suspend ${target.email}? Their account tokens stop working immediately.`)) {
      return;
    }
    void (async () => {
      try {
        await adminSetUserStatus(target.id, "SUSPENDED");
        toast(root, `${target.email} suspended.`);
      } catch (error: unknown) {
        toast(root, `Could not suspend ${target.email} — ${apiMessage(error)}`);
      } finally {
        void refresh();
      }
    })();
  };

  const onPauseToggle = (event: Event): void => {
    const button = closest(event, "#pauseTrading");
    if (!button) return;
    event.stopPropagation();
    view.paused = !view.paused;
    button.textContent = view.paused ? "Resume demo execution" : "Pause demo execution";
    syncNow();
    toast(
      root,
      view.paused
        ? "Paused in this console only — there is no execution flag on the backend, so nothing changed."
        : "Resumed in this console only — no backend state was involved.",
    );
  };

  const onExport = (event: Event): void => {
    if (!closest(event, "#exportLog")) return;
    event.stopPropagation();
    const rows = currentRows();
    if (rows.length === 0) {
      toast(root, "There are no audit records to export.");
      return;
    }
    const csv = [
      ["Time", "Area", "Action", "Actor", "Result", "Reference"],
      ...rows.map((entry) => [
        new Date(entry.createdAt).toISOString(),
        humanArea(areaOf(entry.action)),
        entry.action,
        entry.actor.email,
        "Recorded",
        entry.id,
      ]),
    ]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = "prometheus-platform-audit.csv";
    link.click();
    URL.revokeObjectURL(href);
    toast(root, `Exported ${rows.length} audit record${rows.length === 1 ? "" : "s"}.`);
  };

  root.addEventListener("click", onRoleUpdates, true);
  root.addEventListener("click", onSuspend, true);
  root.addEventListener("click", onPauseToggle, true);
  root.addEventListener("click", onExport, true);

  /* Delegated listeners: no mock handler stands in the way of these. */
  const offReload = on(root, "#pbReload", "click", () => {
    toast(root, "Reloading the platform overview…");
    void refresh();
  });
  const offSearch = on(root, "#auditSearch", "input", () => syncNow());
  const offFilter = on(root, "#auditFilter", "change", () => syncNow());

  void refresh();

  return () => {
    cancelled = true;
    sync = null;
    root.removeEventListener("click", onRoleUpdates, true);
    root.removeEventListener("click", onSuspend, true);
    root.removeEventListener("click", onPauseToggle, true);
    root.removeEventListener("click", onExport, true);
    offReload();
    offSearch();
    offFilter();
    cleanupAll(binder, serviceBinder, reviewBinder, auditBinder)();
  };
}

export default function AdminHomePage() {
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
      <DesignFrame design={designs.platformAdmin} onReady={wirePlatformAdmin} />
    </RoleGate>
  );
}
