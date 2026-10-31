"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, Plus, Sparkles } from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import { ApiError, createStrategy, type StrategyVisibilityName } from "@/lib/api-client";

/**
 * MODULE 13 — create a strategy as an Expert Trader.
 *
 * A focused form rather than a modal: creating a strategy is a deliberate act,
 * and the name is unique per account so the conflict needs room to explain
 * itself. Visibility starts PRIVATE by default; publishing is a separate
 * decision on the manager page.
 */

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function NewStrategyPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<StrategyVisibilityName>("PRIVATE");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createStrategy({
        name: name.trim(),
        description: description.trim() || null,
        visibility,
      });
      router.push(`/strategies/${created.id}`);
    } catch (cause) {
      setError(messageFor(cause));
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <RoleGate roles={["EXPERT_TRADER", "PLATFORM_ADMIN"]}>
        <div className="max-w-xl mx-auto p-6">
          <Link
            href="/expert/strategies"
            className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white mb-6"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to strategies
          </Link>

          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            Expert
          </div>
          <h1 className="text-2xl font-bold text-white">Create a strategy</h1>
          <p className="mt-1 text-sm text-[#9CA3AF]">
            Starts private. Publish it from the manager when you want it in Discover.
          </p>

          {error && (
            <div className="mt-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
              <AlertTriangle className="w-4 h-4 inline mr-2" />
              {error}
            </div>
          )}

          <div className="mt-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5">Name</label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Momentum Swing"
                maxLength={120}
                className="w-full bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
              />
              <p className="mt-1 text-[11px] text-[#6B7280]">
                Unique per account, compared case-insensitively.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5">
                Description <span className="text-[#6B7280]">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="What does this strategy do, in your own words?"
                className="w-full bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5">Visibility</label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: "PRIVATE", label: "Private", hint: "Only you can see it." },
                    {
                      value: "PUBLIC",
                      label: "Public",
                      hint: "Appears in Discover for every signed-in user.",
                    },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setVisibility(option.value)}
                    className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors ${
                      visibility === option.value
                        ? "border-[#FF5A1F] bg-[#FF5A1F]/10 text-white"
                        : "border-[#222834] bg-[#14181F] text-[#9CA3AF] hover:border-[#323B4C] hover:text-white"
                    }`}
                  >
                    <div className="text-sm font-medium">{option.label}</div>
                    <div className="text-xs text-[#6B7280] mt-0.5">{option.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-2 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Create strategy
            </button>
          </div>
        </div>
      </RoleGate>
    </AppShell>
  );
}
