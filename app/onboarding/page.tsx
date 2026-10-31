"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import { useRoles } from "@/components/RoleProvider";
import {
  ApiError,
  completeOnboarding,
  createRoleRequest,
  getMyProfile,
  listMyRoleRequests,
  updateMyProfile,
  type ProfileResponse,
  type RoleName,
  type RoleRequest,
} from "@/lib/api-client";

/**
 * MODULE 13 — the financial-preference onboarding wizard.
 *
 * Three steps of fixed-choice questions, an account-type step, then a review.
 * Every option maps to a value the backend's UpdateProfileDto validates with
 * `@IsIn`, so the form can never store free-text into a field the rest of the
 * product renders as a choice. The wizard saves each step as the user
 * advances, so a half-finished questionnaire survives a reload; completion is
 * a separate idempotent call that refuses until the required core answers
 * exist.
 *
 * The account-type step is where a new account says how it will use the
 * platform: the investor path needs nothing, while Expert Trader and
 * Liquidity Provider file a real role request (`POST /rbac/role-requests`)
 * that an admin must approve — the wizard grants nothing by itself, and says
 * so.
 *
 * Nothing here fabricates suitability, risk scores or expected returns: the
 * answers are stored as stated preferences, and no page claims they were
 * measured.
 */

type LoadStatus = "loading" | "ready" | "error";
type Step = 0 | 1 | 2 | 3;
type AccountTypeValue = "INVESTOR" | "EXPERT_TRADER" | "LIQUIDITY_PROVIDER";

interface Choice {
  value: string;
  label: string;
  hint?: string;
}

const EXPERIENCE: Choice[] = [
  { value: "NONE", label: "None", hint: "I am new to investing." },
  { value: "BEGINNER", label: "Beginner", hint: "I have made a few investments." },
  { value: "INTERMEDIATE", label: "Intermediate", hint: "I invest regularly." },
  { value: "EXPERIENCED", label: "Experienced", hint: "I manage a portfolio actively." },
];

const CAPITAL_RANGE: Choice[] = [
  { value: "UNDER_10K", label: "Under ₹10,000" },
  { value: "10K_50K", label: "₹10,000 – ₹50,000" },
  { value: "50K_250K", label: "₹50,000 – ₹2,50,000" },
  { value: "250K_1M", label: "₹2,50,000 – ₹10,00,000" },
  { value: "OVER_1M", label: "Over ₹10,00,000" },
];

const CAPITAL_AVAILABILITY: Choice[] = [
  { value: "SHORT_TERM", label: "Short term", hint: "I may need this money soon." },
  { value: "MEDIUM_TERM", label: "Medium term", hint: "I can lock it away for a while." },
  { value: "LONG_TERM", label: "Long term", hint: "I do not need this money for years." },
];

const RISK_TOLERANCE: Choice[] = [
  { value: "CONSERVATIVE", label: "Conservative", hint: "I prefer stability over growth." },
  { value: "BALANCED", label: "Balanced", hint: "I accept some ups and downs." },
  { value: "AGGRESSIVE", label: "Aggressive", hint: "I chase growth and accept volatility." },
];

const DRAWDOWN: Choice[] = [
  { value: "LOW", label: "Low", hint: "A 5% drop would stress me." },
  { value: "MODERATE", label: "Moderate", hint: "I can live with a 10–15% drop." },
  { value: "HIGH", label: "High", hint: "A 25%+ drop would not change my plan." },
];

const VOLATILITY: Choice[] = [
  { value: "LOW", label: "Low", hint: "I want steady, quiet growth." },
  { value: "MEDIUM", label: "Medium", hint: "Some swings are acceptable." },
  { value: "HIGH", label: "High", hint: "I am comfortable with large swings." },
];

const GOAL: Choice[] = [
  { value: "CAPITAL_PRESERVATION", label: "Protect capital", hint: "I prioritise not losing money." },
  { value: "GROWTH", label: "Grow wealth", hint: "I prioritise long-term growth." },
  { value: "BALANCE", label: "Balance", hint: "I want a mix of growth and safety." },
  { value: "INCOME", label: "Generate income", hint: "I want regular cash flow." },
];

const HORIZON: Choice[] = [
  { value: "UNDER_1_YEAR", label: "Under 1 year" },
  { value: "1_3_YEARS", label: "1 – 3 years" },
  { value: "3_5_YEARS", label: "3 – 5 years" },
  { value: "OVER_5_YEARS", label: "Over 5 years" },
];

const EXPECTED_RETURN: Choice[] = [
  { value: "CONSERVATIVE", label: "Conservative", hint: "I expect modest, steady returns." },
  { value: "MODERATE", label: "Moderate", hint: "I expect market-like returns." },
  { value: "AMBITIOUS", label: "Ambitious", hint: "I aim for above-market returns." },
];

const HOLDING: Choice[] = [
  { value: "SHORT_TERM", label: "Short term", hint: "I may sell within months." },
  { value: "MEDIUM_TERM", label: "Medium term", hint: "I hold for a year or two." },
  { value: "LONG_TERM", label: "Long term", hint: "I hold for several years." },
];

const LOSS_REACTION: Choice[] = [
  { value: "SELL", label: "Sell", hint: "I would cut losses." },
  { value: "HOLD", label: "Hold", hint: "I would wait it out." },
  { value: "BUY_MORE", label: "Buy more", hint: "I would average down." },
];

const LIQUIDITY: Choice[] = [
  { value: "HIGH", label: "High", hint: "I may need to withdraw quickly." },
  { value: "MEDIUM", label: "Medium", hint: "I can wait a short while." },
  { value: "LOW", label: "Low", hint: "I do not need easy access." },
];

const CONTRIBUTION: Choice[] = [
  { value: "ONE_TIME", label: "One time", hint: "I plan to invest once." },
  { value: "MONTHLY", label: "Monthly", hint: "I plan to invest every month." },
  { value: "QUARTERLY", label: "Quarterly", hint: "I plan to invest every quarter." },
  { value: "FLEXIBLE", label: "Flexible", hint: "I will invest as and when I can." },
];

interface StepField {
  key: keyof ProfileResponse;
  question: string;
  help: string;
  choices: Choice[];
}

interface AccountType {
  value: AccountTypeValue;
  label: string;
  hint: string;
  /** The privileged role this choice requests; null for the baseline path. */
  role: Exclude<RoleName, "USER" | "PLATFORM_ADMIN"> | null;
}

const ACCOUNT_TYPES: AccountType[] = [
  {
    value: "INVESTOR",
    role: null,
    label: "Everyday investor",
    hint: "Copy strategies, exchange USDT and EMBER, track your portfolio. Available immediately — nothing to approve.",
  },
  {
    value: "EXPERT_TRADER",
    role: "EXPERT_TRADER",
    label: "Expert trader",
    hint: "Publish your own strategies for others to follow. Requires admin approval.",
  },
  {
    value: "LIQUIDITY_PROVIDER",
    role: "LIQUIDITY_PROVIDER",
    label: "Liquidity provider",
    hint: "Commit EMBER to the USDT exchange pool and earn from the fills it funds. Requires admin approval.",
  },
];

const STEPS: Array<{
  title: string;
  subtitle: string;
  fields: StepField[];
  accountType?: boolean;
}> = [
  {
    title: "Your starting point",
    subtitle: "Tell us where you are today. Nothing here is a commitment.",
    fields: [
      {
        key: "experienceLevel",
        question: "How much investing experience do you have?",
        help: "There is no wrong answer — it only shapes what we show you first.",
        choices: EXPERIENCE,
      },
      {
        key: "investmentCapitalRange",
        question: "How much capital are you planning to invest?",
        help: "An approximate range is enough.",
        choices: CAPITAL_RANGE,
      },
      {
        key: "capitalAvailability",
        question: "How available is that capital?",
        help: "How soon might you need it back?",
        choices: CAPITAL_AVAILABILITY,
      },
    ],
  },
  {
    title: "Risk and comfort",
    subtitle: "These answers stay preferences — they are not a suitability score.",
    fields: [
      {
        key: "riskTolerance",
        question: "How do you think about risk?",
        help: "This is your stated preference, not a measured trait.",
        choices: RISK_TOLERANCE,
      },
      {
        key: "drawdownComfort",
        question: "How would you feel about a portfolio drop?",
        help: "Drawdown is the peak-to-trough decline of an investment.",
        choices: DRAWDOWN,
      },
      {
        key: "volatilityComfort",
        question: "How comfortable are you with day-to-day swings?",
        help: "Volatility is how much prices move up and down.",
        choices: VOLATILITY,
      },
    ],
  },
  {
    title: "Goals and horizon",
    subtitle: "What are you aiming for, and over what period?",
    fields: [
      {
        key: "primaryGoal",
        question: "What is your primary goal?",
        help: "You can change this later in Preferences.",
        choices: GOAL,
      },
      {
        key: "timeHorizon",
        question: "What is your time horizon?",
        help: "How long until you expect to use this money?",
        choices: HORIZON,
      },
      {
        key: "expectedReturnRange",
        question: "What return range are you expecting?",
        help: "An expectation, not a promise — no page will claim these returns.",
        choices: EXPECTED_RETURN,
      },
      {
        key: "holdingPeriod",
        question: "How long do you typically hold an investment?",
        help: "Your usual selling horizon.",
        choices: HOLDING,
      },
      {
        key: "lossReaction",
        question: "If an investment fell sharply, what would you most likely do?",
        help: "A reflection of your stated comfort, not advice.",
        choices: LOSS_REACTION,
      },
      {
        key: "liquidityNeeds",
        question: "How important is easy access to your money?",
        help: "High liquidity needs usually pair with shorter-horizon assets.",
        choices: LIQUIDITY,
      },
      {
        key: "contributionFrequency",
        question: "How often do you plan to contribute?",
        help: "How frequently you expect to add capital.",
        choices: CONTRIBUTION,
      },
    ],
  },
  {
    title: "How will you use Prometheus?",
    subtitle:
      "Investors start right away. The other roles file a request that an admin must approve — nothing here grants access by itself.",
    fields: [],
    accountType: true,
  },
];

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

/**
 * The saved preferences, in the order the wizard asks for them.
 *
 * This is the only place preferences are summarised: the portfolio and the
 * dashboard read the ledger, and a chip row of half-remembered answers on
 * those pages was never backed by the profile the backend holds.
 */
const PREFERENCE_FIELDS: Array<{ key: keyof ProfileResponse; label: string }> = [
  { key: "experienceLevel", label: "Experience" },
  { key: "investmentCapitalRange", label: "Capital" },
  { key: "capitalAvailability", label: "Availability" },
  { key: "riskTolerance", label: "Risk" },
  { key: "drawdownComfort", label: "Drawdown" },
  { key: "volatilityComfort", label: "Volatility" },
  { key: "primaryGoal", label: "Goal" },
  { key: "timeHorizon", label: "Horizon" },
  { key: "expectedReturnRange", label: "Returns" },
  { key: "holdingPeriod", label: "Holding" },
  { key: "lossReaction", label: "If it drops" },
  { key: "liquidityNeeds", label: "Liquidity" },
  { key: "contributionFrequency", label: "Contributions" },
];

/**
 * The label the wizard uses for a stored value.
 *
 * The chip shows the same wording the choice button carried, so a chip and the
 * option it came from cannot drift apart. A value the wizard no longer offers
 * has no label and is skipped rather than shown raw.
 */
function labelFor(key: keyof ProfileResponse, value: string): string | null {
  for (const wizardStep of STEPS) {
    for (const field of wizardStep.fields) {
      if (field.key !== key) continue;
      return field.choices.find((choice) => choice.value === value)?.label ?? null;
    }
  }
  return null;
}

/** The answered preferences, as display pairs. Unanswered fields are absent. */
function savedPreferences(profile: ProfileResponse | null): Array<{ key: string; label: string }> {
  if (!profile) return [];
  const rows: Array<{ key: string; label: string }> = [];
  for (const entry of PREFERENCE_FIELDS) {
    const value = profile[entry.key];
    if (typeof value !== "string" || value.length === 0) continue;
    const label = labelFor(entry.key, value);
    if (!label) continue;
    rows.push({ key: entry.key, label: `${entry.label}: ${label}` });
  }
  return rows;
}

/** The saved preferences, as chips. Nothing shown until an answer exists. */
function PreferenceSummary({ profile }: { profile: ProfileResponse | null }) {
  const preferences = savedPreferences(profile);
  if (preferences.length === 0) return null;
  return (
    <section
      aria-label="Your preferences"
      className="mb-7 rounded-xl border border-[#222834] bg-[#14181F] p-4"
    >
      <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase">
        <ShieldCheck className="w-3.5 h-3.5" />
        Your preferences
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {preferences.map((preference) => (
          <span
            key={preference.key}
            className="rounded-full border border-[#FF5A1F]/30 bg-[#FF5A1F]/10 px-2.5 py-1 text-[11px] font-semibold text-[#FF8C42]"
          >
            {preference.label}
          </span>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-[#6B7280]">
        Saved on your Prometheus profile. Any answer can be changed in the steps below.
      </p>
    </section>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { heldRoles } = useRoles();
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [step, setStep] = useState<Step>(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  // Account-type step: held roles come from /rbac/me (useRoles.heldRoles — the
  // full grant set, not the persona-scoped one), pending requests from the
  // caller's own request history.
  const [history, setHistory] = useState<RoleRequest[]>([]);
  const [selectedType, setSelectedType] = useState<AccountTypeValue | null>(null);
  const [requesting, setRequesting] = useState<AccountTypeValue | null>(null);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const pendingRoles = new Set(
    history.filter((entry) => entry.status === "PENDING").map((entry) => entry.role),
  );

  useEffect(() => {
    let active = true;
    getMyProfile()
      .then((result) => {
        if (!active) return;
        setProfile(result);
        if (result.onboardingCompletedAt) setCompleted(true);
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

  useEffect(() => {
    let active = true;
    listMyRoleRequests()
      .then((result) => {
        if (active) setHistory(result);
      })
      .catch(() => {
        // Absent history only removes badges; the POST below still tells the
        // truth via its 409, so a failed history read is not worth an error.
        if (active) setHistory([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const reloadHistory = (): Promise<void> =>
    listMyRoleRequests()
      .then((result) => setHistory(result))
      .catch(() => undefined);

  const chooseAccountType = async (choice: AccountType): Promise<void> => {
    setRequestError(null);
    setRequestMessage(null);

    if (!choice.role) {
      setSelectedType(choice.value);
      return;
    }

    // "Already holds" is a fact about the *account*, not this session's
    // persona: a user who signed in as Normal User still holds their
    // EXPERT_TRADER grant and must not be offered to request it again.
    if (heldRoles.includes(choice.role)) {
      setSelectedType(choice.value);
      setRequestMessage(`You already hold the ${choice.label} role.`);
      return;
    }

    if (pendingRoles.has(choice.role)) {
      setSelectedType(choice.value);
      setRequestMessage("Your request for this role is already awaiting admin approval.");
      return;
    }

    setRequesting(choice.value);
    try {
      await createRoleRequest({ role: choice.role });
      setSelectedType(choice.value);
      setRequestMessage("Request submitted — an admin reviews it before the role unlocks.");
      await reloadHistory();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // Already held or already pending: the outcome the user wanted, so
        // accept it and let the refreshed history show the real state.
        setSelectedType(choice.value);
        setRequestMessage(cause.message);
        await reloadHistory();
      } else {
        // Nothing was requested, so the choice is not recorded — the user
        // picks again (or picks the investor path) instead of being told a
        // request exists when it does not.
        setRequestError(messageFor(cause));
      }
    } finally {
      setRequesting(null);
    }
  };

  const saveField = async (key: keyof ProfileResponse, value: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMyProfile({ [key]: value } as Partial<ProfileResponse>);
      setProfile(updated);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  };

  const finish = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await completeOnboarding();
      setProfile(updated);
      setCompleted(true);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
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

  if (completed) {
    return (
      <AppShell>
        <div className="max-w-lg mx-auto p-6 mt-16 text-center">
          <CheckCircle2 className="w-12 h-12 text-[#00D26A] mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">You are all set</h1>
          <p className="mt-2 text-sm text-[#9CA3AF]">
            Your preferences are saved. You can revise them any time from Preferences.
          </p>
          <div className="mt-6 text-left">
            <PreferenceSummary profile={profile} />
          </div>
          {selectedType && selectedType !== "INVESTOR" && (
            <p className="mt-3 text-xs text-[#F59E0B]">
              Your{" "}
              {selectedType === "EXPERT_TRADER" ? "Expert Trader" : "Liquidity Provider"}{" "}
              request is awaiting admin approval — the sidebar entry unlocks once an admin
              approves it.
            </p>
          )}
          <button
            onClick={() => router.push("/")}
            className="mt-6 inline-flex items-center gap-2 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors"
          >
            Go to dashboard
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </AppShell>
    );
  }

  const current = STEPS[step] ?? STEPS[0]!;

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto p-6">
        {/* Progress */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s, index) => (
            <div
              key={s.title}
              className={`h-1.5 flex-1 rounded-full ${
                index <= step ? "bg-[#FF5A1F]" : "bg-[#222834]"
              }`}
            />
          ))}
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
            <ShieldCheck className="w-3.5 h-3.5" />
            Step {step + 1} of {STEPS.length}
          </div>
          <h1 className="text-2xl font-bold text-white">{current.title}</h1>
          <p className="mt-1 text-sm text-[#9CA3AF]">{current.subtitle}</p>
        </div>

        <PreferenceSummary profile={profile} />

        {error && (
          <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
            <AlertTriangle className="w-4 h-4 inline mr-2" />
            {error}
          </div>
        )}

        <div className="space-y-8">
          {current.fields.map((field) => (
            <fieldset key={field.key}>
              <legend className="text-sm font-semibold text-white mb-1">{field.question}</legend>
              <p className="text-xs text-[#6B7280] mb-3">{field.help}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {field.choices.map((choice) => {
                  const selected = profile?.[field.key] === choice.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      disabled={saving}
                      onClick={() => void saveField(field.key, choice.value)}
                      className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors ${
                        selected
                          ? "border-[#FF5A1F] bg-[#FF5A1F]/10 text-white"
                          : "border-[#222834] bg-[#14181F] text-[#9CA3AF] hover:border-[#323B4C] hover:text-white"
                      }`}
                    >
                      <div className="text-sm font-medium">{choice.label}</div>
                      {choice.hint && (
                        <div className="text-xs text-[#6B7280] mt-0.5">{choice.hint}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        {current.accountType && (
          <div className="space-y-3">
            <p className="text-xs text-[#6B7280]">
              This decides which parts of Prometheus appear in your sidebar. You can request a
              different role later from Preferences — an admin reviews every request.
            </p>

            {ACCOUNT_TYPES.map((choice) => {
              const selected = selectedType === choice.value;
              const held = choice.role !== null && heldRoles.includes(choice.role);
              const pending = choice.role !== null && pendingRoles.has(choice.role);
              const busy = requesting === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  disabled={requesting !== null}
                  onClick={() => void chooseAccountType(choice)}
                  className={`w-full text-left rounded-lg border px-4 py-3 transition-colors disabled:opacity-60 ${
                    selected
                      ? "border-[#FF5A1F] bg-[#FF5A1F]/10"
                      : "border-[#222834] bg-[#14181F] hover:border-[#323B4C]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{choice.label}</span>
                        {held && (
                          <span className="px-1.5 py-0.5 rounded bg-[#00D26A]/15 border border-[#00D26A]/40 text-[10px] font-bold text-[#00D26A]">
                            ACTIVE
                          </span>
                        )}
                        {!held && pending && (
                          <span className="px-1.5 py-0.5 rounded bg-[#F59E0B]/15 border border-[#F59E0B]/40 text-[10px] font-bold text-[#F59E0B]">
                            AWAITING APPROVAL
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[#6B7280] mt-1">{choice.hint}</div>
                    </div>
                    <div className="shrink-0 pt-0.5">
                      {busy ? (
                        <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
                      ) : selected ? (
                        <CheckCircle2 className="w-4 h-4 text-[#00D26A]" />
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })}

            {requestMessage && (
              <div className="rounded-lg border border-[#00D26A]/40 bg-[#00D26A]/10 p-2.5 text-xs text-[#00D26A]">
                <CheckCircle2 className="w-3.5 h-3.5 inline mr-1.5" />
                {requestMessage}
              </div>
            )}
            {requestError && (
              <div className="rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-2.5 text-xs text-[#EF4444]">
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
                {requestError}
              </div>
            )}
            {!selectedType && (
              <p className="text-xs text-[#F59E0B]">
                Pick how you&apos;ll use Prometheus to finish onboarding.
              </p>
            )}
          </div>
        )}

        <div className="mt-10 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setStep((value) => (value === 0 ? 0 : (value - 1) as Step))}
            disabled={step === 0 || saving}
            className="text-sm text-[#9CA3AF] hover:text-white disabled:opacity-40"
          >
            Back
          </button>

          <div className="flex items-center gap-3">
            {saving && (
              <span className="flex items-center gap-1.5 text-xs text-[#6B7280]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving…
              </span>
            )}

            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep((value) => (value + 1) as Step)}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finish()}
                disabled={saving || selectedType === null}
                className="inline-flex items-center gap-2 bg-[#00D26A] hover:bg-[#00B85C] text-[#0B0D10] px-5 py-2.5 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
              >
                Finish onboarding
                <CheckCircle2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
