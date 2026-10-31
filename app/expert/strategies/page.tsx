"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  createStrategy,
  getStrategies,
  updateStrategy,
  type StrategySummary,
  type StrategyVisibilityName,
} from "@/lib/api-client";

/**
 * MODULE 13 — the Expert Trader strategy manager.
 *
 * The owner's own registry only: create, rename, publish, unpublish and
 * archive. Discovery for every signed-in user lives at `/discover`, so a plain
 * USER never lands on this CRUD surface. The backend still refuses every write
 * without EXPERT_TRADER or PLATFORM_ADMIN regardless of what this page
 * renders.
 *
 * What is deliberately absent: return, P&L, Sharpe, drawdown, risk, followers
 * or AUM. No price source or trade history exists yet, so every one of those
 * would be an invented number.
 */

type LoadStatus = "loading" | "ready" | "error";

interface Draft {
  name: string;
  description: string;
  visibility: StrategyVisibilityName;
}

const EMPTY_DRAFT: Draft = { name: "", description: "", visibility: "PRIVATE" };

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function ExpertStrategiesPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [items, setItems] = useState<StrategySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getStrategies({ limit: 100 });
      setItems(result.items);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    getStrategies({ limit: 100 })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(messageFor(cause));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  const submitCreate = async (): Promise<void> => {
    if (!draft.name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createStrategy({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        visibility: draft.visibility,
      });
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setCreating(false);
    }
  };

  const submitEdit = async (): Promise<void> => {
    if (!editingId || !editDraft.name.trim()) return;
    setBusyId(editingId);
    setError(null);
    try {
      await updateStrategy(editingId, {
        name: editDraft.name.trim(),
        description: editDraft.description.trim() || null,
        visibility: editDraft.visibility,
      });
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyId(null);
    }
  };

  const archive = async (id: string): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await updateStrategy(id, { status: "ARCHIVED" });
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyId(null);
    }
  };

  const toggleVisibility = async (strategy: StrategySummary): Promise<void> => {
    setBusyId(strategy.id);
    setError(null);
    try {
      await updateStrategy(strategy.id, {
        visibility: strategy.visibility === "PUBLIC" ? "PRIVATE" : "PUBLIC",
      });
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell>
      <RoleGate roles={["EXPERT_TRADER", "PLATFORM_ADMIN"]}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
                <Sparkles className="w-3.5 h-3.5" />
                Expert
              </div>
              <h1 className="text-2xl font-bold text-white">My strategies</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Only you see this list. Publish a strategy to make it appear in Discover.
              </p>
            </div>
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
              <AlertTriangle className="w-4 h-4 inline mr-2" />
              {error}
            </div>
          )}

          {/* Create */}
          <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-6">
            <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <Plus className="w-4 h-4 text-[#00D26A]" />
              New strategy
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Name (unique per account)"
                maxLength={120}
                className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
              />
              <select
                value={draft.visibility}
                onChange={(event) =>
                  setDraft({ ...draft, visibility: event.target.value as StrategyVisibilityName })
                }
                className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF5A1F]"
              >
                <option value="PRIVATE">Private</option>
                <option value="PUBLIC">Public (appears in Discover)</option>
              </select>
            </div>
            <textarea
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="Description (optional)"
              rows={2}
              maxLength={2000}
              className="mt-3 w-full bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
            />
            <button
              type="button"
              onClick={() => void submitCreate()}
              disabled={creating || !draft.name.trim()}
              className="mt-3 inline-flex items-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Create
            </button>
          </div>

          {/* List */}
          {status === "loading" && (
            <div className="space-y-3" aria-busy="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-16 rounded-xl bg-[#181D26] animate-pulse" />
              ))}
            </div>
          )}

          {status === "ready" && items.length === 0 && (
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-10 text-center">
              <Layers className="w-10 h-10 text-[#6B7280] mx-auto mb-3" />
              <h2 className="text-lg font-semibold text-white">No strategies yet</h2>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Create your first strategy above. It starts private until you publish it.
              </p>
            </div>
          )}

          {status === "ready" && items.length > 0 && (
            <div className="space-y-3">
              {items.map((strategy) => (
                <div
                  key={strategy.id}
                  className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4"
                >
                  {editingId === strategy.id ? (
                    <div className="space-y-3">
                      <input
                        type="text"
                        value={editDraft.name}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, name: event.target.value })
                        }
                        className="w-full bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF5A1F]"
                      />
                      <textarea
                        value={editDraft.description}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, description: event.target.value })
                        }
                        rows={2}
                        className="w-full bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF5A1F]"
                      />
                      <select
                        value={editDraft.visibility}
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            visibility: event.target.value as StrategyVisibilityName,
                          })
                        }
                        className="bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF5A1F]"
                      >
                        <option value="PRIVATE">Private</option>
                        <option value="PUBLIC">Public</option>
                      </select>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void submitEdit()}
                          disabled={busyId === strategy.id}
                          className="bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="text-xs text-[#9CA3AF] hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-white truncate">
                            {strategy.name}
                          </h3>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                              strategy.visibility === "PUBLIC"
                                ? "border-[#00D26A]/40 text-[#00D26A]"
                                : "border-[#6B7280]/40 text-[#9CA3AF]"
                            }`}
                          >
                            {strategy.visibility}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                              strategy.status === "ACTIVE"
                                ? "border-[#FF5A1F]/40 text-[#FF5A1F]"
                                : "border-[#6B7280]/40 text-[#6B7280]"
                            }`}
                          >
                            {strategy.status}
                          </span>
                        </div>
                        {strategy.description && (
                          <p className="mt-1 text-xs text-[#9CA3AF] line-clamp-2">
                            {strategy.description}
                          </p>
                        )}
                        <p className="mt-1 text-[10px] font-mono text-[#6B7280]">
                          Updated {new Date(strategy.updatedAt).toLocaleString()}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void toggleVisibility(strategy)}
                          disabled={busyId === strategy.id || strategy.status === "ARCHIVED"}
                          title={
                            strategy.visibility === "PUBLIC" ? "Make private" : "Publish to Discover"
                          }
                          className="p-1.5 rounded-lg border border-[#222834] text-[#9CA3AF] hover:text-white hover:border-[#323B4C] disabled:opacity-40"
                        >
                          {strategy.visibility === "PUBLIC" ? (
                            <Eye className="w-3.5 h-3.5" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(strategy.id);
                            setEditDraft({
                              name: strategy.name,
                              description: strategy.description ?? "",
                              visibility: strategy.visibility,
                            });
                          }}
                          disabled={busyId === strategy.id || strategy.status === "ARCHIVED"}
                          title="Edit"
                          className="p-1.5 rounded-lg border border-[#222834] text-[#9CA3AF] hover:text-white hover:border-[#323B4C] disabled:opacity-40"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void archive(strategy.id)}
                          disabled={busyId === strategy.id || strategy.status === "ARCHIVED"}
                          title="Archive (one-way)"
                          className="p-1.5 rounded-lg border border-[#222834] text-[#9CA3AF] hover:text-[#EF4444] hover:border-[#EF4444]/40 disabled:opacity-40"
                        >
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                        <Link
                          href={`/strategies/${strategy.id}`}
                          className="px-2 py-1 rounded-lg border border-[#222834] text-[10px] text-[#9CA3AF] hover:text-white hover:border-[#323B4C]"
                        >
                          Paper
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
