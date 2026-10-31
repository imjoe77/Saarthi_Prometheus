"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  BellOff,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneOff,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import { useRoles } from "@/components/RoleProvider";
import {
  ApiError,
  getSentinelLiveCall,
  settleSentinelLiveCall,
  type SentinelLiveCall,
} from "@/lib/api-client";
import { startRingtone, type RingtoneHandle } from "@/lib/sentinel-ringtone";
import { isPlaybackFailure, speakAlert, type SpeechSynthesisLike, type SpeechUtteranceLike } from "@/lib/sentinel-speech";

/**
 * MODULE 14 — the in-app SIMULATED call: an incoming phone, in the app.
 *
 * WHAT THIS IS. When a Sentinel alert triggers under the `fake` voice provider,
 * the backend dials nobody — but the call row reaches `INITIATED`, i.e. "the
 * line is ringing". This component is the phone that rings: it polls the
 * owner's ringing call and, wherever the user is in the app, paints a
 * caller-ID card answering/declining it, then speaks the backend's own
 * `spokenText` through the browser.
 *
 * WHAT IT DELIBERATELY IS NOT.
 *  - It is not a telephone. Every surface is labelled SIMULATED, and it only
 *    exists under the `fake` provider; a real Twilio call rings on the PSTN
 *    and never reaches this component.
 *  - It does not work when the app is closed — there is no background service,
 *    no push, and no OS call. The card says so rather than implying otherwise.
 *  - It cannot trade. There is no trade path anywhere in this file; declining
 *    or hanging up only writes the call row's outcome.
 *
 * OUTCOMES GO THROUGH THE SERVER, NOT LOCAL OPTIMISM. Answer/Decline/End each
 * POST to the backend and only the server's answer is displayed: if the POST
 * fails the ring stays up and an error shows, so the UI never claims a call
 * was answered when the record disagrees. Polling is quiet but stops on
 * 401/403 rather than hammering an expired session.
 *
 * AUDIO IS A BEST-EFFORT LAYER OVER ALWAYS-READABLE TEXT. The message the
 * backend composed is rendered verbatim regardless of whether sound started;
 * if synthesis is missing, blocked before a gesture, or errors mid-speech, the
 * card says the message could not be played aloud and offers Replay (a user
 * gesture, which is exactly what unblocks audio policy).
 */

type Phase = "ringing" | "active" | "settled";

/** How often to poll for a ringing call. A ring is time-sensitive; 2.5s is a
 *  responsive cadence for a card the user should see within a second of the
 *  monitor's dial, and the query itself is one indexed row read. */
const POLL_INTERVAL_MS = 2500;

const ACTION_BUTTON =
  "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50";

export default function SentinelCallOverlay() {
  const { status: sessionStatus } = useSession();
  const { hasRole, loading: rolesLoading } = useRoles();

  const [live, setLive] = useState<SentinelLiveCall | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [settledNote, setSettledNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Audio state: whether the last speak attempt actually started, and whether
  // the user has muted the spoken feed.
  const [audioFailed, setAudioFailed] = useState(false);
  const [muted, setMuted] = useState(false);
  // Silencing the RING is separate from muting the spoken message: a real
  // phone lets you hush an incoming call without declining it. Sticky per
  // ring — reset only when a new call is adopted.
  const [ringSilenced, setRingSilenced] = useState(false);

  const synthesisRef = useRef<SpeechSynthesisLike | undefined>(undefined);
  const ringtoneRef = useRef<RingtoneHandle | undefined>(undefined);
  // The call id the ringing UI was last reset for, so a per-call reset
  // (mute/silence) happens on adoption of a NEW call only — not on every
  // poll of the same one, which would un-silence the moment after the user
  // tapped Silence.
  const adoptedCallIdRef = useRef<string | undefined>(undefined);

  // Eligible roles only: an LP or an admin has no consumer alerting surface,
  // so we never poll for them. Session-gated too — signed out means no calls.
  const eligible =
    sessionStatus === "authenticated" &&
    !rolesLoading &&
    hasRole("USER", "EXPERT_TRADER");

  const stopSpeech = useCallback(() => {
    const synthesis = synthesisRef.current;
    if (synthesis === undefined) return;
    try {
      synthesis.cancel();
    } catch {
      // A cancel that throws leaves the utterance to end on its own; there is
      // nothing to recover because no state depends on it.
    }
  }, []);

  /**
   * Speaks the backend's composed text; falls back to readable text honestly.
   *
   * No mute check lives here on purpose: every caller (Answer, Unmute, Replay)
   * has already decided the user wants sound right now, so a guard inside
   * would only restate its own precondition.
   */
  const speak = useCallback((text: string) => {
    const synthesis =
      synthesisRef.current ??
      (typeof window !== "undefined" ? (window.speechSynthesis as SpeechSynthesisLike | undefined) : undefined);
    synthesisRef.current = synthesis;

    const outcome = speakAlert(text, {
      synthesis,
      createUtterance: (value: string): SpeechUtteranceLike => {
        const utterance = new SpeechSynthesisUtterance(value) as SpeechUtteranceLike;
        utterance.onerror = (event: unknown) => {
          const code = (event as { error?: string } | null)?.error;
          // A cancel we caused ourselves (replay/end) is not a playback
          // failure; anything else means the user may not have heard it.
          if (isPlaybackFailure(code)) setAudioFailed(true);
        };
        return utterance;
      },
    });

    setAudioFailed(outcome === "UNAVAILABLE");
  }, []);

  // ---- Poll for a ringing call -----------------------------------------
  useEffect(() => {
    if (!eligible) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = async (): Promise<void> => {
      try {
        const call = await getSentinelLiveCall();
        if (cancelled || stopped) return;

        if (phase === "active" || phase === "settled") {
          // A call in hand is never replaced: the server answers null here
          // anyway (a settled row is not ringable), and if a *second* alert
          // rings while this one plays, that ring stays live server-side and
          // is adopted by the next poll once this call ends. Replacing now
          // would point the End button at the wrong call.
        } else if (call !== null && call.ringing) {
          const isNewCall = adoptedCallIdRef.current !== call.callId;
          adoptedCallIdRef.current = call.callId;
          setLive(call);
          setPhase("ringing");
          if (isNewCall) {
            // Per-call affordances reset only when a NEW ring is adopted:
            // re-polling the same call must not undo a Silence or a Mute.
            setAudioFailed(false);
            setMuted(false);
            setRingSilenced(false);
            setError(null);
          }
        } else if (phase === "ringing") {
          // We were showing a ring and the server no longer has one: it was
          // settled elsewhere, or the row moved on. Drop the stale card rather
          // than leave an Answer button that would now 404/return a dead row.
          adoptedCallIdRef.current = undefined;
          setLive(null);
          setPhase(null);
        }
        // phase === null with nothing ringing: stay idle, no state writes.
      } catch (cause) {
        if (cancelled || stopped) return;
        // A gone session must stop the poll, not spam the user with errors.
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
          stopped = true;
          return;
        }
        // Transient poll failures are dropped: the overlay is an opportunistic
        // notification, and surfacing every blip would cry wolf.
      } finally {
        if (!cancelled && !stopped) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `phase` is a dependency on purpose: each transition restarts the loop so
    // the next poll observes the phase it belongs to instead of a stale one.
  }, [eligible, phase]);

  // ---- The audible ring --------------------------------------------------
  // Rings exactly while this card is in its incoming phase and the user has
  // not silenced it. Every exit — answer, decline, silence, unmount — runs
  // the returned cleanup, which stops the tone, the pending cycle and any
  // vibration, so no ringtone outlives the ring it belongs to.
  const ringing = phase === "ringing" && live !== null && !ringSilenced;
  useEffect(() => {
    if (!ringing) return;
    const ringtone = startRingtone({});
    ringtoneRef.current = ringtone;
    return () => {
      ringtone.stop();
      if (ringtoneRef.current === ringtone) ringtoneRef.current = undefined;
    };
  }, [ringing]);

  // Unmount / leave: never leave the browser talking.
  useEffect(() => {
    return () => {
      const synthesis =
        typeof window !== "undefined" ? (window.speechSynthesis as SpeechSynthesisLike | undefined) : undefined;
      try {
        synthesis?.cancel();
      } catch {
        // Best effort; the page is going away anyway.
      }
    };
  }, []);

  // ---- The three decisions ---------------------------------------------
  const answer = async (): Promise<void> => {
    if (live === null) return;
    setBusy(true);
    setError(null);
    // A real phone stops ringing the moment you pick up — not when the
    // network agrees. Silence first, then record.
    ringtoneRef.current?.stop();
    try {
      // Record the outcome FIRST, so the local UI only claims "answered"
      // after the server agrees. The response is the authoritative row.
      const settled = await settleSentinelLiveCall(live.callId, "ANSWERED");
      setLive(settled);
      setPhase("active");
      speak(settled.spokenText || live.spokenText);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `The answer could not be recorded: ${cause.message}`
          : "The answer could not be recorded. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const decline = async (): Promise<void> => {
    if (live === null) return;
    setBusy(true);
    setError(null);
    // Same instant-silence rule as Answer: declining hushes the ring now.
    ringtoneRef.current?.stop();
    stopSpeech();
    try {
      const settled = await settleSentinelLiveCall(live.callId, "DECLINED");
      setLive(settled);
      setPhase("settled");
      setSettledNote(
        settled.ringing
          ? "Declined. Sentinel may ring again if its retry budget allows."
          : "Declined. The alert keeps its history — no trade was placed.",
      );
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `The decline could not be recorded: ${cause.message}`
          : "The decline could not be recorded. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const endCall = async (): Promise<void> => {
    if (live === null) return;
    setBusy(true);
    setError(null);
    stopSpeech();
    try {
      const settled = await settleSentinelLiveCall(live.callId, "ENDED");
      setLive(settled);
      setPhase("settled");
      setSettledNote("Call ended. The alert is settled in your history — no trade was placed.");
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `The call end could not be recorded: ${cause.message}`
          : "The call end could not be recorded. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  // Both handlers read ordinary state: they are re-created every render, so
  // the values they close over are current — no ref mirror needed.
  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);

    if (next) {
      // Muting stops the feed now.
      try {
        synthesisRef.current?.cancel();
      } catch {
        // Mute is a convenience; no state depends on the cancel's result.
      }
      return;
    }

    // Unmuting restarts the message from the top rather than mid-word:
    // replaying is predictable, resuming a half-eaten sentence is not.
    if (phase === "active" && live !== null && live.spokenText !== "") {
      speak(live.spokenText);
    }
  };

  const replay = (): void => {
    if (live === null) return;
    setMuted(false);
    stopSpeech();
    // A deliberate gesture — the thing autoplay policies require.
    speak(live.spokenText);
  };

  // Clear a settled note after a beat so the overlay does not linger forever.
  useEffect(() => {
    if (phase !== "settled") return;
    const timer = setTimeout(() => {
      setPhase(null);
      setLive(null);
      setSettledNote(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!eligible) return null;

  if (phase === "settled" && settledNote !== null) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:inset-0 sm:flex sm:items-center sm:justify-center sm:p-0 pointer-events-none">
        <div className="pointer-events-auto w-full sm:w-[440px] rounded-t-2xl sm:rounded-2xl border border-[#262E3B] bg-[#12161D] p-4 shadow-2xl shadow-black/60">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-[#6B7280]">
            <ShieldCheck className="w-3.5 h-3.5 text-[#00D26A]" />
            Simulated in-app call · not a telephone call
          </div>
          <p className="mt-2 text-sm text-[#F3F4F6]">{settledNote}</p>
        </div>
      </div>
    );
  }

  if (phase === "ringing" && live !== null) {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center sm:p-0">
        <div className="w-full sm:w-[440px] rounded-t-2xl sm:rounded-2xl border border-[#FF5A1F]/40 bg-[#12161D] p-5 shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FF5A1F]/40 bg-[#FF5A1F]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#FF5A1F]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#FF5A1F] animate-pulse" />
              Incoming · simulated
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-[#6B7280]">in-app only</span>
              <button
                type="button"
                onClick={() => {
                  // Hush the ring without deciding the call — the same
                  // affordance a physical phone's volume key offers. The
                  // ringtone effect's `ringing` dep tears the audio down.
                  ringtoneRef.current?.stop();
                  setRingSilenced(true);
                }}
                disabled={ringSilenced}
                aria-label={ringSilenced ? "Ring silenced" : "Silence the ring"}
                className="inline-flex items-center gap-1 rounded-md border border-[#222834] bg-[#14181F] px-2 py-1 text-[10px] font-medium text-[#9CA3AF] transition-colors hover:text-white hover:border-[#39424F] disabled:opacity-60"
              >
                <BellOff className="w-3 h-3" />
                {ringSilenced ? "Silenced" : "Silence"}
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#FF5A1F]/15 border border-[#FF5A1F]/40">
              <PhoneCall className="w-6 h-6 text-[#FF5A1F]" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-bold text-white leading-tight">Prometheus Sentinel</p>
              <p className="text-xs text-[#9CA3AF] truncate">
                {live.alert.displayName} · {live.alert.symbol}
              </p>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-[#222834] bg-[#14181F] p-2.5">
              <dt className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Target</dt>
              <dd className="mt-0.5 font-mono font-semibold text-white">
                {live.alert.condition === "GREATER_THAN_OR_EQUAL" ? "≥" : "≤"} {live.alert.targetPrice}{" "}
                {live.alert.quoteCurrency}
              </dd>
            </div>
            <div className="rounded-lg border border-[#222834] bg-[#14181F] p-2.5">
              <dt className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Observed</dt>
              <dd className="mt-0.5 font-mono font-semibold text-white">
                {live.alert.observedPrice !== null ? (
                  <>
                    {live.alert.observedPrice} {live.alert.quoteCurrency}
                  </>
                ) : (
                  <span className="text-[#6B7280]">not observed</span>
                )}
              </dd>
            </div>
            <div className="col-span-2 rounded-lg border border-[#222834] bg-[#14181F] p-2.5">
              <dt className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold">Condition</dt>
              <dd className="mt-0.5 text-[#F3F4F6]">
                Price {live.alert.condition === "GREATER_THAN_OR_EQUAL" ? "at or above" : "at or below"} the
                target — alert only, no trade will be placed.
              </dd>
            </div>
          </dl>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void answer()}
              disabled={busy}
              className={`${ACTION_BUTTON} bg-[#00D26A] hover:bg-[#00B85C] text-[#04140B]`}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
              Answer
            </button>
            <button
              type="button"
              onClick={() => void decline()}
              disabled={busy}
              className={`${ACTION_BUTTON} border border-[#EF4444]/50 bg-[#EF4444]/10 text-[#EF4444] hover:bg-[#EF4444]/20`}
            >
              <PhoneOff className="w-4 h-4" />
              Decline
            </button>
          </div>

          {error && (
            <p className="mt-3 text-xs text-[#EF4444]">
              <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
              {error}
            </p>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-[#6B7280]">
            Simulated in-app call — it rings only while Prometheus is open in this browser, and it is never a
            telephone call. Nothing here places a trade.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "active" && live !== null) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:inset-0 sm:flex sm:items-center sm:justify-center sm:p-0 pointer-events-none">
        <div className="pointer-events-auto w-full sm:w-[480px] rounded-t-2xl sm:rounded-2xl border border-[#262E3B] bg-[#12161D] p-4 shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00D26A]/40 bg-[#00D26A]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00D26A]">
              <Phone className="w-3 h-3" />
              On call · simulated
            </span>
            <span className="text-[10px] text-[#6B7280]">
              {live.attempts}/{live.maxAttempts} attempt
              {live.attempts === 1 ? "" : "s"}
            </span>
          </div>

          <p className="mt-3 text-sm font-semibold text-white">
            Prometheus Sentinel — {live.alert.displayName} ({live.alert.symbol})
          </p>

          {/* The message is always readable: audio is a bonus, never the only
              channel. This is verbatim what the monitor composed. */}
          <div className="mt-2 rounded-lg border border-[#222834] bg-[#14181F] p-3">
            <p className="text-[10px] uppercase tracking-wider text-[#6B7280] font-bold mb-1">
              {audioFailed ? "Message (audio unavailable)" : "Message"}
            </p>
            <p className="text-sm leading-relaxed text-[#F3F4F6]">{live.spokenText}</p>
            {audioFailed && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[#F59E0B]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                The message could not be played aloud. Press Replay to try again — your browser may only allow
                sound after a click.
              </p>
            )}
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={toggleMute}
              className={`${ACTION_BUTTON} border border-[#222834] bg-[#14181F] text-[#9CA3AF] hover:text-white hover:border-[#39424F]`}
              aria-pressed={muted}
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              onClick={replay}
              className={`${ACTION_BUTTON} border border-[#222834] bg-[#14181F] text-[#9CA3AF] hover:text-white hover:border-[#39424F]`}
            >
              <RotateCcw className="w-4 h-4" />
              Replay
            </button>
            <button
              type="button"
              onClick={() => void endCall()}
              disabled={busy}
              className={`${ACTION_BUTTON} border border-[#EF4444]/50 bg-[#EF4444]/10 text-[#EF4444] hover:bg-[#EF4444]/20`}
            >
              <PhoneOff className="w-4 h-4" />
              End
            </button>
          </div>

          {error && (
            <p className="mt-3 text-xs text-[#EF4444]">
              <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
              {error}
            </p>
          )}

          <p className="mt-3 text-[11px] text-[#6B7280]">
            Simulated in-app call, not a telephone call. Ending it records the outcome in your call history and
            never places a trade.
          </p>
        </div>
      </div>
    );
  }

  return null;
}
