import { Role } from '@prisma/client';

/**
 * MODULE 13 - the email allowlist that decides who may sign in as an Expert
 * Trader, a Liquidity Provider or a Platform Admin.
 *
 * Authorization is configuration, not a UI affordance: the e-mail addresses
 * allowed to hold each privileged role are declared in the environment and
 * read here, at the backend, which is the only party that may decide who a
 * Prometheus user is. Selecting a role card on the login page grants nothing
 * by itself - a non-allowlisted caller is refused, while an allowlisted one
 * has the role granted at first use (see `RbacService.requestRole`).
 *
 * PLATFORM_ADMIN is listed here for the same reason as the other two: admin
 * access is granted by configuration only. There is no admin grant anywhere in
 * the HTTP API (`RbacService.grantRole` refuses it) - an address must appear in
 * `PLATFORM_ADMIN_EMAILS` before the login funnel may ever acquire it, and the
 * operator CLI remains the only way to grant it to an address that is not
 * listed at sign-in time.
 *
 * The lists are read from `process.env` per call rather than injected at
 * module load so a configuring operator sees a change on the next process
 * start without a stale module capture. Addresses are trimmed and compared
 * case-insensitively; an empty variable means nobody may self-authorize that
 * role (the deliberate default: the allowlist is an explicit act).
 */

/** The environment variable holding the allowlist for a role. */
const EMAILS_VAR_BY_ROLE: Partial<Record<Role, string>> = {
  [Role.EXPERT_TRADER]: 'EXPERT_TRADER_EMAILS',
  [Role.LIQUIDITY_PROVIDER]: 'LIQUIDITY_PROVIDER_EMAILS',
  [Role.PLATFORM_ADMIN]: 'PLATFORM_ADMIN_EMAILS',
};

/** Parses a comma-separated email list; empty and malformed entries are dropped. */
function parseList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** true when the address is on the allowlist for this role. */
export function isEmailAuthorized(email: string | null | undefined, role: Role): boolean {
  if (!email) {
    return false;
  }

  const variable = EMAILS_VAR_BY_ROLE[role];
  if (!variable) {
    // USER is held by every account and has no allowlist of its own; every
    // privileged role is listed above, so this branch is the baseline role.
    return false;
  }

  return parseList(process.env[variable]).includes(email.trim().toLowerCase());
}
