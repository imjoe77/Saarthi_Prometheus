"use client";

import React, { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleUserRound,
  Droplets,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  LogOut,
  Mail,
  ShieldCheck,
  User,
  Users,
  Zap,
} from "lucide-react";

import { clearApiToken, signInWithProvider } from "@/lib/auth-actions";
import {
  continueHref,
  ROLE_LABELS,
  type LoginMode,
  type LoginRole,
} from "@/lib/login-flow";
import { sanitizeReturnPath } from "@/lib/return-path";

/**
 * MODULE 02/13 — the dedicated login page.
 *
 * LAYOUT comes from the project's design reference
 * (`UI/Frontend/Frontend/src/pages/Auth.jsx`): the two-step flow (choose a
 * workspace, then the auth card with Login/Sign Up tabs). Its router and
 * animation library do not exist in this app, so routing is Next's and the
 * stage transitions are CSS.
 *
 * EACH WORKSPACE HAS ITS OWN AMBIENT THEME. The backdrop keeps four tint
 * layers stacked and cross-fades between them when a role is chosen, so the
 * page changes temperature around the card without the card itself moving or
 * changing shape. `--accent` carries the same role colour into the hairlines,
 * the tab pill, the icons and the market line.
 *
 * AUTHENTICATION IS REAL. Google and GitHub start the Auth.js OAuth exchange
 * through the `signInWithProvider` server action; the role and mode ride the
 * round trip to `/login/continue`, which reconciles them against `GET /rbac/me`
 * and the backend's email allow-list. Selecting a card never grants a role:
 * four cards exist (Normal User, Expert Trader, Liquidity Provider, Platform
 * Admin) and each only states an intent — the backend decides whether the
 * account may reach that surface, with admin access granted purely by
 * configuration (`PLATFORM_ADMIN_EMAILS`) and never by signup.
 *
 * THE EMAIL/PASSWORD FORM IS VISUAL ONLY. Prometheus authenticates through
 * OAuth exclusively — the backend stores no password material and exposes no
 * credentials endpoint (see the User model note in
 * `backend/prisma/schema.prisma`). The fields are rendered for design fidelity,
 * the submit control is disabled, and the notice above them says so plainly.
 * Nothing typed into those fields is transmitted, logged or stored.
 */

interface RoleCard {
  role: LoginRole;
  icon: typeof CircleUserRound;
  color: string;
  description: string;
  /** Expert, liquidity and admin access is limited to allow-listed emails. */
  approvalRequired: boolean;
  /** Meta-line override when "Approved emails only" would be too vague. */
  meta?: string;
}

const SELECTABLE_ROLES: RoleCard[] = [
  {
    role: "USER",
    icon: Users,
    color: "#38bdf8",
    description: "Copy elite traders, follow live portfolios and grow with guided analytics.",
    approvalRequired: false,
  },
  {
    role: "EXPERT_TRADER",
    icon: Zap,
    color: "#a78bfa",
    description: "Build strategies, tune the risk engine and lead your own copiers.",
    approvalRequired: true,
  },
  {
    role: "LIQUIDITY_PROVIDER",
    icon: Droplets,
    color: "#fbbf24",
    description: "Provide liquidity, manage pools and optimise capital efficiency.",
    approvalRequired: true,
  },
  {
    role: "PLATFORM_ADMIN",
    icon: ShieldCheck,
    color: "#fb7185",
    description: "Manage users, roles and the platform-wide audit trail.",
    approvalRequired: true,
    meta: "Env-listed emails only",
  },
];

/** Role → ambient theme key. Kept explicit: the enum is not a CSS class. */
const THEME_BY_ROLE: Record<LoginRole, string> = {
  USER: "user",
  EXPERT_TRADER: "expert",
  LIQUIDITY_PROVIDER: "liquidity",
  PLATFORM_ADMIN: "admin",
};

const THEME_KEYS = ["neutral", "user", "expert", "liquidity", "admin"] as const;

/** Large ambient wordmark that makes the active workspace unmistakable. */
const WATERMARK: Record<string, string> = {
  neutral: "",
  user: "NORMAL",
  expert: "EXPERT",
  liquidity: "LIQUIDITY",
  admin: "ADMIN",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Provider marks (brand glyphs for the real OAuth buttons)
// ---------------------------------------------------------------------------

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.72.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.14c0 .3.21.66.8.55A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ambient backdrop — four stacked tint layers, cross-faded by theme
// ---------------------------------------------------------------------------

function AuthBackdrop({ theme }: { theme: string }) {
  // Deterministic placement (index arithmetic, never Math.random) so the server
  // and the first client render agree and hydration stays clean.
  const particles = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        left: 3 + ((i * 53) % 94),
        top: 6 + ((i * 41) % 84),
        size: 1.5 + (i % 3) * 0.75,
        dur: 11 + (i % 5) * 2.6,
        delay: (i % 7) * 1.4,
      })),
    [],
  );

  return (
    <div className="ax-bg" aria-hidden="true">
      {/* Theme washes. All four stay mounted so changing role is a cross-fade,
          never a reflow. */}
      {THEME_KEYS.map((key) => (
        <div
          key={key}
          className={`ax-tint ax-tint-${key}${key === theme ? " is-on" : ""}`}
        />
      ))}

      <div className="ax-grid" />

      <div className="ax-particles">
        {particles.map((p, i) => (
          <span
            key={i}
            className="ax-particle"
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              animationDuration: `${p.dur}s`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </div>

      <svg className="ax-bg-line" viewBox="0 0 1440 200" preserveAspectRatio="none">
        <path className="base" d="M0,140 C200,120 320,160 500,100 C680,40 800,110 960,80 C1120,50 1280,120 1440,90" />
        <path className="moving" d="M0,140 C200,120 320,160 500,100 C680,40 800,110 960,80 C1120,50 1280,120 1440,90" />
      </svg>

      <div className="ax-bg-candles">
        {[38, 55, 30, 62, 44, 70, 35, 58, 42, 66, 28, 50, 60, 34, 48].map((h, i) => (
          <span
            key={i}
            className={`ax-bg-candle${i % 3 === 0 ? " up" : ""}`}
            style={{ height: `${h}%`, animationDelay: `${(i % 5) * 0.8}s` }}
          />
        ))}
      </div>

      {WATERMARK[theme] ? <div className="ax-watermark">{WATERMARK[theme]}</div> : null}

      <div className="ax-vignette" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password field — presentation only (see the note on visual-only fields)
// ---------------------------------------------------------------------------

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  autoComplete: string;
  invalid: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={`ax-field${invalid ? " ax-field-invalid" : ""}`}>
      <Lock size={15} className="ax-field-icon" />
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="ax-toggle"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "Hide password" : "Show password"}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

/** Local strength read-out. It feeds a decorative meter; nothing is submitted. */
function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^\w\s]/.test(pw)) s++;
  return Math.min(s, 4);
}

const STRENGTH_META = [
  { label: "", color: "transparent" },
  { label: "Weak", color: "#f43f5e" },
  { label: "Fair", color: "#f97316" },
  { label: "Good", color: "#fbbf24" },
  { label: "Strong", color: "#00d26a" },
];

// ---------------------------------------------------------------------------
// Main login page
// ---------------------------------------------------------------------------

export default function LoginForm({ next }: { next: string | null }) {
  const returnPath = sanitizeReturnPath(next);
  const { status, data: session } = useSession();
  const router = useRouter();

  const [selectedRole, setSelectedRole] = useState<RoleCard | null>(null);
  const [mode, setMode] = useState<LoginMode>("login");

  // Email/password values live in component state for the design preview.
  // They are never sent anywhere: the submit control is disabled by design.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<null | "google" | "github">(null);

  const isLogin = mode === "login";
  const step = selectedRole ? "form" : "roles";
  const theme = selectedRole ? THEME_BY_ROLE[selectedRole.role] : "neutral";
  const ActiveIcon = selectedRole?.icon ?? CircleUserRound;

  const pickRole = (card: RoleCard): void => {
    const href = continueHref(card.role, mode, returnPath);
    if (status === "authenticated") {
      // A session already exists: the role intent is all that is needed, and
      // /login/continue routes by the roles this session actually holds.
      router.push(href);
      return;
    }
    setSelectedRole(card);
  };

  const switchMode = (nextMode: LoginMode): void => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setTouched({});
    setPassword("");
    setConfirmPw("");
  };

  const backToRoles = (): void => {
    setSelectedRole(null);
    setTouched({});
    setPassword("");
    setConfirmPw("");
  };

  const startOAuth = (provider: "google" | "github") => {
    if (!selectedRole) return;
    setBusy(provider);
    void signInWithProvider(provider, continueHref(selectedRole.role, mode, returnPath));
  };

  // Client-side hints, shown only once a field has been left. They describe the
  // design preview; they never gate an authentication attempt, because there is
  // no authentication attempt to gate.
  const loginErrors: Record<string, string> = {};
  if (!email.trim()) loginErrors.email = "Email is required.";
  else if (!EMAIL_RE.test(email.trim())) loginErrors.email = "Enter a valid email address.";
  if (!password) loginErrors.password = "Password is required.";

  const signupErrors: Record<string, string> = {};
  if (!name.trim()) signupErrors.name = "Name is required.";
  else if (name.trim().length < 2) signupErrors.name = "Name must be at least 2 characters.";
  signupErrors.email = loginErrors.email;
  if (!password) signupErrors.password = "Password is required.";
  else if (password.length < 6) signupErrors.password = "Password must be at least 6 characters.";
  if (!confirmPw) signupErrors.confirm = "Please confirm your password.";
  else if (confirmPw !== password) signupErrors.confirm = "Passwords do not match.";

  const errors = isLogin ? loginErrors : signupErrors;
  const strength = isLogin ? 0 : passwordStrength(password);
  const strengthMeta = STRENGTH_META[strength];

  if (status === "loading") {
    return (
      <div className={`ax-page ax-theme-neutral ax-page-loading`}>
        <div className="ax-loader" />
      </div>
    );
  }

  return (
    <div className={`ax-page ax-theme-${theme}`}>
      <AuthBackdrop theme={theme} />

      {step === "roles" ? (
        /* Step 1 — pick the workspace you intend to enter. */
        <div key="roles" className="ax-roles-stage ax-anim-in">
          <Link href="/" className="ax-brand" aria-label="Prometheus home">
            <span className="ax-brand-mark">
              <Image src="/assets/prometheus-logo.png" alt="" width={30} height={30} />
            </span>
            <span className="ax-brand-name">PROMETHEUS</span>
          </Link>

          <div className="ax-roles-head">
            <p className="ax-eyebrow">Workspace access</p>
            <h1 className="ax-roles-title">Choose your workspace</h1>
            <p className="ax-roles-sub">
              Your selection sets the workspace you enter after sign-in.
            </p>
          </div>

          {status === "authenticated" && (
            <div className="ax-signed-in">
              <p>
                Signed in as <span className="ax-signed-in-email">{session?.user?.email ?? "unknown"}</span>{" "}
                — picking a workspace routes this session and never changes your roles.
              </p>
              <button
                type="button"
                onClick={async () => {
                  await clearApiToken();
                  await signOut({ redirectTo: "/" });
                }}
                className="ax-signed-out-btn"
              >
                <LogOut size={12} />
                <span>Sign out</span>
              </button>
            </div>
          )}

          <div className="ax-pick-grid" role="radiogroup" aria-label="Select your role">
            {SELECTABLE_ROLES.map((card, i) => {
              const Icon = card.icon;
              return (
                <button
                  key={card.role}
                  type="button"
                  role="radio"
                  aria-checked={false}
                  id={`auth-role-${card.role}`}
                  className="ax-pick-card"
                  style={
                    {
                      "--role-c": card.color,
                      animationDelay: `${0.07 * i + 0.05}s`,
                    } as React.CSSProperties
                  }
                  onClick={() => pickRole(card)}
                >
                  <span className="ax-pick-icon">
                    <Icon size={19} strokeWidth={1.7} />
                  </span>
                  <span className="ax-pick-name">{ROLE_LABELS[card.role]}</span>
                  <span className="ax-pick-desc">{card.description}</span>
                  <span className="ax-pick-meta">
                    {card.meta ??
                      (card.approvalRequired ? "Approved emails only" : "Open to all accounts")}
                  </span>
                  <span className="ax-pick-cta">
                    Continue <ArrowRight size={13} />
                  </span>
                </button>
              );
            })}
          </div>

          <p className="ax-roles-foot">
            Selecting a role never grants it. Expert Trader and Liquidity Provider are limited to
            approved emails, Platform Admin is granted by configuration only (never by signup), and
            every other account continues as a Normal User. One Gmail address may hold only one
            privileged role.
          </p>
        </div>
      ) : (
        /* Step 2 — the auth card for the chosen workspace. */
        <div key={`form-${selectedRole?.role}`} className="ax-form-stage ax-anim-in">
          <div className="ax-form-col">
            <div className="ax-topbar">
              <button type="button" className="ax-back" onClick={backToRoles} id="auth-back-roles">
                <ArrowLeft size={13} /> Change role
              </button>
              <Link href="/" className="ax-home-link">
                Back to home
              </Link>
            </div>

            <Link href="/" className="ax-brand" aria-label="Prometheus home">
              <span className="ax-brand-mark">
                <Image src="/assets/prometheus-logo.png" alt="" width={30} height={30} />
              </span>
              <span className="ax-brand-name">PROMETHEUS</span>
            </Link>

            <div className="ax-card">
              <div className="ax-card-head">
                <div className="ax-role-chip" style={{ "--role-c": selectedRole?.color } as React.CSSProperties}>
                  <ActiveIcon size={12} strokeWidth={1.9} />
                  <span>{selectedRole ? ROLE_LABELS[selectedRole.role] : "Account"}</span>
                </div>
                <h1 className="ax-title">{isLogin ? "Welcome back" : "Create your account"}</h1>
                <p className="ax-subtitle">
                  {isLogin
                    ? "Sign in to your trading workspace"
                    : "Start copy-trading and managing digital assets"}
                </p>
              </div>

              {/* Login / Sign Up — both run the same OAuth exchange; `mode` only
                  shapes the copy on /login/continue. */}
              <div className="ax-tabs" role="tablist" aria-label="Authentication mode">
                <button
                  type="button"
                  role="tab"
                  id="auth-tab-login"
                  aria-selected={isLogin}
                  className={`ax-tab${isLogin ? " ax-tab-active" : ""}`}
                  onClick={() => switchMode("login")}
                >
                  Login
                </button>
                <button
                  type="button"
                  role="tab"
                  id="auth-tab-signup"
                  aria-selected={!isLogin}
                  className={`ax-tab${!isLogin ? " ax-tab-active" : ""}`}
                  onClick={() => switchMode("signup")}
                >
                  Sign Up
                </button>
                <span className={`ax-tab-pill${isLogin ? "" : " ax-tab-pill-right"}`} aria-hidden="true" />
              </div>

              {/* The real authentication path: Auth.js OAuth, provider list fixed server-side. */}
              <div className="ax-social">
                <button
                  type="button"
                  className="ax-social-btn"
                  onClick={() => startOAuth("google")}
                  disabled={busy !== null}
                  id="auth-google"
                >
                  {busy === "google" ? <Loader2 size={17} className="ax-spin" /> : <GoogleIcon />}
                  <span>Continue with Google</span>
                </button>
                <button
                  type="button"
                  className="ax-social-btn"
                  onClick={() => startOAuth("github")}
                  disabled={busy !== null}
                  id="auth-github"
                >
                  {busy === "github" ? <Loader2 size={17} className="ax-spin" /> : <GitHubIcon />}
                  <span>Continue with GitHub</span>
                </button>
              </div>

              <div className="ax-divider">
                <span>or continue with email</span>
              </div>

              {/* Visual-only fields: rendered to match the approved design. No submit
                  path exists, and the disabled control below says so in as many words. */}
              <form
                className="ax-form"
                noValidate
                onSubmit={(event) => {
                  // Belt and braces: the submit button is disabled, so this never fires.
                  event.preventDefault();
                }}
              >
                {!isLogin && (
                  <div className="ax-group">
                    <label className="ax-label" htmlFor="auth-name">
                      Full name
                    </label>
                    <div className={`ax-field${touched.name && signupErrors.name ? " ax-field-invalid" : ""}`}>
                      <User size={15} className="ax-field-icon" />
                      <input
                        id="auth-name"
                        type="text"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onBlur={() => setTouched((state) => ({ ...state, name: true }))}
                        placeholder="Alex Mercer"
                        autoComplete="name"
                      />
                    </div>
                    {touched.name && signupErrors.name && (
                      <p className="ax-error">
                        <AlertCircle size={12} /> {signupErrors.name}
                      </p>
                    )}
                  </div>
                )}

                <div className="ax-group">
                  <label className="ax-label" htmlFor="auth-email">
                    Email
                  </label>
                  <div className={`ax-field${touched.email && errors.email ? " ax-field-invalid" : ""}`}>
                    <Mail size={15} className="ax-field-icon" />
                    <input
                      id="auth-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      onBlur={() => setTouched((state) => ({ ...state, email: true }))}
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                  </div>
                  {touched.email && errors.email && (
                    <p className="ax-error">
                      <AlertCircle size={12} /> {errors.email}
                    </p>
                  )}
                </div>

                <div className="ax-group">
                  <div className="ax-label-row">
                    <label className="ax-label" htmlFor="auth-password">
                      Password
                    </label>
                    {!isLogin && password && (
                      <span className="ax-strength-label" style={{ color: strengthMeta.color }}>
                        {strengthMeta.label}
                      </span>
                    )}
                  </div>
                  <PasswordInput
                    id="auth-password"
                    value={password}
                    onChange={setPassword}
                    placeholder="••••••••"
                    autoComplete={isLogin ? "current-password" : "new-password"}
                    invalid={Boolean(touched.password && errors.password)}
                  />
                  {!isLogin && (
                    <div className="ax-strength" aria-hidden="true">
                      {[1, 2, 3, 4].map((i) => (
                        <span
                          key={i}
                          className="ax-strength-seg"
                          style={{ background: i <= strength ? strengthMeta.color : "rgba(255,255,255,.07)" }}
                        />
                      ))}
                    </div>
                  )}
                  {touched.password && errors.password && (
                    <p className="ax-error">
                      <AlertCircle size={12} /> {errors.password}
                    </p>
                  )}
                </div>

                {!isLogin && (
                  <div className="ax-group">
                    <label className="ax-label" htmlFor="auth-confirm">
                      Confirm password
                    </label>
                    <PasswordInput
                      id="auth-confirm"
                      value={confirmPw}
                      onChange={setConfirmPw}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      invalid={Boolean(touched.confirm && signupErrors.confirm)}
                    />
                    {touched.confirm && !signupErrors.confirm && confirmPw && (
                      <p className="ax-ok">
                        <Check size={12} /> Passwords match
                      </p>
                    )}
                    {touched.confirm && signupErrors.confirm && (
                      <p className="ax-error">
                        <AlertCircle size={12} /> {signupErrors.confirm}
                      </p>
                    )}
                  </div>
                )}

                <button type="submit" className="ax-submit" disabled id="auth-submit">
                  {isLogin ? "Password sign-in not enabled" : "Password sign-up not enabled"}
                </button>
              </form>

            </div>

            <p className="ax-legal">
              By continuing you agree to Prometheus&apos;s <span>Terms</span> &amp;{" "}
              <span>Privacy Policy</span>.
            </p>
          </div>
        </div>
      )}

      <style>{authStyles}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
//
// Typography is the app's own Geist pairing (`--font-geist-sans` / `--font-geist-mono`
// from app/layout.tsx) rather than a generic sans stack. Mono is reserved for
// eyebrows, chips and counters so the page reads as an instrument panel, not a
// landing page.
// ---------------------------------------------------------------------------

const authStyles = `
.ax-page {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--page-bg, #0a0704);
  font-family: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #f3f4f6;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  transition: background-color .7s ease;
}

/* Per-workspace accent + page base. Every theme stays inside the site's
   dark-orange / black palette; they differ by heat, not by hue family. */
.ax-theme-neutral   { --accent: #fb923c; --accent-dim: rgba(251,146,60,.55); --page-bg: #0a0704; }
.ax-theme-user      { --accent: #ff6b2c; --accent-dim: rgba(255,107,44,.6);  --page-bg: #120704; }
.ax-theme-expert    { --accent: #ff4d3d; --accent-dim: rgba(255,77,61,.6);   --page-bg: #130405; }
.ax-theme-liquidity { --accent: #ffb020; --accent-dim: rgba(255,176,32,.6);  --page-bg: #110a02; }
.ax-theme-admin     { --accent: #ff3d6e; --accent-dim: rgba(255,61,110,.6);  --page-bg: #13040b; }

.ax-page-loading { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.ax-loader {
  width: 34px; height: 34px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.08);
  border-top-color: var(--accent);
  animation: ax-spin .8s linear infinite;
}
@keyframes ax-spin { to { transform: rotate(360deg); } }
.ax-spin { animation: ax-spin .8s linear infinite; }

/* Stage entrances (replacing the reference's framer-motion fades). */
.ax-anim-in { animation: ax-stage-in .36s cubic-bezier(.22,1,.36,1) both; }
@keyframes ax-stage-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.ax-pick-card { animation: ax-card-in .4s cubic-bezier(.22,1,.36,1) both; }
@keyframes ax-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ---------- Backdrop ---------- */
.ax-bg { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }

/* Theme washes: stacked, cross-faded. */
.ax-tint { position: absolute; inset: -12%; opacity: 0; transition: opacity .7s cubic-bezier(.22,1,.36,1); }
.ax-tint.is-on { opacity: 1; }
.ax-tint-neutral {
  background:
    radial-gradient(900px 640px at 14% 2%, rgba(251,146,60,.26), transparent 62%),
    radial-gradient(760px 560px at 86% 98%, rgba(249,115,22,.18), transparent 66%);
}
.ax-tint-user {
  background:
    radial-gradient(980px 700px at 6% -4%, rgba(255,90,31,.46), transparent 62%),
    radial-gradient(820px 620px at 94% 102%, rgba(255,122,26,.32), transparent 66%),
    linear-gradient(155deg, rgba(255,90,31,.10), transparent 48%);
}
.ax-tint-expert {
  background:
    radial-gradient(980px 700px at 10% 0%, rgba(239,68,68,.46), transparent 62%),
    radial-gradient(840px 620px at 90% 100%, rgba(255,77,61,.30), transparent 66%),
    linear-gradient(200deg, rgba(220,38,38,.12), transparent 52%);
}
.ax-tint-liquidity {
  background:
    radial-gradient(1000px 720px at 12% -2%, rgba(251,191,36,.44), transparent 62%),
    radial-gradient(820px 600px at 88% 100%, rgba(255,140,0,.30), transparent 66%),
    linear-gradient(140deg, rgba(245,158,11,.11), transparent 50%);
}
.ax-tint-admin {
  background:
    radial-gradient(980px 700px at 8% -2%, rgba(255,61,110,.42), transparent 62%),
    radial-gradient(840px 620px at 92% 100%, rgba(255,45,90,.28), transparent 66%),
    linear-gradient(190deg, rgba(225,29,72,.12), transparent 50%);
}

.ax-grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(color-mix(in srgb, var(--accent) 9%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 9%, transparent) 1px, transparent 1px);
  background-size: 72px 72px;
  mask-image: radial-gradient(ellipse 78% 70% at 50% 45%, black 12%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse 78% 70% at 50% 45%, black 12%, transparent 80%);
  transition: background-image .7s ease;
}

.ax-particles { position: absolute; inset: 0; }
.ax-particle {
  position: absolute; border-radius: 50%;
  background: var(--accent);
  opacity: .4;
  animation: ax-float 14s ease-in-out infinite;
  transition: background .7s ease;
}
@keyframes ax-float {
  0%, 100% { transform: translateY(0); opacity: 0; }
  20% { opacity: .45; }
  55% { transform: translateY(-38px); opacity: .22; }
  85% { opacity: .06; }
}

.ax-bg-line { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .5; }
.ax-bg-line path.base { fill: none; stroke: rgba(255,255,255,.055); stroke-width: 1; }
.ax-bg-line path.moving {
  fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-linecap: round;
  stroke-dasharray: 120 1100; opacity: .45;
  animation: ax-line 14s linear infinite;
  transition: stroke .7s ease;
}
@keyframes ax-line { to { stroke-dashoffset: -1220; } }

.ax-bg-candles {
  position: absolute; bottom: 6%; left: 5%; right: 5%;
  height: 15%; display: flex; align-items: flex-end; gap: 10px;
  opacity: .3; pointer-events: none;
}
.ax-bg-candle {
  flex: 1; border-radius: 1px;
  background: linear-gradient(180deg, var(--accent-dim), transparent);
  animation: ax-bcandle 7s ease-in-out infinite;
  transition: background .7s ease;
}
.ax-bg-candle.up { background: linear-gradient(180deg, rgba(0,210,106,.5), transparent); }
@keyframes ax-bcandle {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(1.08); }
}

.ax-vignette {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 72% 62% at 50% 42%, transparent 34%, rgba(0,0,0,.5) 100%);
}

/* Oversized workspace wordmark — the clearest signal that the theme changed. */
.ax-watermark {
  position: absolute;
  right: -1%; bottom: -6%;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-weight: 700;
  font-size: clamp(5.5rem, 19vw, 16rem);
  line-height: .78;
  letter-spacing: -.05em;
  color: color-mix(in srgb, var(--accent) 16%, transparent);
  user-select: none; pointer-events: none;
}

/* ---------- Brand ---------- */
.ax-brand {
  display: inline-flex; align-items: center; gap: 10px;
  text-decoration: none; position: relative; z-index: 2;
}
.ax-brand-mark {
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 42%, transparent));
  transition: filter .6s ease;
}
.ax-brand-mark img { width: 100%; height: 100%; object-fit: contain; }
.ax-brand-name {
  font-family: var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace;
  font-weight: 600; font-size: .82rem; letter-spacing: .22em;
  color: #f3f4f6;
}

/* ---------- Step 1 · workspace selection ---------- */
.ax-roles-stage {
  position: relative; z-index: 1;
  width: 100%; min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 56px 24px 44px; gap: 28px;
}
.ax-roles-head { text-align: center; max-width: 560px; }
.ax-eyebrow {
  margin: 0 0 10px;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .66rem; font-weight: 500; letter-spacing: .2em; text-transform: uppercase;
  color: var(--accent);
  transition: color .6s ease;
}
.ax-roles-title {
  margin: 0 0 8px;
  font-size: clamp(1.6rem, 3.2vw, 2.05rem);
  font-weight: 600; letter-spacing: -.025em; line-height: 1.15; color: #fff;
}
.ax-roles-sub { margin: 0; color: #8b93a1; font-size: .86rem; line-height: 1.6; }

.ax-pick-grid {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px; width: min(1060px, 100%);
}
.ax-pick-card {
  position: relative; overflow: hidden;
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  padding: 22px 20px 18px;
  text-align: left; cursor: pointer; font-family: inherit;
  border-radius: 14px;
  background: rgba(255,255,255,.022);
  border: 1px solid rgba(255,255,255,.07);
  color: #f3f4f6;
  transition: border-color .2s ease, background .2s ease, transform .2s ease;
}
.ax-pick-card:hover, .ax-pick-card:focus-visible {
  border-color: color-mix(in srgb, var(--role-c) 45%, transparent);
  background: rgba(255,255,255,.045);
  transform: translateY(-2px);
  outline: none;
}
.ax-pick-card:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--role-c) 55%, transparent); }

.ax-pick-icon {
  width: 38px; height: 38px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  color: var(--role-c);
  background: color-mix(in srgb, var(--role-c) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--role-c) 24%, transparent);
  margin-bottom: 4px;
}
.ax-pick-name { font-size: .97rem; font-weight: 600; letter-spacing: -.01em; color: #fff; }
.ax-pick-desc { font-size: .79rem; line-height: 1.55; color: #8b93a1; flex: 1; }
.ax-pick-meta {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .6rem; letter-spacing: .12em; text-transform: uppercase;
  color: #5e687a;
  padding-top: 2px;
}
.ax-pick-cta {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .64rem; font-weight: 500; letter-spacing: .13em; text-transform: uppercase;
  color: var(--role-c);
}
.ax-pick-cta svg { transition: transform .18s ease; }
.ax-pick-card:hover .ax-pick-cta svg { transform: translateX(3px); }

.ax-roles-foot {
  margin: 0; max-width: 600px; color: #5e687a;
  font-size: .72rem; line-height: 1.7; text-align: center;
}
.ax-home-link {
  color: #9aa2b1; font-size: .74rem; font-weight: 500; text-decoration: none;
  transition: color .15s ease;
}
.ax-home-link:hover { color: #fff; }

/* Signed-in notice */
.ax-signed-in {
  width: min(600px, 100%);
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 10px 12px 10px 14px; border-radius: 10px;
  background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.07);
}
.ax-signed-in p { margin: 0; color: #9aa2b1; font-size: .76rem; line-height: 1.55; }
.ax-signed-in-email { color: #fff; font-weight: 600; word-break: break-all; }
.ax-signed-out-btn {
  display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
  padding: 5px 10px; border-radius: 7px; cursor: pointer;
  background: transparent; border: 1px solid rgba(255,255,255,.1);
  color: #9aa2b1; font-size: .71rem; font-weight: 600; font-family: inherit;
  transition: color .16s ease, border-color .16s ease;
}
.ax-signed-out-btn:hover { color: #f43f5e; border-color: rgba(244,63,94,.45); }

/* ---------- Step 2 · auth card ---------- */
.ax-form-stage {
  position: relative; z-index: 1;
  width: 100%; min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 36px 18px;
}
.ax-form-col {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  width: min(432px, 100%);
}
.ax-topbar { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ax-back {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: 7px; cursor: pointer;
  background: transparent; border: 1px solid rgba(255,255,255,.1);
  color: #9aa2b1; font-size: .72rem; font-weight: 500; font-family: inherit;
  transition: color .16s ease, border-color .16s ease;
}
.ax-back:hover { color: #fff; border-color: rgba(255,255,255,.22); }

.ax-card {
  position: relative; overflow: hidden;
  width: 100%;
  padding: 24px 24px 18px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(21,24,30,.94) 0%, rgba(13,15,19,.97) 100%);
  border: 1px solid rgba(255,255,255,.075);
  box-shadow: 0 28px 64px -24px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.045);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
/* Accent hairline along the card's top edge — the signature of the theme. */
.ax-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 60%, transparent), transparent);
  transition: background .6s ease;
}

.ax-card-head { text-align: center; margin-bottom: 18px; }
.ax-role-chip {
  display: inline-flex; align-items: center; gap: 6px;
  margin-bottom: 12px; padding: 4px 10px; border-radius: 6px;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .6rem; font-weight: 500; letter-spacing: .13em; text-transform: uppercase;
  color: var(--role-c, var(--accent));
  background: color-mix(in srgb, var(--role-c, var(--accent)) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--role-c, var(--accent)) 22%, transparent);
}
.ax-title {
  margin: 0 0 6px;
  font-size: 1.45rem; font-weight: 600; letter-spacing: -.025em; color: #fff;
}
.ax-subtitle { margin: 0; color: #8b93a1; font-size: .83rem; }

/* Tabs */
.ax-tabs {
  position: relative; display: grid; grid-template-columns: 1fr 1fr;
  padding: 3px; margin-bottom: 14px;
  border-radius: 10px;
  background: rgba(255,255,255,.035);
  border: 1px solid rgba(255,255,255,.06);
}
.ax-tab {
  position: relative; z-index: 1;
  padding: 8px 0; border: 0; border-radius: 8px; background: transparent;
  font-size: .82rem; font-weight: 500; color: #8b93a1; cursor: pointer; font-family: inherit;
  transition: color .22s ease;
}
.ax-tab-active { color: #0b0d10; font-weight: 600; }
.ax-tab-pill {
  position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc(50% - 3px);
  border-radius: 8px;
  background: var(--accent);
  box-shadow: 0 1px 8px -2px color-mix(in srgb, var(--accent) 55%, transparent);
  transition: transform .26s cubic-bezier(.22,1,.36,1), background .6s ease;
}
.ax-tab-pill-right { transform: translateX(100%); }

/* Social buttons — the real OAuth path */
.ax-social { display: grid; gap: 8px; margin-bottom: 14px; }
.ax-social-btn {
  display: flex; align-items: center; justify-content: center; gap: 9px;
  width: 100%; padding: 10px 14px; border-radius: 9px; cursor: pointer;
  background: rgba(255,255,255,.035);
  border: 1px solid rgba(255,255,255,.09);
  color: #f3f4f6; font-size: .84rem; font-weight: 500; font-family: inherit;
  transition: background .16s ease, border-color .16s ease;
}
.ax-social-btn:hover:not(:disabled) { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.18); }
.ax-social-btn:disabled { opacity: .55; cursor: not-allowed; }

.ax-divider {
  display: flex; align-items: center; gap: 12px; margin-bottom: 14px;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .6rem; letter-spacing: .16em; text-transform: uppercase; color: #4c5563;
}
.ax-divider::before, .ax-divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,.06); }

/* Visual-only form */
.ax-form { display: flex; flex-direction: column; gap: 12px; }
.ax-group { display: flex; flex-direction: column; gap: 6px; }
.ax-label-row { display: flex; align-items: center; justify-content: space-between; }
.ax-label {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .62rem; font-weight: 500; letter-spacing: .1em; text-transform: uppercase;
  color: #7b8494;
}
.ax-strength-label {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: .6rem; letter-spacing: .08em; text-transform: uppercase;
}

.ax-field {
  display: flex; align-items: center; gap: 9px;
  padding: 0 11px; border-radius: 9px;
  background: rgba(255,255,255,.025);
  border: 1px solid rgba(255,255,255,.08);
  transition: border-color .16s ease, background .16s ease;
}
.ax-field:focus-within { border-color: rgba(255,255,255,.2); background: rgba(255,255,255,.04); }
.ax-field-invalid { border-color: rgba(244,63,94,.55) !important; }
.ax-field-icon { color: #5e687a; flex-shrink: 0; }
.ax-field input {
  flex: 1; min-width: 0; padding: 10px 0;
  background: transparent; border: 0; outline: none;
  color: #f3f4f6; font-size: .85rem; font-family: inherit;
}
.ax-field input::placeholder { color: #4c5563; }
.ax-toggle {
  display: flex; align-items: center; justify-content: center;
  padding: 4px; border: 0; border-radius: 5px; background: transparent;
  color: #5e687a; cursor: pointer; transition: color .14s ease;
}
.ax-toggle:hover { color: #d1d5db; }

.ax-strength { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 2px; }
.ax-strength-seg { height: 2px; border-radius: 1px; transition: background .25s ease; }

.ax-error { display: flex; align-items: center; gap: 5px; margin: 0; color: #fb7185; font-size: .71rem; }
.ax-ok { display: flex; align-items: center; gap: 5px; margin: 0; color: #34d399; font-size: .71rem; }

/* A disabled control, styled as a deliberate statement rather than a broken button. */
.ax-submit {
  width: 100%; margin-top: 2px; padding: 10px 16px;
  border: 1px dashed rgba(255,255,255,.13); border-radius: 9px;
  background: transparent;
  color: #6b7280; font-size: .78rem; font-weight: 500; font-family: inherit;
  letter-spacing: .01em;
  cursor: not-allowed;
}

.ax-legal {
  margin: 0; color: #4c5563; font-size: .67rem; text-align: center;
  font-family: var(--font-geist-mono), ui-monospace, monospace; letter-spacing: .02em;
}
.ax-legal span { color: #6b7280; }

/* Responsive */
@media (max-width: 1100px) {
  /* Four cards are too narrow here: two by two keeps every description intact. */
  .ax-pick-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); width: min(740px, 100%); }
}
@media (max-width: 900px) {
  .ax-pick-grid { grid-template-columns: 1fr; width: min(400px, 100%); }
  .ax-pick-card { padding: 18px 16px 16px; }
  .ax-pick-icon { width: 34px; height: 34px; border-radius: 9px; }
}
@media (max-width: 520px) {
  .ax-card { padding: 20px 16px 16px; border-radius: 16px; }
  .ax-title { font-size: 1.3rem; }
  .ax-roles-stage { padding: 40px 16px 32px; gap: 22px; }
  .ax-roles-title { font-size: 1.45rem; }
  .ax-form-stage { padding: 22px 14px; }
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .ax-particle, .ax-spin, .ax-loader, .ax-anim-in, .ax-pick-card,
  .ax-bg-line path.moving, .ax-bg-candle, .ax-tint { animation: none !important; transition: none !important; }
}
`;
