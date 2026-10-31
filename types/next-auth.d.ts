/**
 * MODULE 02 — Auth.js type augmentation.
 *
 * Auth.js v5 has no built-in slot for "which provider identity is this?", so the
 * two custom claims are declared here rather than cast at every call site.
 *
 * These live in their own file, and it is not cosmetic: TypeScript module
 * augmentation only takes effect from a file that is part of the program. Putting
 * `declare module` inside `lib/auth.ts` works only while that file is the one
 * being compiled, and silently stops applying to consumers once it is
 * reorganised. A dedicated `.d.ts` under `include` cannot drift that way.
 *
 * `externalIdentity` is `provider:providerAccountId`, e.g. `google:109876543210`.
 * It is the join key the backend resolves against `auth_accounts` - never an
 * authority in itself, and never something the browser can set.
 */
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** Present only when the session was established through an OAuth provider. */
    externalIdentity?: string;
    provider?: string;
    /**
     * The persona this session signed in as (MODULE 13), set through
     * `useSession().update({ loginRole })` at the login funnel. Absent when no
     * persona was picked, which means the session acts as every held role.
     * May be PLATFORM_ADMIN for the Platform Admin card; it still only narrows
     * the roles the backend loads from the database.
     */
    loginRole?: PersonaRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    externalIdentity?: string;
    provider?: string;
    loginRole?: PersonaRole;
  }
}

/**
 * Roles a session may name as its login intent. Declared inline (rather than
 * imported from `lib/auth.ts`) so this type-only module carries no import of a
 * `server-only` module into client compilation.
 */
type PersonaRole = "USER" | "EXPERT_TRADER" | "LIQUIDITY_PROVIDER" | "PLATFORM_ADMIN";

export {};