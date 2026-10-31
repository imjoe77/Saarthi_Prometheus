"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import {
  ApiError,
  createRoleRequest,
  getMyProfile,
  listMyRoleRequests,
  updateMyProfile,
  type ProfileResponse,
  type RoleRequest,
} from "@/lib/api-client";
import { useRoles } from "@/components/RoleProvider";

/**
 * MODULE 13 — revising financial preferences and requesting elevated roles.
 *
 * The questionnaire is the same set of `@IsIn`-validated choices the onboarding
 * wizard writes; this page is the ongoing editor for them, plus a short section
 * where a user can request EXPERT_TRADER or LIQUIDITY_PROVIDER access. There is
 * deliberately no control here that can grant a role directly: requests go to
 * the admin queue, and PLATFORM_ADMIN is not requestable at all.
 *
 * Nothing here fabricates suitability or expected returns — the answers are
 * stored preferences and the page never claims they were measured.
 */

type LoadStatus = "loading" | "ready" | "error";

interface Choice {
  value: string;
  label: string;
}

const EXPERIENCE: Choice[] = [
  { value: "NONE", label: "None" },
  { value: "BEGINNER", label: "Beginner" },
  { value: "INTERMEDIATE", label: "Intermediate" },
  { value: "EXPERIENCED", label: "Experienced" },
];

const CAPITAL_RANGE: Choice[] = [
  { value: "UNDER_10K", label: "Under ₹10,000" },
  { value: "10K_50K", label: "₹10,000 – ₹50,000" },
  { value: "50K_250K", label: "₹50,000 – ₹2,50,000" },
  { value: "250K_1M", label: "₹2,50,000 – ₹10,00,000" },
  { value: "OVER_1M", label: "Over ₹10,00,000" },
];

const CAPITAL_AVAILABILITY: Choice[] = [
  { value: "SHORT_TERM", label: "Short term" },
  { value: "MEDIUM_TERM", label: "Medium term" },
  { value: "LONG_TERM", label: "Long term" },
];

const RISK_TOLERANCE: Choice[] = [
  { value: "CONSERVATIVE", label: "Conservative" },
  { value: "BALANCED", label: "Balanced" },
  { value: "AGGRESSIVE", label: "Aggressive" },
];

const DRAWDOWN: Choice[] = [
  { value: "LOW", label: "Low" },
  { value: "MODERATE", label: "Moderate" },
  { value: "HIGH", label: "High" },
];

const VOLATILITY: Choice[] = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
];

const GOAL: Choice[] = [
  { value: "CAPITAL_PRESERVATION", label: "Protect capital" },
  { value: "GROWTH", label: "Grow wealth" },
  { value: "BALANCE", label: "Balance" },
  { value: "INCOME", label: "Generate income" },
];

const HORIZON: Choice[] = [
  { value: "UNDER_1_YEAR", label: "Under 1 year" },
  { value: "1_3_YEARS", label: "1 – 3 years" },
  { value: "3_5_YEARS", label: "3 – 5 years" },
  { value: "OVER_5_YEARS", label: "Over 5 years" },
];

const EXPECTED_RETURN: Choice[] = [
  { value: "CONSERVATIVE", label: "Conservative" },
  { value: "MODERATE", label: "Moderate" },
  { value: "AMBITIOUS", label: "Ambitious" },
];

const HOLDING: Choice[] = [
  { value: "SHORT_TERM", label: "Short term" },
  { value: "MEDIUM_TERM", label: "Medium term" },
  { value: "LONG_TERM", label: "Long term" },
];

const LOSS_REACTION: Choice[] = [
  { value: "SELL", label: "Sell" },
  { value: "HOLD", label: "Hold" },
  { value: "BUY_MORE", label: "Buy more" },
];

const LIQUIDITY: Choice[] = [
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
];

const CONTRIBUTION: Choice[] = [
  { value: "ONE_TIME", label: "One time" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "FLEXIBLE", label: "Flexible" },
];

const FIELDS: Array<{
  key: keyof ProfileResponse;
  label: string;
  choices: Choice[];
}> = [
  { key: "experienceLevel", label: "Experience level", choices: EXPERIENCE },
  { key: "investmentCapitalRange", label: "Capital range", choices: CAPITAL_RANGE },
  { key: "capitalAvailability", label: "Capital availability", choices: CAPITAL_AVAILABILITY },
  { key: "riskTolerance", label: "Risk tolerance", choices: RISK_TOLERANCE },
  { key: "drawdownComfort", label: "Drawdown comfort", choices: DRAWDOWN },
  { key: "volatilityComfort", label: "Volatility comfort", choices: VOLATILITY },
  { key: "primaryGoal", label: "Primary goal", choices: GOAL },
  { key: "timeHorizon", label: "Time horizon", choices: HORIZON },
  { key: "expectedReturnRange", label: "Expected return range", choices: EXPECTED_RETURN },
  { key: "holdingPeriod", label: "Holding period", choices: HOLDING },
  { key: "lossReaction", label: "Loss reaction", choices: LOSS_REACTION },
  { key: "liquidityNeeds", label: "Liquidity needs", choices: LIQUIDITY },
  { key: "contributionFrequency", label: "Contribution frequency", choices: CONTRIBUTION },
];

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function PreferencesPage() {
  const { roles, heldRoles, activeRole, requestable, refresh: refreshRoles, loading: rolesLoading } = useRoles();
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestNote, setRequestNote] = useState("");
  const [requesting, setRequesting] = useState<string | null>(null);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requestHistory, setRequestHistory] = useState<RoleRequest[]>([]);

  const reloadHistory = useCallback(async () => {
    try {
      setRequestHistory(await listMyRoleRequests());
    } catch {
      // History is supporting detail; the live buttons and the admin queue
      // remain the source of truth, so a failed read shows nothing, not errors.
      setRequestHistory([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    listMyRoleRequests()
      .then((result) => {
        if (active) setRequestHistory(result);
      })
      .catch(() => {
        if (active) setRequestHistory([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await getMyProfile();
      setProfile(result);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    getMyProfile()
      .then((result) => {
        if (!active) return;
        setProfile(result);
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

  const saveField = async (key: keyof ProfileResponse, value: string): Promise<void> => {
    setSavingKey(key);
    setError(null);
    try {
      const updated = await updateMyProfile({ [key]: value } as Partial<ProfileResponse>);
      setProfile(updated);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSavingKey(null);
    }
  };

  const submitRequest = async (role: "EXPERT_TRADER" | "LIQUIDITY_PROVIDER"): Promise<void> => {
    setRequesting(role);
    setRequestMessage(null);
    setError(null);
    try {
      await createRoleRequest({
        role,
        note: requestNote.trim() || undefined,
      });
      setRequestMessage(
        role === "EXPERT_TRADER"
          ? "Expert Trader request submitted. An admin will review it."
          : "Liquidity Provider request submitted. An admin will review it.",
      );
      setRequestNote("");
      await refreshRoles();
      await reloadHistory();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setRequesting(null);
    }
  };

  if (status === "loading") {
    return (
      <AppShell>
        <div className="p-6 space-y-4" aria-busy="true">
          <div className="h-8 w-64 rounded bg-[#181D26] animate-pulse" />
          <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
        </div>
      </AppShell>
    );
  }

  if (status === "error") {
    return (
      <AppShell>
        <div className="p-6">
          <div className="rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-4 text-sm text-[#EF4444]">
            <AlertTriangle className="w-4 h-4 inline mr-2" />
            {error}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
              <Settings className="w-3.5 h-3.5" />
              Preferences
            </div>
            <h1 className="text-2xl font-bold text-white">Financial preferences</h1>
            <p className="mt-1 text-sm text-[#9CA3AF]">
              Stated preferences only — not a suitability score or a forecast.
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

        {!profile?.onboardingCompletedAt && (
          <div className="mb-6 rounded-xl border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-4 text-sm text-[#F59E0B]">
            You have not finished onboarding yet.{" "}
            <Link href="/onboarding" className="underline font-semibold">
              Complete it here
            </Link>{" "}
            so we know your baseline answers.
          </div>
        )}

        <div className="space-y-6">
          {FIELDS.map((field) => (
            <div key={field.key} className="flex items-center justify-between gap-4">
              <span className="text-sm text-white shrink-0">{field.label}</span>
              <div className="flex flex-wrap gap-1.5 justify-end">
                {field.choices.map((choice) => {
                  const selected = profile?.[field.key] === choice.value;
                  const busy = savingKey === field.key;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      disabled={busy}
                      onClick={() => void saveField(field.key, choice.value)}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        selected
                          ? "bg-[#FF5A1F] text-white"
                          : "bg-[#14181F] border border-[#222834] text-[#9CA3AF] hover:text-white hover:border-[#323B4C]"
                      }`}
                    >
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : choice.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Role requests */}
        <div className="mt-12 rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="w-4 h-4 text-[#FF5A1F]" />
            <h2 className="text-sm font-semibold text-white">Access requests</h2>
          </div>
          <p className="text-xs text-[#9CA3AF] mb-4">
            Request an elevated role. An admin reviews every request; nothing here grants a role
            directly.
          </p>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-[#6B7280]">Current roles:</span>
            {/* The account's full grant set — not the persona-scoped one — so a
                role signed in as Normal User still shows (and stays visible as
                "held" while requestable correctly omits it). */}
            {(heldRoles.length > 0 ? heldRoles : roles).map((role) => (
              <span
                key={role}
                className="px-2 py-0.5 rounded bg-[#1C222C] border border-[#2B3545] text-[10px] font-mono text-[#7E8B9E]"
              >
                {role}
                {activeRole === role && (
                  <span className="ml-1 text-[#FF5A1F]">• this session</span>
                )}
              </span>
            ))}
            {rolesLoading && <Loader2 className="w-3 h-3 animate-spin text-[#6B7280]" />}
          </div>

          <textarea
            value={requestNote}
            onChange={(event) => setRequestNote(event.target.value)}
            placeholder="Optional note for the admin (why you need this role)…"
            rows={2}
            maxLength={500}
            className="w-full bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-xs text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F] mb-3"
          />

          <div className="flex flex-wrap gap-2">
            {requestable.includes("EXPERT_TRADER") && (
              <button
                type="button"
                disabled={requesting !== null}
                onClick={() => void submitRequest("EXPERT_TRADER")}
                className="inline-flex items-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {requesting === "EXPERT_TRADER" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3 h-3" />
                )}
                Request Expert Trader
              </button>
            )}
            {requestable.includes("LIQUIDITY_PROVIDER") && (
              <button
                type="button"
                disabled={requesting !== null}
                onClick={() => void submitRequest("LIQUIDITY_PROVIDER")}
                className="inline-flex items-center gap-1.5 bg-[#14181F] border border-[#222834] hover:border-[#323B4C] text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {requesting === "LIQUIDITY_PROVIDER" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3 h-3" />
                )}
                Request Liquidity Provider
              </button>
            )}
            {requestable.length === 0 && !rolesLoading && (
              <span className="text-xs text-[#6B7280]">
                You already hold every requestable role.
              </span>
            )}
          </div>

          {requestMessage && (
            <div className="mt-3 rounded-lg border border-[#00D26A]/40 bg-[#00D26A]/10 p-2.5 text-xs text-[#00D26A]">
              <CheckCircle2 className="w-3.5 h-3.5 inline mr-1.5" />
              {requestMessage}
            </div>
          )}

          {requestHistory.length > 0 && (
            <div className="mt-4 border-t border-[#222834] pt-3">
              <div className="text-xs text-[#6B7280] mb-2">Your request history</div>
              <ul className="space-y-1.5">
                {requestHistory.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-mono text-[#9CA3AF]">{entry.role}</span>
                    <span className="text-[#6B7280]">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        entry.status === "APPROVED"
                          ? "bg-[#00D26A]/10 border-[#00D26A]/40 text-[#00D26A]"
                          : entry.status === "REJECTED"
                            ? "bg-[#EF4444]/10 border-[#EF4444]/40 text-[#EF4444]"
                            : "bg-[#F59E0B]/10 border-[#F59E0B]/40 text-[#F59E0B]"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
