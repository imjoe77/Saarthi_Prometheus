import "server-only";

import NextAuth, { type Session } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

import { getGitHubProviderConfig, getGoogleProviderConfig } from "@/lib/auth-env";

/**
 * MODULE 02 — Auth.js configuration.
 *
 * This file is the *only* place OAuth exists in Prometheus. It runs the redirect
 * dance with Google and GitHub, keeps a session in an opaque encrypted cookie,
 * and nothing else. It never touches the database and never calls the NestJS
 * service; the two halves meet only at the signed access token minted in
 * `lib/api-token.ts`.
 *
 * The session strategy is JWT, and that is a deliberate trade-off:
 *
 *  - No session database, so no extra table to migrate, secure, or keep coherent
 *    across instances. For a prototype that is the smaller surface.
 *  - The cost is that logout is client-side. Clearing the cookie ends the session
 *    for that browser, but a token copied out beforehand stays usable until it
 *    expires. That is why the access token handed to the backend is deliberately
 *    short-lived and separate from this session - it is not the session.
 *
 * The provider credentials are read at first use rather than at module load, so
 * importing this module does not require a complete OAuth configuration. The
 * reason is a build that should not fail: the marketing routes reach this file
 * through `lib/dal.ts` and need none of it.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // Stateless: the cookie carries the session, signed by AUTH_SECRET.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  // Trust the host headers rather than a hard-coded value, so the same build
  // works on localhost and behind a proxy.
  trustHost: true,
  providers: [Google(getGoogleProviderConfig()), GitHub(getGitHubProviderConfig())],
  callbacks: {
    /**
     * Stores the provider's identifiers, and the login-intent role.
     *
     * `account` is present only on the request that performs the sign-in, so the
     * values are copied into `token` once and survive every later request. The
     * composite `provider:providerAccountId` form is what the backend joins
     * against `auth_accounts`.
     *
     * `loginRole` arrives on a later `useSession().update({ loginRole })` from
     * the login funnel, where the visitor picked the persona they want to act
     * as (MODULE 13). It is validated here - only the four known personas are
     * stored, so a client cannot write an arbitrary string and have it minted
     * into an access token. Its only power downstream is to *narrow* the
     * account's database roles, so accepting PLATFORM_ADMIN here costs
     * nothing: an account without the admin row intersects to no roles at all,
     * and an account with it could already reach the admin surface unscoped.
     *
     * Note what is *not* derived from the OAuth profile afterwards: Google lets a
     * user change their email, and a Prometheus user must not follow it. The
     * identity is frozen at first sign-in.
     */
    jwt({ token, account, trigger, session }) {
      if (account) {
        token.externalIdentity = `${account.provider}:${account.providerAccountId}`;
        token.provider = account.provider;
      }

      // `trigger: "update"` is the client-initiated `useSession().update()`
      // path. `session` here is whatever the client passed; treat it as
      // untrusted input and copy across only a recognised persona role.
      if (trigger === "update" && session && typeof session === "object") {
        const requested = (session as { loginRole?: unknown }).loginRole;
        if (isPersonaRole(requested)) {
          token.loginRole = requested;
        }
      }

      return token;
    },

    /**
     * Exposes the session to server components.
     *
     * Deliberately narrow: `externalIdentity` because the BFF needs it to mint an
     * access token, and `loginRole` because the same mint must be scoped to the
     * persona the visitor signed in as. Nothing else about the credential chain
     * is here - the Prometheus user id is *not*; it lives in the backend, which
     * is the only party that may resolve an identity to a user.
     */
    session({ session, token }) {
      if (token.externalIdentity) {
        session.externalIdentity = token.externalIdentity;
      }
      if (token.provider) {
        session.provider = token.provider;
      }
      if (token.loginRole) {
        session.loginRole = token.loginRole;
      }

      return session;
    },
  },
  pages: {
    // No custom pages yet: Auth.js renders its own sign-in and error pages, which
    // is one less thing to get wrong in a security-critical path.
    error: "/api/auth/error",
  },
}));

/** A session known to carry a provider identity. */
export interface AuthenticatedSession extends Session {
  externalIdentity: string;
  provider?: string;
}

/**
 * Narrows a session to an authenticated one.
 *
 * Expresses the check once so callers do not each re-derive it. Note the shape:
 * `Session` with the identity claims required, rather than a bare string, because
 * a session without them is not usable and should not typecheck.
 */
export function isAuthenticatedSession(
  session: Session | null | undefined,
): session is AuthenticatedSession {
  return typeof session?.externalIdentity === "string" && session.externalIdentity.length > 0;
}

/** The roles a session may name as its login intent. */
export type PersonaRole = "USER" | "EXPERT_TRADER" | "LIQUIDITY_PROVIDER" | "PLATFORM_ADMIN";

const PERSONA_ROLES: readonly string[] = [
  "USER",
  "EXPERT_TRADER",
  "LIQUIDITY_PROVIDER",
  "PLATFORM_ADMIN",
];

/**
 * Whether a value is a persona role the login funnel may set.
 *
 * PLATFORM_ADMIN is included because the Platform Admin card is a persona like
 * any other: clicking it must scope the session to the admin surface alone.
 * This check is still the server-side gate against arbitrary values, and the
 * claim it lets through remains narrowing-only — the backend intersects it
 * with the roles the database actually holds, so a session that does not
 * belong to an admin narrows to nothing rather than widening.
 */
export function isPersonaRole(value: unknown): value is PersonaRole {
  return typeof value === "string" && (PERSONA_ROLES as readonly string[]).includes(value);
}