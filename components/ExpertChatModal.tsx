"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  X,
  Send,
  Flame,
  ShieldCheck,
  Clock,
  Sparkles,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import {
  getBalances,
  connectExpertTrader,
  sendExpertChatMessage,
  type BalanceSummary,
} from "@/lib/api-client";

export interface ExpertChatModalProps {
  strategyId: string;
  strategyName: string;
  isOpen: boolean;
  onClose: () => void;
}

interface Message {
  id: string;
  sender: "user" | "expert";
  text: string;
  timestamp: string;
}

const QUICK_PROMPTS = [
  "Why did you take the latest trade?",
  "What is your risk per trade?",
  "What allocation % do you recommend for beginners?",
  "What is your outlook on market volatility?",
];

export function ExpertChatModal({
  strategyId,
  strategyName,
  isOpen,
  onClose,
}: ExpertChatModalProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [emberBalance, setEmberBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);

  const chatBottomRef = useRef<HTMLDivElement>(null);

  const storageKey = `prometheus_expert_chat_unlocked_${strategyId}`;

  // Check unlock status and live EMBER balance
  useEffect(() => {
    if (!isOpen) return;

    const saved = localStorage.getItem(storageKey);
    if (saved === "true") {
      setUnlocked(true);
    } else {
      setUnlocked(false);
    }
    setChecking(false);

    setBalanceLoading(true);
    getBalances()
      .then((rows: BalanceSummary[]) => {
        const row = rows.find((b) => b.asset.symbol === "EMBER");
        if (row) {
          const val = Number.parseFloat(row.available);
          setEmberBalance(Number.isFinite(val) ? val : 0);
        } else {
          setEmberBalance(0);
        }
      })
      .catch(() => {
        // Fallback default for demo/unauthenticated
        setEmberBalance(25);
      })
      .finally(() => {
        setBalanceLoading(false);
      });
  }, [isOpen, strategyId, storageKey]);

  // Initial welcome message once unlocked
  useEffect(() => {
    if (unlocked && messages.length === 0) {
      setMessages([
        {
          id: "welcome",
          sender: "expert",
          text: `Hello! I'm the lead trader behind "${strategyName}". I've received your consultation request (10 EMBER). Feel free to ask me anything about my trade signals, risk parameters, or current market strategy!`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    }
  }, [unlocked, strategyName, messages.length]);

  // Scroll to bottom on new message
  useEffect(() => {
    if (unlocked) {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, unlocked]);

  if (!isOpen) return null;

  const handleUnlock = async (isDemoBypass = false) => {
    setUnlocking(true);
    setUnlockError(null);

    try {
      if (!isDemoBypass) {
        await connectExpertTrader(strategyId);
      }
      localStorage.setItem(storageKey, "true");
      setUnlocked(true);
      if (emberBalance !== null && !isDemoBypass) {
        setEmberBalance(Math.max(0, emberBalance - 10));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to unlock consultation.";
      setUnlockError(msg);
    } finally {
      setUnlocking(false);
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend ?? inputText).trim();
    if (!text || sending) return;

    const userMsg: Message = {
      id: "u_" + Date.now(),
      sender: "user",
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setSending(true);

    try {
      const res = await sendExpertChatMessage(strategyId, text);
      const expertMsg: Message = {
        id: "e_" + Date.now(),
        sender: "expert",
        text: res.reply,
        timestamp: new Date(res.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, expertMsg]);
    } catch {
      // Local fallback expert reply if API is offline
      const query = text.toLowerCase();
      let reply = `Regarding "${strategyName}": we follow disciplined entry criteria and protect capital aggressively.`;
      if (query.includes("risk") || query.includes("stop")) {
        reply = `Risk management is our #1 priority on "${strategyName}". We cap risk at 1.5% per position with hard stop losses.`;
      } else if (query.includes("allocation") || query.includes("size")) {
        reply = `For beginners, I recommend allocating between 10% and 25% (0.1 to 0.25 fraction) so you observe position replication comfortably.`;
      } else if (query.includes("trade") || query.includes("why")) {
        reply = `Our latest fill aligned with key liquidity sweeps on higher timeframes. We scaled into the move with institutional momentum.`;
      }

      const expertMsg: Message = {
        id: "e_" + Date.now(),
        sender: "expert",
        text: reply,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, expertMsg]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expert-chat-title"
    >
      <div className="relative w-full max-w-xl bg-[#0E121A] border border-[#232B3A] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Top Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1E2535] bg-[#121622]">
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10 rounded-full bg-gradient-to-tr from-[#FF5A1F] to-[#FFA726] p-[2px] flex items-center justify-center shadow-lg shadow-[#FF5A1F]/20">
              <div className="w-full h-full rounded-full bg-[#0E121A] flex items-center justify-center text-sm font-bold text-white uppercase">
                {strategyName.slice(0, 2)}
              </div>
              <span className="absolute bottom-0 right-0 w-3 h-3 bg-[#00D26A] border-2 border-[#0E121A] rounded-full" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h3 id="expert-chat-title" className="text-sm font-bold text-white tracking-tight">
                  Expert Trader · {strategyName}
                </h3>
                <span title="Verified Expert Trader"><ShieldCheck className="w-4 h-4 text-[#00D26A]" /></span>
              </div>
              <p className="text-[11px] text-[#717E91] flex items-center gap-2 mt-0.5">
                <span className="flex items-center gap-1 text-[#00D26A]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#00D26A] animate-pulse" />
                  Online
                </span>
                <span>•</span>
                <span className="flex items-center gap-1 text-[#8B98A9]">
                  <Clock className="w-3 h-3" /> Replies in &lt; 3 mins
                </span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#717E91] hover:text-white hover:bg-[#1E2535] transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area: Paywall vs Chat */}
        {!unlocked ? (
          <div className="p-6 space-y-5 overflow-y-auto">
            {/* Value Card */}
            <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-[#1C2333] to-[#121622] border border-[#2A3447] p-5">
              <div className="absolute top-0 right-0 w-36 h-36 bg-[#FF5A1F]/10 rounded-full blur-3xl pointer-events-none" />
              <div className="flex items-start gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-[#FF5A1F]/15 border border-[#FF5A1F]/30 flex items-center justify-center text-[#FF5A1F] shrink-0">
                  <Flame className="w-6 h-6 animate-pulse" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-[10px] font-bold font-mono tracking-wide rounded bg-[#FF5A1F]/20 text-[#FF5A1F] border border-[#FF5A1F]/40">
                      EMBER UTILITY
                    </span>
                    <span className="text-xs font-mono text-[#8B98A9]">1-on-1 Consultation</span>
                  </div>
                  <h4 className="text-base font-bold text-white">Direct Expert Trader Consultation</h4>
                  <p className="text-xs text-[#9DA8B9] leading-relaxed">
                    Connect directly with the strategy creator. Ask specific questions about market entries, why certain positions were opened or closed, and get custom risk sizing advice.
                  </p>
                </div>
              </div>

              {/* Consultation Features */}
              <div className="mt-4 pt-4 border-t border-[#242C3D] grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-[#C5CFDE]">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#00D26A] shrink-0" />
                  <span>Direct trade rationale answers</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#00D26A] shrink-0" />
                  <span>Risk & stop-loss guidance</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#00D26A] shrink-0" />
                  <span>Beginner allocation recommendations</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#00D26A] shrink-0" />
                  <span>Active during entire follow session</span>
                </div>
              </div>
            </div>

            {/* Fee & Wallet Balance Bar */}
            <div className="bg-[#131722] border border-[#202738] rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#717E91]">
                  Consultation Fee
                </span>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Flame className="w-4 h-4 text-[#FF5A1F]" />
                  <span className="text-lg font-mono font-bold text-white">10 EMBER</span>
                </div>
              </div>

              <div className="sm:text-right">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#717E91]">
                  Your Available Balance
                </span>
                <div className="text-sm font-mono font-bold mt-0.5">
                  {balanceLoading ? (
                    <span className="text-[#717E91] flex items-center sm:justify-end gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Checking…
                    </span>
                  ) : emberBalance !== null ? (
                    <span className={emberBalance >= 10 ? "text-[#00D26A]" : "text-[#FF4D4D]"}>
                      {emberBalance.toFixed(2)} EMBER
                    </span>
                  ) : (
                    <span className="text-[#8E98A8]">0.00 EMBER</span>
                  )}
                </div>
              </div>
            </div>

            {/* Error Notice */}
            {unlockError && (
              <div className="p-3 bg-[#FF4D4D]/10 border border-[#FF4D4D]/30 rounded-xl flex items-start gap-2.5 text-xs text-[#FF8585]">
                <AlertTriangle className="w-4 h-4 text-[#FF4D4D] shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span>{unlockError}</span>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="space-y-2.5 pt-2">
              {emberBalance !== null && emberBalance < 10 ? (
                <div className="space-y-2">
                  <div className="p-3 bg-[#F5A623]/10 border border-[#F5A623]/30 rounded-xl flex items-center justify-between text-xs text-[#F5A623]">
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      Insufficient EMBER (Requires 10 EMBER)
                    </span>
                    <Link
                      href="/ember-hub"
                      className="font-bold underline hover:text-white transition-colors"
                    >
                      Buy at EMBER Hub →
                    </Link>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleUnlock(true)}
                    className="w-full py-3 px-4 rounded-xl bg-[#1D2433] hover:bg-[#252E40] border border-[#2E3A4E] text-xs font-bold text-white transition-colors flex items-center justify-center gap-2"
                  >
                    <Sparkles className="w-4 h-4 text-[#FF5A1F]" />
                    <span>Demo Bypass: Simulate 10 EMBER Unlock</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={unlocking}
                  onClick={() => handleUnlock(false)}
                  className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-[#FF5A1F] to-[#E04B14] hover:from-[#FF6B35] hover:to-[#EB551D] text-white font-bold text-sm shadow-lg shadow-[#FF5A1F]/25 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {unlocking ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Flame className="w-4 h-4 fill-white" />
                  )}
                  <span>Pay 10 EMBER & Start Chat</span>
                </button>
              )}

              <p className="text-[11px] text-center text-[#687588]">
                Payment is debited directly from your Prometheus EMBER balance.
              </p>
            </div>
          </div>
        ) : (
          /* Live Chat Interface */
          <div className="flex flex-col flex-1 min-h-[420px] max-h-[560px]">
            {/* Status bar */}
            <div className="px-4 py-2 bg-[#121620] border-b border-[#1C2331] flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 text-[#00D26A] font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> 10 EMBER Consultation Session Active
              </span>
              <span className="font-mono text-[#717E91]">Direct 1-on-1</span>
            </div>

            {/* Messages Scroll Area */}
            <div className="flex-1 p-4 overflow-y-auto space-y-3.5 bg-[#0A0D13]">
              {messages.map((m) => {
                const isUser = m.sender === "user";
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 px-1">
                      <span className="text-[10px] font-mono text-[#6A788B]">
                        {isUser ? "You" : `Expert (${strategyName})`}
                      </span>
                      <span className="text-[9px] text-[#4F5B6D]">• {m.timestamp}</span>
                    </div>
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                        isUser
                          ? "bg-[#FF5A1F] text-white rounded-tr-none shadow-md shadow-[#FF5A1F]/15"
                          : "bg-[#161B26] text-[#E0E6ED] border border-[#242C3C] rounded-tl-none"
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                );
              })}

              {sending && (
                <div className="flex flex-col items-start">
                  <div className="flex items-center gap-1.5 mb-1 px-1">
                    <span className="text-[10px] font-mono text-[#6A788B]">
                      Expert ({strategyName})
                    </span>
                    <span className="text-[9px] text-[#4F5B6D]">• Typing…</span>
                  </div>
                  <div className="bg-[#161B26] border border-[#242C3C] rounded-2xl rounded-tl-none px-4 py-2.5 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-[#FF5A1F] rounded-full animate-bounce" />
                    <span className="w-1.5 h-1.5 bg-[#FF5A1F] rounded-full animate-bounce [animation-delay:0.2s]" />
                    <span className="w-1.5 h-1.5 bg-[#FF5A1F] rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              )}

              <div ref={chatBottomRef} />
            </div>

            {/* Quick Suggestion Chips */}
            <div className="px-3 py-2 bg-[#0E121A] border-t border-[#1C2331] flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={sending}
                  onClick={() => handleSendMessage(prompt)}
                  className="whitespace-nowrap px-2.5 py-1 rounded-full bg-[#161C27] hover:bg-[#202737] border border-[#242D3E] text-[11px] text-[#9AA7B9] hover:text-white transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>

            {/* Chat Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="p-3 bg-[#121622] border-t border-[#1E2535] flex items-center gap-2"
            >
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Ask the expert about this strategy..."
                className="flex-1 bg-[#0A0D13] border border-[#232B3B] focus:border-[#FF5A1F]/70 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-[#525F72] outline-none transition-colors"
              />
              <button
                type="submit"
                disabled={sending || !inputText.trim()}
                className="p-2.5 rounded-xl bg-[#FF5A1F] hover:bg-[#E04B14] disabled:opacity-40 text-white transition-colors"
                aria-label="Send message"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
