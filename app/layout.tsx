import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";

import AuthSessionProvider from "@/components/AuthSessionProvider";
import { OnboardingGate } from "@/components/OnboardingGate";
import { RoleProvider } from "@/components/RoleProvider";
import SentinelCallOverlay from "@/components/SentinelCallOverlay";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PROMETHEUS — Digital Asset Command Center",
  description: "Copy trading, EMBER hub and tokenomics, wallet and portfolio — read straight from the platform's ledger.",
};

/**
 * MODULE 02: the session is exposed to client components through
 * `SessionProvider` for display only. Route protection is decided per route in
 * `proxy.ts` and enforced per data access in `lib/dal.ts` - not here, because a
 * layout that redirected would lock anonymous visitors out of the landing page.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-[#0B0D10] text-[#F3F4F6]">
        {/* AI trade-buddy configuration (design-integration task). The widget
            (`public/ai-doubt-solver.js`) reads `window.PROMETHEUS_AI_CONFIG`
            when it initialises and would otherwise default to the backend's
            address on localhost:3001 — which the browser must never learn.
            Set before any body content so it is in place ahead of the widget,
            however a page loads it. Relative URLs resolve through the BFF. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'window.PROMETHEUS_AI_CONFIG = { apiEndpoint: "/api/ai-doubt-solver", modelName: "Prometheus AI" };',
          }}
        />
        <AuthSessionProvider>
          {/* MODULE 13: roles are fetched once here and exposed through
              useRoles(). Inside AuthSessionProvider so useSession() works.
              OnboardingGate sits inside both so it can send a brand-new
              account to /onboarding instead of the dashboard. */}
          <RoleProvider>
            <OnboardingGate>{children}</OnboardingGate>
            {/* MODULE 14: the simulated Sentinel call rings over whatever page
                is open. Sits inside both providers so useSession()/useRoles()
                resolve, and renders nothing for roles that have no consumer
                alerting surface. */}
            <SentinelCallOverlay />
          </RoleProvider>
        </AuthSessionProvider>
        {/* Pyrus — the AI trading buddy (design-integration task). Mounted once
            here so the floating assistant and its animated character appear on
            every route, public ones included. The bridge loader is idempotent
            (`__PrometheusAIDoubtSolverScriptLoaded`), so the design pages that
            still inline `/trade-buddy.js` cannot mount a second copy. */}
        <Script src="/trade-buddy.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
