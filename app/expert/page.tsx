"use client";

import React from "react";
import Link from "next/link";
import { Layers, LineChart, Plus, Sparkles } from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";

/**
 * MODULE 13 — the Expert Trader landing page.
 *
 * A thin hub over the existing strategy tools: management lives at
 * `/expert/strategies`, paper trading under the strategies detail route. The
 * whole page is wrapped in RoleGate so a plain USER never sees the hub; the
 * backend still refuses every strategy write without EXPERT_TRADER regardless
 * of what this page renders.
 */
export default function ExpertHomePage() {
  return (
    <AppShell>
      <RoleGate roles={["EXPERT_TRADER", "PLATFORM_ADMIN"]}>
        <div className="p-6">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            Expert
          </div>
          <h1 className="text-2xl font-bold text-white">Expert Strategies</h1>
          <p className="mt-1 text-sm text-[#9CA3AF]">
            Create, edit and publish strategies. Paper trading is available on each strategy.
          </p>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Link
              href="/expert/strategies"
              className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5 hover:border-[#323B4C] transition-colors"
            >
              <Layers className="w-6 h-6 text-[#FF5A1F] mb-3" />
              <h2 className="text-sm font-semibold text-white">My strategies</h2>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Manage visibility, edit descriptions and archive strategies you no longer want to
                publish.
              </p>
            </Link>

            <Link
              href="/expert/strategies/new"
              className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5 hover:border-[#323B4C] transition-colors"
            >
              <Plus className="w-6 h-6 text-[#00D26A] mb-3" />
              <h2 className="text-sm font-semibold text-white">Create a strategy</h2>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Start a new private strategy, then publish it to Discover when you are ready.
              </p>
            </Link>

            <Link
              href="/discover"
              className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5 hover:border-[#323B4C] transition-colors"
            >
              <LineChart className="w-6 h-6 text-[#9CA3AF] mb-3" />
              <h2 className="text-sm font-semibold text-white">See what is public</h2>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Browse the public catalogue other traders have published.
              </p>
            </Link>
          </div>
        </div>
      </RoleGate>
    </AppShell>
  );
}
