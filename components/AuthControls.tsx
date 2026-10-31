"use client";

import { LogIn, LogOut } from "lucide-react";
import Link from "next/link";
import { signOut } from "next-auth/react";

import { clearApiToken } from "@/lib/auth-actions";

/**
 * MODULE 02 — the sign-in and sign-out controls.
 *
 * A client component because sign-out has to run on the client: a Server Action
 * clears the cookies but the mounted SessionProvider keeps serving the previous
 * session, so the header would only update after a reload. Sign-in no longer
 * happens here: one "Login / Sign Up" button routes to the dedicated login page
 * (`/login`), where the role intent and the provider choice are made together.
 * That keeps Google/GitHub buttons off the landing page while the OAuth
 * exchange itself still runs through the Server Action (see `lib/auth-actions`),
 * so the provider list remains a closed set chosen on the server.
 */
interface AuthControlsProps {
  /** Present when a session exists. Absent otherwise. */
  email: string | null;
  provider: string | null;
}

export default function AuthControls({ email, provider }: AuthControlsProps) {
  if (email) {
    return (
      <div className="flex items-center gap-3 pl-3 border-l border-[#222834]">
        <div className="flex flex-col items-end leading-tight">
          <span title={email} className="font-mono text-[11px] text-white max-w-[220px] truncate">{email}</span>
          <span className="text-[10px] uppercase tracking-wider text-[#6B7280]">{provider}</span>
        </div>
        <button
          type="button"
          onClick={async () => {
            await clearApiToken();
            await signOut({ redirectTo: "/" });
          }}
          className="flex items-center gap-1.5 rounded-lg border border-[#222834] bg-[#14181F] px-2.5 py-1.5 text-xs text-[#9CA3AF] transition-colors hover:border-[#FF5A1F] hover:text-white"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign out</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center pl-3 border-l border-[#222834]">
      <Link
        href="/login"
        className="flex items-center gap-1.5 rounded-lg bg-[#14181F] px-2.5 py-1.5 text-xs text-[#D1D5DB] transition-colors hover:bg-[#1B2028] hover:text-white"
      >
        <LogIn className="w-3.5 h-3.5" />
        <span>Login / Sign Up</span>
      </Link>
    </div>
  );
}