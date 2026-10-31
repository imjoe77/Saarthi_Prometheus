"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

/**
 * MODULE 02 — makes the Auth.js session available to client components.
 *
 * A client wrapper because `SessionProvider` is one. Mounting it in the root
 * layout means `useSession()` works in any component without each page opting in,
 * and it fetches `/api/auth/session` once per load rather than per component.
 *
 * What it puts in the browser: the email, the display name, the provider and the
 * provider identity. All of it came back from an OAuth provider the user chose.
 * The access token is not here and never will be.
 */
export default function AuthSessionProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}