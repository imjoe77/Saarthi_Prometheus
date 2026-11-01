"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  Compass,
  Eye,
  EyeOff,
  Flame,
  Layers,
  LineChart,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import { ExpertChatModal } from "@/components/ExpertChatModal";
import { useRoles } from "@/components/RoleProvider";
import {
  ApiError,
  createStrategy,
  discoverStrategies,
  getStrategies,
  updateStrategy,
  type PublicStrategyPage,
  type StrategyListQuery,
  type StrategyPage,
  type StrategyStatusName,
  type StrategySummary,
  type StrategyVisibilityName,
} from "@/lib/api-client";

/**
 * MODULE 05 — the strategy registry.
 *
 * Two halves, because the API has two halves. "My Strategies" is the owner's own
 * records: create, rename, re-describe, publish or unpublish, and retire.
 * "Discover" is the public catalogue, where each entry carries a name, the owner's
 * own words and a timestamp — and nothing else.
 *
 * What is deliberately absent from both halves: return, P&L, Sharpe, drawdown, risk
 * level, follower counts, AUM. No price source, no trade history and no order
 * engine exist in Prometheus yet, so every one of those would be a number this
 * component invented. A tile reading "+18.4%" is indistinguishable from a measured
 * result once rendered, which is why the tiles are absent rather than stubbed.
 *
 * Discovery is authenticated on purpose. It is not a public listing page; it is a
 * signed-in user choosing what to look at, and the API decides what that reveals.
 * No owner id, email or handle comes back from it, so none can be shown here.
 */

type Tab = "mine" | "discover";
type LoadStatus = "loading" | "ready" | "error";

/** The editable part of a strategy. Description is a string here and null on the wire. */
interface StrategyDraft {
  name: string;
  description: string;
  visibility: StrategyVisibilityName;
}

const VISIBILITY_OPTIONS: Array<{
  value: StrategyVisibilityName;
  label: string;
  Icon: typeof Eye;
}> = [
  { value: "PRIVATE", label: "Private", Icon: EyeOff },
  { value: "PUBLIC", label: "Public", Icon: Eye },
];

const STATUS_FILTERS: Array<{ value: StrategyStatusName | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "ARCHIVED", label: "Archived" },
];

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  return "Something went wrong while talking to the Prometheus API.";
}

/** An empty description is stored as null rather than as an empty string. */
function nullable(text: string): string | null {
  const trimmed = text.trim();

  return trimmed.length > 0 ? text : null;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return "??";

  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export default function StrategiesPage() {
  const { hasRole, loading: rolesLoading } = useRoles();
  const canManage = hasRole("EXPERT_TRADER", "PLATFORM_ADMIN");
  const [tab, setTab] = useState<Tab>("discover");

  const [mine, setMine] = useState<StrategyPage | null>(null);
  const [mineStatus, setMineStatus] = useState<LoadStatus>("loading");
  const [mineError, setMineError] = useState<string | null>(null);

  const [discovered, setDiscovered] = useState<PublicStrategyPage | null>(null);
  const [discoverStatus, setDiscoverStatus] = useState<LoadStatus>("loading");
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StrategyStatusName | "ALL">("ALL");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [chatTarget, setChatTarget] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState<StrategyDraft>({
    name: "",
    description: "",
    visibility: "PRIVATE",
  });

  // Derive the effective tab at render time: if roles are known and the caller
  // cannot manage strategies, never render the manage half even if state still
  // says "mine" (e.g. a shared deep link).
  const effectiveTab: Tab = !rolesLoading && !canManage && tab === "mine" ? "discover" : tab;

  /**
   * These fetch, and only fetch. Neither one raises the loading flag itself, so
   * calling them from the mount effect below cannot set state synchronously in an
   * effect body — the first thing each does after the call is `await`. Raising the
   * flag is the caller's job, and it belongs to user actions, where it is a
   * legitimate response to a click.
   */
  const loadMine = useCallback(async (nextPage: number, filter: StrategyStatusName | "ALL") => {
    const query: StrategyListQuery = { page: nextPage, limit: 10 };
    if (filter !== "ALL") query.status = filter;

    try {
      setMine(await getStrategies(query));
      setMineError(null);
      setMineStatus("ready");
    } catch (error) {
      setMineError(messageFor(error));
      setMineStatus("error");
    }
  }, []);

  const loadDiscover = useCallback(async (nextPage: number) => {
    try {
      setDiscovered(await discoverStrategies({ page: nextPage, limit: 12 }));
      setDiscoverError(null);
      setDiscoverStatus("ready");
    } catch (error) {
      setDiscoverError(messageFor(error));
      setDiscoverStatus("error");
    }
  }, []);

  /**
   * Both halves are fetched on mount rather than on tab change: the catalogue is
   * small, and a tab that shows an empty spinner on first click reads as an empty
   * result rather than as work in progress. Both start in the loading state.
   *
   * The fetches are written out here rather than delegated to `loadMine`/
   * `loadDiscover`, because those exist to serve clicks and this effect must not
   * set state synchronously — a cascade on mount is the one place a cascading
   * render is always paid for. State is applied in the promise callbacks, after
   * the `active` guard, so a response that arrives after unmount is dropped.
   */
  useEffect(() => {
    let active = true;

    void Promise.all([
      getStrategies({ page: 1, limit: 10 }),
      discoverStrategies({ page: 1, limit: 12 }),
    ])
      .then(([own, catalogue]) => {
        if (!active) return;

        setMine(own);
        setMineError(null);
        setMineStatus("ready");
        setDiscovered(catalogue);
        setDiscoverError(null);
        setDiscoverStatus("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;

        const message = messageFor(error);

        setMineError(message);
        setMineStatus("error");
        setDiscoverError(message);
        setDiscoverStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setActionError(null);
    setNotice(null);
    setMineStatus("loading");
    setDiscoverStatus("loading");

    void loadMine(page, statusFilter);
    void loadDiscover(page);
  }, [loadDiscover, loadMine, page, statusFilter]);

  /**
   * Every mutation ends the same way: re-read both halves, then say what happened.
   * `page`/`filter` can be overridden because creating a strategy always resets the
   * owner's list to the first page, and a reload of the page they were on would
   * re-fetch an offset that no longer means what it did.
   */
  const settle = useCallback(
    (message: string, override?: { page?: number; filter?: StrategyStatusName | "ALL" }) => {
      const targetPage = override?.page ?? page;
      const targetFilter = override?.filter ?? statusFilter;

      setActionError(null);
      setNotice(message);
      setEditingId(null);
      setSubmitting(false);
      setMineStatus("loading");
      setDiscoverStatus("loading");

      void loadMine(targetPage, targetFilter);
      void loadDiscover(targetPage);
    },
    [loadDiscover, loadMine, page, statusFilter],
  );

  const fail = useCallback((error: unknown) => {
    setActionError(messageFor(error));
    setNotice(null);
    setSubmitting(false);
  }, []);

  const handleCreate = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitting(true);

      try {
        const created = await createStrategy({
          name: draft.name,
          description: nullable(draft.description),
          visibility: draft.visibility,
        });

        setDraft({ name: "", description: "", visibility: "PRIVATE" });
        setPage(1);
        setStatusFilter("ALL");
        settle(`"${created.name}" was created, ${created.visibility.toLowerCase()} and active.`, {
          page: 1,
          filter: "ALL",
        });
      } catch (error) {
        fail(error);
      }
    },
    [draft, fail, settle],
  );

  const handleUpdate = useCallback(
    async (strategy: StrategySummary, changes: StrategyDraft) => {
      setSubmitting(true);

      try {
        const updated = await updateStrategy(strategy.id, {
          name: changes.name,
          description: nullable(changes.description),
          visibility: changes.visibility,
        });

        settle(`"${updated.name}" was saved.`);
      } catch (error) {
        fail(error);
      }
    },
    [fail, settle],
  );

  const handleArchive = useCallback(
    async (strategy: StrategySummary) => {
      setSubmitting(true);

      try {
        // One-way, as the API defines it: `status: "ARCHIVED"` is the only status
        // transition the endpoint accepts, so there is no un-archive to offer back.
        await updateStrategy(strategy.id, { status: "ARCHIVED" });

        settle(`"${strategy.name}" was archived. Archiving is permanent.`);
      } catch (error) {
        fail(error);
      }
    },
    [fail, settle],
  );

  const changeStatusFilter = useCallback(
    (next: StrategyStatusName | "ALL") => {
      setStatusFilter(next);
      setPage(1);
      setEditingId(null);
      setMineStatus("loading");

      void loadMine(1, next);
    },
    [loadMine],
  );

  const goToPage = useCallback(
    (next: number) => {
      setPage(next);
      setEditingId(null);

      if (effectiveTab === "mine") {
        setMineStatus("loading");
        void loadMine(next, statusFilter);
      } else {
        setDiscoverStatus("loading");
        void loadDiscover(next);
      }
    },
    [effectiveTab, loadDiscover, loadMine, statusFilter],
  );

  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    setActionError(null);
    setNotice(null);
    setEditingId(null);
  }, []);

  return (
    <AppShell>
      <div className="p-6 space-y-6 max-w-[1680px] mx-auto">
        {/* TOP SUB-HEADER */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-mono font-medium text-[#7C8799] uppercase tracking-wider mb-1">
              <span className="w-2 h-2 rounded-full bg-[#FF5A1F]" />
              <span>STRATEGY REGISTRY</span>
              <span>•</span>
              <span className="text-[#A6B2C4]">METADATA ONLY — NO PERFORMANCE DATA</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Strategies</h1>
            <p className="text-xs text-[#7B8799] mt-1 max-w-3xl">
              Name a strategy, describe it in your own words, and choose whether other Prometheus
              users may see it. Returns, risk scores and follower counts appear here only once
              something in Prometheus can actually measure them.
            </p>
          </div>

          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1.5 self-start px-3.5 py-2 rounded-lg bg-[#161B24] hover:bg-[#1C222D] border border-[#242C3A] text-xs font-bold text-[#A6B2C4] hover:text-white transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        {/* TABS */}
        <div className="flex items-center gap-2 border-b border-[#1E2532] pb-3">
          {(canManage || rolesLoading) && (
            <button
              type="button"
              onClick={() => switchTab("mine")}
              disabled={!canManage && !rolesLoading}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-colors ${
                effectiveTab === "mine"
                  ? "bg-[#FF5A1F]/15 text-[#FF5A1F] border border-[#FF5A1F]/30"
                  : "text-[#717E91] hover:text-white border border-transparent"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              My Strategies
            </button>
          )}
          <button
            type="button"
            onClick={() => switchTab("discover")}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-colors ${
              effectiveTab === "discover"
                ? "bg-[#FF5A1F]/15 text-[#FF5A1F] border border-[#FF5A1F]/30"
                : "text-[#717E91] hover:text-white border border-transparent"
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            Discover
          </button>
        </div>

        {notice && (
          <div className="flex items-start gap-3 rounded-xl border border-[#00D26A]/30 bg-[#00D26A]/5 p-4">
            <Check className="w-4 h-4 text-[#00D26A] mt-0.5 shrink-0" />
            <p className="text-xs text-[#C5CFDE] flex-1">{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="text-[#717E91] hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {actionError && (
          <div className="flex items-start gap-3 rounded-xl border border-[#FF5A1F]/30 bg-[#FF5A1F]/5 p-4">
            <AlertTriangle className="w-4 h-4 text-[#FF5A1F] mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">That change was not accepted</p>
              <p className="text-xs text-[#C5CFDE] mt-0.5">{actionError}</p>
            </div>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-xs font-bold text-[#FF5A1F] hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {effectiveTab === "mine" ? (
          canManage ? (
            <>
              <CreatePanel draft={draft} setDraft={setDraft} submitting={submitting} onSubmit={handleCreate} />

              <OwnList
                page={mine}
                status={mineStatus}
                error={mineError}
                filter={statusFilter}
                submitting={submitting}
                editingId={editingId}
                onFilterChange={changeStatusFilter}
                onSave={handleUpdate}
                onArchive={handleArchive}
                onEdit={setEditingId}
                onCancelEdit={() => setEditingId(null)}
                onRetry={refresh}
                onPage={goToPage}
              />
            </>
          ) : (
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-6 text-center">
              <p className="text-sm text-[#9CA3AF]">
                Managing your own strategies requires the Expert Trader role. You can request it
                from Settings, then refresh this page.
              </p>
            </div>
          )
        ) : (
          <DiscoverPanel
            page={discovered}
            status={discoverStatus}
            error={discoverError}
            onRetry={refresh}
            onPage={goToPage}
            onChat={(s) => setChatTarget({ id: s.id, name: s.name })}
          />
        )}

        {chatTarget && (
          <ExpertChatModal
            strategyId={chatTarget.id}
            strategyName={chatTarget.name}
            isOpen={chatTarget !== null}
            onClose={() => setChatTarget(null)}
          />
        )}
      </div>
    </AppShell>
  );
}

function CreatePanel({
  draft,
  setDraft,
  submitting,
  onSubmit,
}: {
  draft: StrategyDraft;
  setDraft: React.Dispatch<React.SetStateAction<StrategyDraft>>;
  submitting: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="bg-[#12161E] border border-[#202735] rounded-xl p-5 space-y-4"
    >
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-[#FF5A1F]/15 border border-[#FF5A1F]/30 flex items-center justify-center text-[#FF5A1F]">
          <Plus className="w-4 h-4" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white tracking-tight">New strategy</h2>
          <p className="text-[11px] text-[#717E91]">
            Created active and private. Publish it whenever you want it listed.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
            Name (required, max 80)
          </span>
          <input
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            required
            maxLength={80}
            placeholder="EMBER momentum"
            className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-xs text-white placeholder:text-[#5D6B82] outline-none transition-colors"
          />
        </label>

        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
            Description (optional, max 1000)
          </span>
          <input
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({ ...current, description: event.target.value }))
            }
            maxLength={1000}
            placeholder="What does it do?"
            className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-xs text-white placeholder:text-[#5D6B82] outline-none transition-colors"
          />
        </label>

        <div>
          <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
            Visibility
          </span>
          <div className="flex items-center gap-2">
            {VISIBILITY_OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setDraft((current) => ({ ...current, visibility: value }))}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  draft.visibility === value
                    ? "bg-[#FF5A1F]/15 text-[#FF5A1F] border border-[#FF5A1F]/30"
                    : "bg-[#161B24] text-[#717E91] border border-[#242C3A] hover:text-white"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        <p className="text-[10px] font-mono text-[#5D6B82] leading-relaxed">
          NAMES ARE UNIQUE PER ACCOUNT, COMPARED WITHOUT REGARD TO CASE OR SURROUNDING SPACES.
        </p>
        <button
          type="submit"
          disabled={submitting || draft.name.trim().length === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF5A1F] hover:bg-[#E04B14] disabled:opacity-50 disabled:hover:bg-[#FF5A1F] text-xs font-bold text-white shadow-md shadow-[#FF5A1F]/30 transition-all"
        >
          {submitting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5" />
          )}
          <span>Create strategy</span>
        </button>
      </div>
    </form>
  );
}

function OwnList({
  page,
  status,
  error,
  filter,
  submitting,
  editingId,
  onFilterChange,
  onSave,
  onArchive,
  onEdit,
  onCancelEdit,
  onRetry,
  onPage,
}: {
  page: StrategyPage | null;
  status: LoadStatus;
  error: string | null;
  filter: StrategyStatusName | "ALL";
  submitting: boolean;
  editingId: string | null;
  onFilterChange: (next: StrategyStatusName | "ALL") => void;
  onSave: (strategy: StrategySummary, changes: StrategyDraft) => void;
  onArchive: (strategy: StrategySummary) => void;
  onEdit: (id: string) => void;
  onCancelEdit: () => void;
  onRetry: () => void;
  onPage: (page: number) => void;
}) {
  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-bold text-white tracking-tight">My strategies</h2>
          <p className="text-xs text-[#717E91] mt-0.5">
            Yours alone. Only public, active strategies appear in Discover.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[#717E91] uppercase">Filter:</span>
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onFilterChange(option.value)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                filter === option.value
                  ? option.value === "ARCHIVED"
                    ? "bg-[#F5A623]/15 text-[#F5A623]"
                    : "bg-[#222A38] text-white"
                  : "text-[#717E91] hover:text-white"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {status === "error" && error && (
        <ErrorPanel title="Could not load your strategies" message={error} onRetry={onRetry} />
      )}

      {status === "loading" && page === null && (
        <p className="flex items-center gap-2 text-xs font-mono text-[#8E98A8] py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
          <span>Loading your strategies…</span>
        </p>
      )}

      {status === "ready" && page !== null && page.items.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#2C3748] bg-[#161B24] px-5 py-10 text-center">
          <p className="text-xs text-[#7B8799]">
            {filter === "ALL"
              ? "You have no strategies yet. Create one above."
              : `No ${filter.toLowerCase()} strategies — the API returned an empty list, which is not an error.`}
          </p>
        </div>
      )}

      {page !== null && page.items.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {page.items.map((strategy) => (
            <StrategyCard
              key={strategy.id}
              strategy={strategy}
              editing={editingId === strategy.id}
              submitting={submitting}
              onEdit={() => onEdit(strategy.id)}
              onCancelEdit={onCancelEdit}
              onSave={(changes) => onSave(strategy, changes)}
              onArchive={() => onArchive(strategy)}
            />
          ))}
        </div>
      )}

      {page !== null && page.totalPages > 1 && <Pager page={page} onPage={onPage} />}
    </div>
  );
}

function StrategyCard({
  strategy,
  editing,
  submitting,
  onEdit,
  onCancelEdit,
  onSave,
  onArchive,
}: {
  strategy: StrategySummary;
  editing: boolean;
  submitting: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (changes: StrategyDraft) => void;
  onArchive: () => void;
}) {
  const archived = strategy.status === "ARCHIVED";
  const published = strategy.visibility === "PUBLIC";

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 ${
        archived ? "bg-[#14171C] border-[#252E3E]" : "bg-[#161B24] border-[#242C3B]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs text-white shrink-0 ${
              archived
                ? "bg-slate-700/70 border border-slate-500/30"
                : "bg-[#FF5A1F]/80 border border-[#FF5A1F]/40"
            }`}
          >
            {initialsOf(strategy.name)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-sm text-white truncate">{strategy.name}</h3>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                  archived ? "bg-[#F5A623]/10 text-[#F5A623]" : "bg-[#00D26A]/10 text-[#00D26A]"
                }`}
              >
                {strategy.status}
              </span>
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-mono font-bold ${
                  published
                    ? "bg-[#5D9CFF]/10 text-[#5D9CFF] border-[#5D9CFF]/30"
                    : "bg-[#5D6B82]/10 text-[#8E98A8] border-[#2C3748]"
                }`}
              >
                {strategy.visibility}
              </span>
            </div>
            <p className="text-[11px] font-mono text-[#5D6B82] mt-0.5">
              CREATED {formatTimestamp(strategy.createdAt).toUpperCase()}
            </p>
          </div>
        </div>

        {!archived && !editing && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Link
              href={`/strategies/${strategy.id}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#FF5A1F]/15 hover:bg-[#FF5A1F]/25 border border-[#FF5A1F]/40 rounded text-xs font-bold text-[#FF5A1F] transition-colors"
            >
              <LineChart className="w-3.5 h-3.5" />
              <span>Trade</span>
            </Link>
            <button
              type="button"
              onClick={onEdit}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#181D26] hover:bg-[#202735] border border-[#273242] rounded text-xs font-medium text-white transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>Edit</span>
            </button>
            <button
              type="button"
              onClick={onArchive}
              disabled={submitting}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#F5A623]/10 hover:bg-[#F5A623]/20 border border-[#F5A623]/30 rounded text-xs font-medium text-[#F5A623] disabled:opacity-50 transition-colors"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>Archive</span>
            </button>
          </div>
        )}
      </div>

      {archived ? (
        <p className="text-[11px] text-[#717E91] leading-relaxed border-t border-[#1E2532] pt-3">
          Archived {formatTimestamp(strategy.updatedAt)}. An archived strategy cannot be edited,
          republished or brought back, and it has left the public catalogue.
        </p>
      ) : editing ? (
        <EditForm submitting={submitting} strategy={strategy} onCancel={onCancelEdit} onSave={onSave} />
      ) : (
        <p className="text-xs text-[#A6B2C4] leading-relaxed">
          {strategy.description ?? "No description yet — your own note to add one."}
        </p>
      )}
    </div>
  );
}

function EditForm({
  strategy,
  submitting,
  onCancel,
  onSave,
}: {
  strategy: StrategySummary;
  submitting: boolean;
  onCancel: () => void;
  onSave: (changes: StrategyDraft) => void;
}) {
  // Seeded from the strategy once, and owned here, so an in-flight edit is not
  // re-rendered out from under the fields by an unrelated list refresh.
  const [changes, setChanges] = useState<StrategyDraft>({
    name: strategy.name,
    description: strategy.description ?? "",
    visibility: strategy.visibility,
  });

  return (
    <div className="space-y-3 border-t border-[#1E2532] pt-3">
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
          Name
        </span>
        <input
          value={changes.name}
          onChange={(event) => setChanges((current) => ({ ...current, name: event.target.value }))}
          maxLength={80}
          className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-xs text-white outline-none transition-colors"
        />
      </label>

      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
          Description
        </span>
        <textarea
          value={changes.description}
          onChange={(event) =>
            setChanges((current) => ({ ...current, description: event.target.value }))
          }
          maxLength={1000}
          rows={3}
          className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-xs text-white outline-none transition-colors resize-y"
        />
      </label>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {VISIBILITY_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setChanges((current) => ({ ...current, visibility: value }))}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                changes.visibility === value
                  ? "bg-[#5D9CFF]/15 text-[#5D9CFF] border border-[#5D9CFF]/30"
                  : "bg-[#0E1219] text-[#717E91] border border-[#242C3A] hover:text-white"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 bg-[#181D26] hover:bg-[#202735] border border-[#273242] rounded text-xs font-medium text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(changes)}
            disabled={submitting || changes.name.trim().length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] disabled:opacity-50 text-xs font-bold text-white transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            <span>Save</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function DiscoverPanel({
  page,
  status,
  error,
  onRetry,
  onPage,
  onChat,
}: {
  page: PublicStrategyPage | null;
  status: LoadStatus;
  error: string | null;
  onRetry: () => void;
  onPage: (page: number) => void;
  onChat?: (strategy: { id: string; name: string }) => void;
}) {
  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div>
          <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#00D26A]" />
            Public catalogue
          </h2>
          <p className="text-xs text-[#717E91] mt-0.5">
            Public, active strategies from every Prometheus account, newest first. Ranked by
            nothing — there is no performance data to rank them by yet.
          </p>
        </div>
        <span className="px-2.5 py-1 rounded bg-[#161C26] border border-[#242E3E] text-[11px] font-mono text-[#A6B2C4]">
          {page ? `${page.total} LISTED` : "—"}
        </span>
      </div>

      {status === "error" && error && (
        <ErrorPanel title="Could not load the catalogue" message={error} onRetry={onRetry} />
      )}

      {status === "loading" && page === null && (
        <p className="flex items-center gap-2 text-xs font-mono text-[#8E98A8] py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
          <span>Loading the catalogue…</span>
        </p>
      )}

      {status === "ready" && page !== null && page.items.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#2C3748] bg-[#161B24] px-5 py-10 text-center">
          <p className="text-xs text-[#7B8799]">
            Nothing is published right now. A strategy appears here once its owner makes it public
            and leaves it active.
          </p>
        </div>
      )}

      {page !== null && page.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {page.items.map((strategy) => (
            <div key={strategy.id} className="bg-[#161B24] border border-[#242C3B] rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#1F2633] border border-[#2C3748] flex items-center justify-center text-xs font-bold text-[#A6B2C4] shrink-0">
                  {initialsOf(strategy.name)}
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-sm text-white truncate">{strategy.name}</h3>
                  <p className="text-[11px] font-mono text-[#5D6B82] mt-0.5">
                    UPDATED {formatTimestamp(strategy.updatedAt).toUpperCase()}
                  </p>
                </div>
              </div>

              <p className="text-xs text-[#A6B2C4] leading-relaxed min-h-[2.5rem]">
                {strategy.description ?? "The owner has not described this strategy yet."}
              </p>

              <p className="text-[10px] font-mono text-[#5D6B82] border-t border-[#1E2532] pt-3">
                NO RETURNS, RISK FIGURES OR OWNER IDENTITY IN THIS RESPONSE.
              </p>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <Link
                  href={`/strategies/${strategy.id}`}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161B24] hover:bg-[#202735] border border-[#273242] text-[11px] font-bold text-[#A6B2C4] hover:text-white transition-colors"
                >
                  <LineChart className="w-3.5 h-3.5" />
                  <span>Open chart</span>
                </Link>
                <button
                  type="button"
                  onClick={() => onChat?.({ id: strategy.id, name: strategy.name })}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5A1F]/15 hover:bg-[#FF5A1F]/25 border border-[#FF5A1F]/40 text-[11px] font-bold text-[#FF5A1F] transition-colors shadow-sm"
                  title="Direct 1-on-1 consultation (10 EMBER)"
                >
                  <Flame className="w-3.5 h-3.5 text-[#FF5A1F]" />
                  <span>Chat (10 EMBER)</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {page !== null && page.totalPages > 1 && <Pager page={page} onPage={onPage} />}
    </div>
  );
}

function ErrorPanel({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[#FF5A1F]/30 bg-[#FF5A1F]/5 p-4">
      <AlertTriangle className="w-4 h-4 text-[#FF5A1F] mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="text-xs font-semibold text-white">{title}</p>
        <p className="text-xs text-[#C5CFDE] mt-0.5">{message}</p>
      </div>
      <button type="button" onClick={onRetry} className="text-xs font-bold text-[#FF5A1F] hover:underline">
        Retry
      </button>
    </div>
  );
}

function Pager({
  page,
  onPage,
}: {
  page: { page: number; limit: number; total: number; totalPages: number };
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4 pt-4 border-t border-[#1E2532]">
      <span className="text-[11px] font-mono text-[#6E7B8E]">
        PAGE {page.page} OF {page.totalPages} • {page.total} TOTAL • {page.limit} PER PAGE
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(page.page - 1)}
          disabled={page.page <= 1}
          className="px-3 py-1.5 bg-[#181D26] hover:bg-[#202735] disabled:opacity-40 border border-[#273242] rounded text-xs font-medium text-white transition-colors"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => onPage(page.page + 1)}
          disabled={page.page >= page.totalPages}
          className="px-3 py-1.5 bg-[#181D26] hover:bg-[#202735] disabled:opacity-40 border border-[#273242] rounded text-xs font-medium text-white transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}
