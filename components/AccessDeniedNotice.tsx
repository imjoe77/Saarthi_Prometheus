"use client";

import React, { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

import {
  ACCESS_DENIED_REASON_STORAGE_KEY,
  ACCESS_DENIED_STORAGE_KEY,
} from "@/lib/login-flow";

/**
 * MODULE 13 — the refusal notice shown after a denied elevated sign-in.
 *
 * `/login/continue` answers an unauthorized Expert Trader, Liquidity
 * Provider or Platform Admin claim by ending the session and sending the
 * visitor back here with a `sessionStorage` flag naming the refused role —
 * deliberately never the visitor's email, which has been signed out by the
 * time this renders. When the backend supplied a specific reason (the
 * one-privileged-role rule's "try a different account for X"), that reason
 * rides in a second key and replaces the generic wording; both values are
 * consumed on first render: the notice is one-shot, and a later refresh
 * shows a clean dashboard.
 *
 * The deferred read keeps the sessionStorage access inside a timer callback,
 * matching the repository's effect conventions.
 */
export default function AccessDeniedNotice() {
  const [notice, setNotice] = useState<{ role: string; reason: string | null } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const role = window.sessionStorage.getItem(ACCESS_DENIED_STORAGE_KEY);
      const reason = window.sessionStorage.getItem(ACCESS_DENIED_REASON_STORAGE_KEY);
      window.sessionStorage.removeItem(ACCESS_DENIED_STORAGE_KEY);
      window.sessionStorage.removeItem(ACCESS_DENIED_REASON_STORAGE_KEY);
      setNotice(role ? { role, reason } : null);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  if (!notice) {
    return null;
  }

  // Owns its own overlay: the refusal lands on the marketing page, where an
  // inline card would sit on top of the hero headline. The scrim dims the page
  // behind it so the message is the only thing to read, and it is dismissed
  // with the session — one render, then nothing.
  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center bg-black/70 px-4 pt-24">
      <div className="flex w-full max-w-xl items-start gap-3 rounded-xl border border-[#EF4444]/40 bg-[#12161D] p-4 shadow-2xl shadow-black/60">
        <ShieldAlert className="w-5 h-5 shrink-0 text-[#EF4444]" />
        <div>
          <p className="text-sm font-bold text-white">Access denied</p>
          {notice.reason ? (
            <p className="mt-1 text-sm text-[#F3F4F6]">
              {notice.reason} The session was ended before this page was shown.
            </p>
          ) : (
            <p className="mt-1 text-sm text-[#F3F4F6]">
              Not authorised: this account is not approved to continue as{" "}
              <span className="font-semibold text-white">{notice.role}</span>. The session was
              ended before this page was shown.
            </p>
          )}
          <p className="mt-2 text-xs text-[#9CA3AF]">
            You can still sign in again and continue as a Normal User. Expert Trader, Liquidity
            Provider and Platform Admin access is limited to approved email addresses.
          </p>
        </div>
      </div>
    </div>
  );
}
