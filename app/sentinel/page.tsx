"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bell,
  BellRing,
  CheckCircle2,
  Loader2,
  Phone,
  PhoneOff,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Clock,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  cancelSentinelAlert,
  confirmSentinelVerification,
  createSentinelAlert,
  getInstruments,
  getSentinelStatus,
  grantSentinelConsent,
  listSentinelAlerts,
  listSentinelCalls,
  requestSentinelVerification,
  setSentinelPhone,
  setSentinelQuietHours,
  setSentinelVoiceDisabled,
  updateSentinelAlert,
  withdrawSentinelConsent,
  type InstrumentDto,
  type SentinelAlert,
  type SentinelAlertStatus,
  type SentinelCallGate,
  type SentinelCallHistoryItem,
  type SentinelCondition,
  type SentinelStatus,
} from "@/lib/api-client";

/**
 * MODULE 14 — Sentinel: price alerts that place a VOICE CALL, never a trade.
 *
 * What this page must keep honest:
 *  - Sentinel never sells anything. Copy says "call", never "order"; the only
 *    action offered here is cancelling or editing one's own alert.
 *  - The observed price is shown exactly as the backend last recorded it, with
 *    its timestamp, its provider and a STALE marker when the observation is
 *    old. A null observation renders as "no observation yet" - never as zero,
 *    and never as a fabricated number. A stale price cannot trigger a call and
 *    the page says so rather than implying otherwise.
 *  - A call row reports what the provider actually reported. `CALL_COMPLETED`
 *    is shown only because the backend wrote it from a verified webhook; a
 *    failed call shows its failure reason. Nothing here claims a call that did
 *    not happen, and the "call placed" summary is derived from the server's
 *    own counters, not from this page's optimism.
 *  - The configured voice provider is labelled: `off` means a trigger records
 *    an honest failure instead of dialling, `fake` means dials are recorded in
 *    memory and reach no phone, `twilio` means real telephony. This page never
 *    implies real calls are happening when the server is in `off` or `fake`.
 *
 * No role gate is applied to the *data* here - the backend's AuthGuard owns
 * that. RoleGate merely keeps a non-eligible role from rendering a screen
 * whose every request would be refused.
 */

type LoadStatus = "loading" | "ready" | "error";

/** Statuses a user may still act on: ACTIVE may be edited, these may be cancelled. */
const EDITABLE_STATUSES: SentinelAlertStatus[] = ["ACTIVE"];
const CANCELLABLE_STATUSES: SentinelAlertStatus[] = [
  "ACTIVE",
  "TRIGGERED",
  "CALL_QUEUED",
  "CALLING",
];

const STATUS_META: Record<SentinelAlertStatus, { label: string; className: string }> = {
  ACTIVE: { label: "Active", className: "border-[#00D26A]/40 bg-[#00D26A]/10 text-[#00D26A]" },
  TRIGGERED: { label: "Triggered", className: "border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]" },
  CALL_QUEUED: { label: "Call queued", className: "border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6]" },
  CALLING: { label: "Calling", className: "border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6]" },
  CALL_COMPLETED: { label: "Call completed", className: "border-[#00D26A]/40 bg-[#00D26A]/10 text-[#00D26A]" },
  CALL_FAILED: { label: "Call failed", className: "border-[#EF4444]/40 bg-[#EF4444]/10 text-[#EF4444]" },
  CANCELLED: { label: "Cancelled", className: "border-[#262E3B] bg-[#14181F] text-[#6B7280]" },
  EXPIRED: { label: "Expired", className: "border-[#262E3B] bg-[#14181F] text-[#6B7280]" },
};

const CALL_STATUS_META: Record<string, { label: string; className: string }> = {
  QUEUED: { label: "Queued", className: "border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6]" },
  INITIATED: { label: "Initiated", className: "border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6]" },
  COMPLETED: { label: "Completed", className: "border-[#00D26A]/40 bg-[#00D26A]/10 text-[#00D26A]" },
  BUSY: { label: "Busy", className: "border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]" },
  NO_ANSWER: { label: "No answer", className: "border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]" },
  REJECTED: { label: "Rejected", className: "border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]" },
  CANCELED: { label: "Cancelled", className: "border-[#262E3B] bg-[#14181F] text-[#6B7280]" },
  FAILED: { label: "Failed", className: "border-[#EF4444]/40 bg-[#EF4444]/10 text-[#EF4444]" },
};

const PROVIDER_META: Record<
  "off" | "fake" | "twilio",
  { label: string; className: string; honesty: string }
> = {
  off: {
    label: "Voice off",
    className: "border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]",
    honesty:
      "This server places no calls. A triggered alert records an honest failure (VOICE_PROVIDER_DISABLED) — it never pretends a call happened.",
  },
  fake: {
    label: "Test provider",
    className: "border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6]",
    honesty:
      "Development mode: dials are recorded in memory and reach no phone. Use it to exercise the whole flow safely.",
  },
  twilio: {
    label: "Live telephony",
    className: "border-[#00D26A]/40 bg-[#00D26A]/10 text-[#00D26A]",
    honesty: "Real telephony. Each triggered alert places a real phone call to your verified number.",
  },
};

/** Plain-language explanation of each gate the backend can report. */
const GATE_COPY: Record<SentinelCallGate, string> = {
  OK: "The next qualifying trigger will place a call.",
  PROVIDER_OFF: "Voice calling is off on this server, so a trigger records a failure instead of calling.",
  VOICE_OFF: "Voice calls are switched off for your account. Alerts still track prices.",
  PHONE_UNVERIFIED: "Verify your phone number below to receive calls.",
  CONSENT_MISSING: "Grant consent to automated calls below.",
  QUIET_HOURS: "Quiet hours are active. A trigger waits until the window ends.",
  USER_DAILY_LIMIT: "Your daily call allowance is used up. It resets at the next UTC midnight.",
  PLATFORM_DAILY_LIMIT: "The platform's daily call budget is used up. It resets at the next UTC midnight.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

/** Minutes since UTC midnight <-> the `HH:MM` a time input speaks. */
function minutesToHhMm(minutes: number | null): string {
  if (minutes === null || minutes < 0 || minutes > 1439) return "";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function hhMmToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1439 ? minutes : null;
}

function conditionGlyph(condition: SentinelCondition): string {
  return condition === "GREATER_THAN_OR_EQUAL" ? "≥" : "≤";
}

/** True when the string is a decimal greater than zero (server re-checks exactly). */
function isPositiveDecimal(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/** A `<select>` and `<input>` pair share this look with the rest of the app. */
const FIELD_CLASS =
  "bg-[#14181F] border border-[#222834] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#FF5A1F]";

const BUTTON_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50";

const BUTTON_NEUTRAL =
  "inline-flex items-center justify-center gap-1.5 border border-[#222834] bg-[#14181F] hover:border-[#39424F] text-[#9CA3AF] hover:text-white px-3 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50";

export default function SentinelPage() {
  return (
    <RoleGate roles={["USER", "EXPERT_TRADER"]}>
      <SentinelScreen />
    </RoleGate>
  );
}

function SentinelScreen() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [sentinel, setSentinel] = useState<SentinelStatus | null>(null);
  const [alerts, setAlerts] = useState<SentinelAlert[]>([]);
  const [calls, setCalls] = useState<SentinelCallHistoryItem[]>([]);
  const [instruments, setInstruments] = useState<InstrumentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Create form.
  const [symbol, setSymbol] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [condition, setCondition] = useState<SentinelCondition>("GREATER_THAN_OR_EQUAL");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);

  // Inline edit form, keyed by the alert being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState("");
  const [editCondition, setEditCondition] = useState<SentinelCondition>("GREATER_THAN_OR_EQUAL");
  const [editVoice, setEditVoice] = useState(true);
  const [editExpires, setEditExpires] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Voice setup.
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [voiceBusy, setVoiceBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [statusView, alertPage, callPage, catalogue] = await Promise.all([
        getSentinelStatus(),
        listSentinelAlerts({ limit: 50 }),
        listSentinelCalls({ limit: 20 }),
        getInstruments(),
      ]);
      setSentinel(statusView);
      setAlerts(alertPage.items);
      setCalls(callPage.items);
      setInstruments(catalogue);
      // Seed the quiet-hour inputs from the server's own values here, at the
      // moment the data lands, rather than in an effect — seeding in an effect
      // would fire a second render and is exactly the cascading-render trap.
      // Later reloads only re-seed when the window is untouched by the user.
      setQuietStart((current) =>
        current === "" ? minutesToHhMm(statusView.voiceSettings.quietHoursStartUtc) : current,
      );
      setQuietEnd((current) =>
        current === "" ? minutesToHhMm(statusView.voiceSettings.quietHoursEndUtc) : current,
      );
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // State is applied inside the promise callbacks, never synchronously in
    // the effect body, so this reads as a subscription rather than a render
    // that cascades into another (house pattern; see app/wallet/page.tsx).
    let active = true;
    Promise.all([
      getSentinelStatus(),
      listSentinelAlerts({ limit: 50 }),
      listSentinelCalls({ limit: 20 }),
      getInstruments(),
    ])
      .then(([statusView, alertPage, callPage, catalogue]) => {
        if (!active) return;
        setSentinel(statusView);
        setAlerts(alertPage.items);
        setCalls(callPage.items);
        setInstruments(catalogue);
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

  // Prefill the spoken name from the catalogue so the user rarely types it,
  // but never fight a name they have already chosen.
  const onSymbolChange = (next: string): void => {
    setSymbol(next);
    const chosen = instruments.find((item) => item.symbol === next);
    if (chosen) setDisplayName(chosen.name);
  };

  const submitCreate = async (): Promise<void> => {
    if (!symbol || !isPositiveDecimal(targetPrice) || !displayName.trim()) return;
    setCreating(true);
    setError(null);
    setFlash(null);
    try {
      const created = await createSentinelAlert({
        symbol,
        displayName: displayName.trim(),
        targetPrice: targetPrice.trim(),
        condition,
        voiceEnabled,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      setFlash(
        `Alert armed for ${created.displayName} (${created.symbol}): ${conditionGlyph(created.condition)} ` +
          `${created.targetPrice} ${created.quoteCurrency}. Sentinel watches the market and calls — it never trades.`,
      );
      setTargetPrice("");
      setExpiresAt("");
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (alert: SentinelAlert): void => {
    setEditingId(alert.alertId);
    // Prisma serialises `85.20` as `85.2`; the value, not its trailing zeros,
    // is what round-trips, so the field is seeded with the server's own string.
    setEditTarget(alert.targetPrice);
    setEditCondition(alert.condition);
    setEditVoice(alert.voiceEnabled);
    setEditExpires(alert.expiresAt ? alert.expiresAt.slice(0, 16) : "");
    setError(null);
    setFlash(null);
  };

  const submitEdit = async (alertId: string): Promise<void> => {
    if (!isPositiveDecimal(editTarget)) return;
    setEditSaving(true);
    setError(null);
    setFlash(null);
    try {
      // An empty expiry field clears the expiry; the form is always seeded
      // with the current value, so clearing it is an explicit choice.
      const updated = await updateSentinelAlert(alertId, {
        targetPrice: editTarget.trim(),
        condition: editCondition,
        voiceEnabled: editVoice,
        expiresAt: editExpires ? new Date(editExpires).toISOString() : null,
      });
      setFlash(
        `Saved: ${updated.displayName} now triggers at ${conditionGlyph(updated.condition)} ${updated.targetPrice} ` +
          `${updated.quoteCurrency}.`,
      );
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setEditSaving(false);
    }
  };

  const submitCancel = async (alert: SentinelAlert): Promise<void> => {
    setError(null);
    setFlash(null);
    try {
      // Cancelling retires the alert; it is not deleted, so history survives.
      await cancelSentinelAlert(alert.alertId, "OWNER_REQUEST");
      setFlash(`${alert.displayName} (${alert.symbol}) cancelled. It will never trigger or call.`);
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    }
  };

  const runVoice = async (key: string, action: () => Promise<void>): Promise<void> => {
    setVoiceBusy(key);
    setError(null);
    setFlash(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setVoiceBusy(null);
    }
  };

  const voiceSettings = sentinel?.voiceSettings ?? null;

  const providerMeta = sentinel ? PROVIDER_META[sentinel.voiceProvider] : null;

  const counts = useMemo(() => {
    const byStatus = new Map<SentinelAlertStatus, number>();
    for (const alert of alerts) byStatus.set(alert.status, (byStatus.get(alert.status) ?? 0) + 1);
    return byStatus;
  }, [alerts]);

  const canSubmitCreate = Boolean(symbol) && Boolean(displayName.trim()) && isPositiveDecimal(targetPrice) && !creating;

  return (
    <AppShell>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
              <Bell className="w-3.5 h-3.5" />
              Sentinel · Module 14
            </div>
            <h1 className="text-2xl font-bold text-white">Price alerts that call you</h1>
            <p className="mt-1 text-sm text-[#9CA3AF]">
              Sentinel watches the market and places a voice call when your target is reached. It is an alerting
              service — <span className="text-[#F3F4F6] font-medium">it never places a trade</span>. You decide
              whether to act.
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

        {flash && (
          <div className="mb-4 rounded-xl border border-[#00D26A]/40 bg-[#00D26A]/10 p-3 text-sm text-[#00D26A]">
            <Sparkles className="w-4 h-4 inline mr-2" />
            {flash}
          </div>
        )}

        {status === "loading" && (
          <div className="space-y-3" aria-busy="true">
            <div className="h-24 rounded-xl bg-[#181D26] animate-pulse" />
            <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
            <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
          </div>
        )}

        {status === "error" && (
          <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-10 text-center">
            <AlertTriangle className="w-10 h-10 text-[#6B7280] mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-white">Sentinel could not be loaded</h2>
            <p className="mt-1 text-sm text-[#9CA3AF]">{error}</p>
            <button
              onClick={() => void load()}
              className={`mt-4 ${BUTTON_PRIMARY}`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        )}

        {status === "ready" && sentinel && (
          <>
            {/* ---- Health ------------------------------------------------ */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
                <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Voice provider</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${providerMeta?.className}`}>
                    {providerMeta?.label ?? sentinel.voiceProvider}
                  </span>
                  {sentinel.workerEnabled ? (
                    <span className="text-[11px] text-[#9CA3AF]">worker running</span>
                  ) : (
                    <span className="text-[11px] text-[#F59E0B]">worker idle</span>
                  )}
                </div>
                <p className="mt-1.5 text-[11px] text-[#9CA3AF]">{providerMeta?.honesty}</p>
              </div>

              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
                <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Can you be called?</p>
                <p
                  className={`mt-1 text-lg font-semibold ${
                    sentinel.callGate === "OK" ? "text-[#00D26A]" : "text-[#F59E0B]"
                  }`}
                >
                  {sentinel.callGate === "OK" ? "Yes — ready" : sentinel.callGate.replace(/_/g, " ")}
                </p>
                <p className="mt-1 text-[11px] text-[#9CA3AF]">{GATE_COPY[sentinel.callGate]}</p>
              </div>

              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
                <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Alerts</p>
                <p className="mt-1 text-xl font-semibold text-white">
                  {sentinel.activeAlerts}
                  <span className="text-sm font-normal text-[#6B7280]"> active</span>
                </p>
                <p className="mt-1 text-[11px] text-[#9CA3AF]">
                  {sentinel.triggeredAlerts} triggered · {sentinel.expiredAlerts} expired ·{" "}
                  {sentinel.cancelledAlerts} cancelled
                </p>
              </div>

              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
                <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Calls today</p>
                <p className="mt-1 text-xl font-semibold text-white">
                  {sentinel.callsUsedTodayUtc}
                  <span className="text-sm font-normal text-[#6B7280]"> / {sentinel.maxCallsPerUserPerDay}</span>
                </p>
                <p className="mt-1 text-[11px] text-[#9CA3AF]">
                  {sentinel.pendingCalls} pending · {sentinel.completedCalls} completed ·{" "}
                  {sentinel.failedCalls} failed
                </p>
              </div>
            </div>

            {/* ---- Create ------------------------------------------------ */}
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-6">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
                <BellRing className="w-4 h-4 text-[#FF5A1F]" />
                New alert
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <select
                  value={symbol}
                  onChange={(event) => onSymbolChange(event.target.value)}
                  className={FIELD_CLASS}
                  aria-label="Instrument"
                >
                  <option value="">Choose an instrument…</option>
                  {instruments.map((instrument) => (
                    <option key={instrument.symbol} value={instrument.symbol}>
                      {instrument.symbol} — {instrument.name} ({instrument.kind.toLowerCase()})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Name shown and spoken (e.g. Reliance Industries)"
                  maxLength={120}
                  className={FIELD_CLASS}
                />
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={targetPrice}
                    onChange={(event) => setTargetPrice(event.target.value)}
                    placeholder="Target price (e.g. 85.20)"
                    maxLength={40}
                    className={`${FIELD_CLASS} flex-1`}
                  />
                  <span className="text-[11px] text-[#6B7280] whitespace-nowrap">
                    {instruments.find((item) => item.symbol === symbol)?.quoteCurrency ?? "quote"}
                  </span>
                </div>
                <select
                  value={condition}
                  onChange={(event) => setCondition(event.target.value as SentinelCondition)}
                  className={FIELD_CLASS}
                  aria-label="Condition"
                >
                  <option value="GREATER_THAN_OR_EQUAL">At or above (≥) the target</option>
                  <option value="LESS_THAN_OR_EQUAL">At or below (≤) the target</option>
                </select>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  aria-label="Optional expiry"
                  className={FIELD_CLASS}
                />
                <button
                  type="button"
                  onClick={() => void submitCreate()}
                  disabled={!canSubmitCreate}
                  className={BUTTON_PRIMARY}
                >
                  {creating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Bell className="w-3.5 h-3.5" />
                  )}
                  Arm alert
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[#9CA3AF]">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={voiceEnabled}
                    onChange={(event) => setVoiceEnabled(event.target.checked)}
                    className="accent-[#FF5A1F]"
                  />
                  Call me when this triggers
                </label>
                <span>·</span>
                <span>Leave expiry empty for an open-ended alert.</span>
                <span>·</span>
                <span>The market is polled from the configured provider; a stale price never triggers a call.</span>
              </div>
            </div>

            {/* ---- Alerts ------------------------------------------------ */}
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-6">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#00D26A]" />
                  Your alerts
                </h2>
                <span className="ml-auto text-[11px] text-[#6B7280]">
                  {alerts.length} shown · only your own alerts are ever loaded
                </span>
              </div>

              {alerts.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] py-6 text-center">
                  No alerts yet. Arm one above and Sentinel will watch it for you.
                </p>
              ) : (
                <div className="space-y-3">
                  {alerts.map((alert) => {
                    const meta = STATUS_META[alert.status];
                    const isEditing = editingId === alert.alertId;
                    const isStale = alert.observedStale === true;
                    return (
                      <div
                        key={alert.alertId}
                        className="rounded-lg border border-[#222834] bg-[#0F131A] p-4"
                      >
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${meta.className}`}
                              >
                                {meta.label}
                              </span>
                              <span className="text-sm font-semibold text-white">{alert.displayName}</span>
                              <span className="text-[11px] text-[#6B7280] font-mono">
                                {alert.symbol} · {alert.exchange}
                              </span>
                              {!alert.voiceEnabled && (
                                <span className="inline-flex items-center gap-1 text-[10px] text-[#6B7280]">
                                  <PhoneOff className="w-3 h-3" />
                                  voice off
                                </span>
                              )}
                            </div>

                            <p className="mt-1.5 text-sm text-[#F3F4F6]">
                              Call when the price is{" "}
                              <span className="font-mono font-semibold text-white">
                                {conditionGlyph(alert.condition)} {alert.targetPrice} {alert.quoteCurrency}
                              </span>
                            </p>

                            <p className="mt-1 text-[11px] text-[#9CA3AF]">
                              {alert.observedPrice !== null ? (
                                <>
                                  Last observed{" "}
                                  <span className="font-mono text-[#F3F4F6]">
                                    {alert.observedPrice} {alert.quoteCurrency}
                                  </span>
                                  {alert.observedProvider && <> · via {alert.observedProvider}</>}
                                  {alert.observedMarketState && <> · market {alert.observedMarketState}</>}
                                  {isStale && (
                                    <span className="ml-1 rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-1 py-0.5 text-[10px] font-bold text-[#F59E0B]">
                                      STALE — will not trigger
                                    </span>
                                  )}
                                </>
                              ) : (
                                <>No observation yet — Sentinel needs a fresh market price before it can trigger.</>
                              )}
                            </p>

                            {alert.callSkipReason && (
                              <p className="mt-1 text-[11px] text-[#6B7280]">
                                <span className="text-[#F59E0B]">No call: {alert.callSkipReason}.</span>
                              </p>
                            )}

                            {alert.call && (
                              <div className="mt-2 rounded-lg border border-[#222834] bg-[#14181F] p-2.5">
                                {(() => {
                                  const callMeta = CALL_STATUS_META[alert.call!.status] ?? {
                                    label: alert.call!.status,
                                    className: "border-[#262E3B] bg-[#14181F] text-[#9CA3AF]",
                                  };
                                  return (
                                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                      <Phone
                                        className={`w-3.5 h-3.5 ${
                                          alert.call!.status === "COMPLETED" ? "text-[#00D26A]" : "text-[#6B7280]"
                                        }`}
                                      />
                                      <span
                                        className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${callMeta.className}`}
                                      >
                                        {callMeta.label}
                                      </span>
                                      <span className="text-[#9CA3AF]">
                                        attempt {alert.call!.attempts}/{alert.call!.maxAttempts}
                                      </span>
                                      {alert.call!.failReason && (
                                        <span className="text-[#EF4444]">
                                          failed: {alert.call!.failReason}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col gap-2 shrink-0">
                            {EDITABLE_STATUSES.includes(alert.status) && !isEditing && (
                              <button
                                onClick={() => startEdit(alert)}
                                className={BUTTON_NEUTRAL}
                              >
                                Edit
                              </button>
                            )}
                            {CANCELLABLE_STATUSES.includes(alert.status) && !isEditing && (
                              <button
                                onClick={() => void submitCancel(alert)}
                                className="inline-flex items-center justify-center gap-1.5 border border-[#EF4444]/40 bg-[#EF4444]/10 hover:bg-[#EF4444]/20 text-[#EF4444] px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                              >
                                <Ban className="w-3.5 h-3.5" />
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>

                        {isEditing && (
                          <div className="mt-3 rounded-lg border border-[#FF5A1F]/40 bg-[#FF5A1F]/5 p-3">
                            <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                              Editing — only an ACTIVE alert can be edited
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={editTarget}
                                onChange={(event) => setEditTarget(event.target.value)}
                                aria-label="Target price"
                                className={FIELD_CLASS}
                              />
                              <select
                                value={editCondition}
                                onChange={(event) =>
                                  setEditCondition(event.target.value as SentinelCondition)
                                }
                                aria-label="Condition"
                                className={FIELD_CLASS}
                              >
                                <option value="GREATER_THAN_OR_EQUAL">At or above (≥)</option>
                                <option value="LESS_THAN_OR_EQUAL">At or below (≤)</option>
                              </select>
                              <input
                                type="datetime-local"
                                value={editExpires}
                                onChange={(event) => setEditExpires(event.target.value)}
                                aria-label="Expiry"
                                className={FIELD_CLASS}
                              />
                              <div className="flex items-center gap-2">
                                <label className="inline-flex items-center gap-1.5 text-[11px] text-[#9CA3AF] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={editVoice}
                                    onChange={(event) => setEditVoice(event.target.checked)}
                                    className="accent-[#FF5A1F]"
                                  />
                                  Call me
                                </label>
                                <button
                                  onClick={() => void submitEdit(alert.alertId)}
                                  disabled={editSaving || !isPositiveDecimal(editTarget)}
                                  className={`${BUTTON_PRIMARY} flex-1`}
                                >
                                  {editSaving ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                  )}
                                  Save
                                </button>
                                <button onClick={() => setEditingId(null)} className={BUTTON_NEUTRAL}>
                                  Close
                                </button>
                              </div>
                            </div>
                            <p className="mt-2 text-[11px] text-[#6B7280]">
                              Clearing the expiry field removes the expiry. A triggered alert becomes history and
                              can no longer be edited — cancel instead.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {counts.size > 0 && (
                <p className="mt-3 text-[11px] text-[#6B7280]">
                  This page shows your most recent {alerts.length} alerts. Older ones remain in the API.
                </p>
              )}
            </div>

            {/* ---- Voice setup ------------------------------------------- */}
            {voiceSettings && (
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 mb-6">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-1">
                  <Phone className="w-4 h-4 text-[#3B82F6]" />
                  Call settings
                </h2>
                <p className="text-[11px] text-[#9CA3AF] mb-3">
                  A number, its verification, your consent and the contact window describe you — not an alert —
                  and every alert you own dials through this gate.
                  {sentinel?.voiceProvider === "off" && (
                    <> Right now the server places no calls at all; you can still complete this setup.</>
                  )}
                </p>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Phone + verification */}
                  <div className="rounded-lg border border-[#222834] bg-[#0F131A] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                      Phone number
                    </p>
                    {voiceSettings.phoneVerified ? (
                      <p className="text-sm text-[#00D26A] flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4" />
                        {voiceSettings.phoneMasked} — verified
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] text-[#9CA3AF] mb-2">
                          Current: {voiceSettings.phoneMasked ?? "no number on file"}. Setting a new number
                          resets its verification.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <input
                            type="tel"
                            value={phone}
                            onChange={(event) => setPhone(event.target.value)}
                            placeholder="+14155552671 (E.164)"
                            maxLength={32}
                            className={`${FIELD_CLASS} flex-1 min-w-[180px]`}
                          />
                          <button
                            onClick={() =>
                              void runVoice("phone", async () => {
                                const settings = await setSentinelPhone(phone.trim());
                                setFlash(
                                  `Number saved as ${settings.phoneMasked}. Request a code to verify it.`,
                                );
                                setPhone("");
                              })
                            }
                            disabled={voiceBusy !== null || !phone.trim()}
                            className={BUTTON_NEUTRAL}
                          >
                            {voiceBusy === "phone" ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Phone className="w-3.5 h-3.5" />
                            )}
                            Save number
                          </button>
                        </div>
                      </>
                    )}

                    {!voiceSettings.phoneVerified && (
                      <div className="mt-3 rounded-lg border border-[#222834] bg-[#14181F] p-2.5">
                        <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                          Verification code
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() =>
                              void runVoice("send-code", async () => {
                                const result = await requestSentinelVerification();
                                setIssuedCode(result.code ?? null);
                                setFlash(
                                  result.code
                                    ? `Code issued: ${result.code} (dev mode — no SMS provider is configured).`
                                    : "Code issued. Delivery is pending an SMS provider; the code is not shown.",
                                );
                              })
                            }
                            disabled={voiceBusy !== null || !voiceSettings.phoneMasked}
                            className={BUTTON_NEUTRAL}
                          >
                            {voiceBusy === "send-code" ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <BellRing className="w-3.5 h-3.5" />
                            )}
                            Send code
                          </button>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            placeholder="6-digit code"
                            maxLength={6}
                            className={`${FIELD_CLASS} w-32`}
                          />
                          <button
                            onClick={() =>
                              void runVoice("confirm-code", async () => {
                                await confirmSentinelVerification(code.trim());
                                setIssuedCode(null);
                                setCode("");
                                setFlash("Number verified. You can now grant consent to automated calls.");
                              })
                            }
                            disabled={voiceBusy !== null || code.trim().length !== 6}
                            className={BUTTON_NEUTRAL}
                          >
                            {voiceBusy === "confirm-code" ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            Verify
                          </button>
                        </div>
                        {issuedCode && (
                          <p className="mt-2 text-[11px] text-[#F59E0B]">
                            Dev mode returns the code because no SMS delivery is configured:{" "}
                            <span className="font-mono font-bold">{issuedCode}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Consent + master switch */}
                  <div className="rounded-lg border border-[#222834] bg-[#0F131A] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                      Consent
                    </p>
                    {voiceSettings.consented ? (
                      <>
                        <p className="text-sm text-[#00D26A] flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4" />
                          Consent granted
                        </p>
                        <button
                          onClick={() =>
                            void runVoice("withdraw", async () => {
                              await withdrawSentinelConsent();
                              setFlash("Consent withdrawn. No further calls will be placed.");
                            })
                          }
                          disabled={voiceBusy !== null}
                          className={`mt-2 ${BUTTON_NEUTRAL}`}
                        >
                          {voiceBusy === "withdraw" ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Ban className="w-3.5 h-3.5" />
                          )}
                          Withdraw consent
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-[11px] text-[#9CA3AF] mb-2">
                          Sentinel may only call you with your explicit consent. It requires a verified number.
                        </p>
                        <button
                          onClick={() =>
                            void runVoice("consent", async () => {
                              await grantSentinelConsent();
                              setFlash("Consent recorded. Sentinel may now call you when an alert triggers.");
                            })
                          }
                          disabled={voiceBusy !== null || !voiceSettings.phoneVerified}
                          className={BUTTON_NEUTRAL}
                        >
                          {voiceBusy === "consent" ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          )}
                          Grant consent
                        </button>
                      </>
                    )}

                    <div className="mt-3 pt-3 border-t border-[#222834]">
                      <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                        Master switch
                      </p>
                      <label className="inline-flex items-center gap-2 text-sm text-[#F3F4F6] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!voiceSettings.voiceDisabled}
                          onChange={(event) =>
                            void runVoice("master", async () => {
                              await setSentinelVoiceDisabled(!event.target.checked);
                              setFlash(
                                event.target.checked
                                  ? "Voice calls enabled for your account."
                                  : "Voice calls switched off. Alerts keep tracking prices.",
                              );
                            })
                          }
                          className="accent-[#FF5A1F]"
                        />
                        Call me when alerts trigger
                      </label>
                      <p className="mt-1 text-[11px] text-[#9CA3AF]">
                        Switching calls off never deletes an alert — it only stops the phone from ringing.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Quiet hours */}
                <div className="mt-4 rounded-lg border border-[#222834] bg-[#0F131A] p-3">
                  <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-2">
                    Quiet hours (UTC)
                  </p>
                  <p className="text-[11px] text-[#9CA3AF] mb-2">
                    A trigger inside the window waits until it ends. Both bounds are required to set a window;
                    clear both to remove it.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="time"
                      value={quietStart}
                      onChange={(event) => setQuietStart(event.target.value)}
                      aria-label="Quiet hours start (UTC)"
                      className={FIELD_CLASS}
                    />
                    <span className="text-[11px] text-[#6B7280]">to</span>
                    <input
                      type="time"
                      value={quietEnd}
                      onChange={(event) => setQuietEnd(event.target.value)}
                      aria-label="Quiet hours end (UTC)"
                      className={FIELD_CLASS}
                    />
                    <button
                      onClick={() =>
                        void runVoice("quiet", async () => {
                          const start = hhMmToMinutes(quietStart);
                          const end = hhMmToMinutes(quietEnd);
                          await setSentinelQuietHours({
                            quietHoursStartUtc: start,
                            quietHoursEndUtc: end,
                          });
                          setFlash(
                            start !== null && end !== null
                              ? `Quiet hours set: ${quietStart}–${quietEnd} UTC.`
                              : "Quiet hours cleared.",
                          );
                        })
                      }
                      disabled={voiceBusy !== null}
                      className={BUTTON_NEUTRAL}
                    >
                      {voiceBusy === "quiet" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Clock className="w-3.5 h-3.5" />
                      )}
                      Save quiet hours
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ---- Call history ------------------------------------------ */}
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
                <Phone className="w-4 h-4 text-[#6B7280]" />
                Call history
              </h2>
              {calls.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] py-6 text-center">
                  No calls yet. They appear here once an alert triggers and a call is attempted.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-[#6B7280]">
                        <th className="py-2 pr-3">Alert</th>
                        <th className="py-2 pr-3">Target</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Attempts</th>
                        <th className="py-2">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map((item) => {
                        const callMeta = CALL_STATUS_META[item.call.status] ?? {
                          label: item.call.status,
                          className: "border-[#262E3B] bg-[#14181F] text-[#9CA3AF]",
                        };
                        return (
                          <tr key={item.call.callId} className="border-t border-[#1B2028] text-[#F3F4F6]">
                            <td className="py-2 pr-3">
                              <span className="text-white">{item.displayName}</span>{" "}
                              <span className="text-[#6B7280] font-mono">{item.symbol}</span>
                            </td>
                            <td className="py-2 pr-3 font-mono">
                              {conditionGlyph(item.condition)} {item.targetPrice} {item.quoteCurrency}
                            </td>
                            <td className="py-2 pr-3">
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${callMeta.className}`}
                              >
                                {callMeta.label}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              {item.call.attempts}/{item.call.maxAttempts}
                            </td>
                            <td className="py-2 text-[#9CA3AF]">
                              {item.call.failReason ? (
                                <span className="text-[#EF4444]">{item.call.failReason}</span>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-[11px] text-[#6B7280]">
                A completed status is written only from a verified provider webhook — Sentinel never assumes a
                call connected.
              </p>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
