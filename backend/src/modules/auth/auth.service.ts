import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Role, type User } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import type { VerifiedIdentity } from './token-verifier.service';

/**
 * The authenticated caller, as the rest of the application sees them.
 *
 * `id` is the internal Prometheus UUID. Downstream modules reference this and
 * never a provider id, which is what keeps a Google or GitHub account id from
 * leaking into business data or into a database foreign key.
 *
 * `heldRoles` is every role the database has granted this account (USER,
 * EXPERT_TRADER, LIQUIDITY_PROVIDER, PLATFORM_ADMIN), loaded from `user_roles`
 * on every resolve. `activeRole` is the role this session signed in *as*, when
 * the access token carried a login-intent claim (MODULE 13). `roles` is the
 * effective set every authorization decision uses: the held roles narrowed to
 * the active one — and to that one alone, so the persona the visitor picked on
 * the login card is exactly the surface this session can reach.
 *
 * Roles are authorization data, not part of the frozen `GET /auth/me` response
 * shape; use `GET /rbac/me` to surface them.
 */
export interface AuthContext {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly externalIdentity: string;
  readonly provider: string;
  /** Effective roles: `heldRoles` narrowed by `activeRole` (see {@link narrowRoles}). */
  readonly roles: string[];
  /** Every role the account holds, before any session narrowing. */
  readonly heldRoles: string[];
  /** The persona this session signed in as, or `null` for an unscoped session. */
  readonly activeRole: Role | null;
}

/**
 * Narrows a held-role set to a session's active (login-intent) role.
 *
 * The rule is an intersection and nothing more — it can only ever remove
 * roles, never add one the account does not hold:
 *
 *   - No active role (old session, or no persona picked) → everything held.
 *   - Otherwise → the active role itself, if held, and nothing else. No role
 *     is privileged against narrowing: PLATFORM_ADMIN is a persona like the
 *     rest, so an admin who signs in as Normal User sees only the normal
 *     surface, and the admin surface opens only when the admin card was the
 *     one clicked (MODULE 13's "one click, one surface" rule).
 *
 * So a Gmail account holding USER + EXPERT_TRADER + LIQUIDITY_PROVIDER that
 * signs in as "normal user" behaves as USER only for the whole session — and
 * likewise for every other persona. A claim the account does not hold narrows
 * to the empty set, which fails closed: the session may reach nothing.
 */
export function narrowRoles(heldRoles: string[], activeRole: Role | null): string[] {
  if (!activeRole) {
    return [...heldRoles];
  }

  return heldRoles.filter((role) => role === activeRole);
}

/**
 * Test-fixture role granted on every resolveIdentity when
 * `NODE_ENV === 'test'` and `RBAC_TEST_DEFAULT_ROLES=EXPERT_TRADER` (set by the
 * e2e setup for suites that call frozen strategy-creation endpoints). Keeps
 * pre-RBAC call sites working without editing frozen tests; production code is
 * hard-gated on `NODE_ENV==='test'`, so a misconfigured env var in a real
 * deployment can never grant a role.
 *
 * The env var is read per call rather than captured at import time so a suite
 * that must observe a *revoked* role can suspend the fixture around its own
 * requests (`withoutFixture` in the RBAC e2e spec) without editing this gate.
 */
function testFixtureRole(): 'EXPERT_TRADER' | null {
  return process.env.NODE_ENV === 'test' &&
    process.env.RBAC_TEST_DEFAULT_ROLES === 'EXPERT_TRADER'
    ? 'EXPERT_TRADER'
    : null;
}

/**
 * Maps an external identity onto a Prometheus user.
 *
 * The join key is `auth_accounts` (provider, provider_account_id), NOT the
 * email address. Two provider identities that happen to share an email string
 * are still two identities, and OAuth gives no basis for merging them: a Google
 * email is verified by Google, GitHub's is verified by GitHub. Linking on email
 * would let whoever controls the weaker provider's account claim the stronger
 * one's Prometheus user.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a verified identity to an ACTIVE Prometheus user, creating the
   * user on first login.
   *
   * Order matters:
   *  1. Look up the AuthAccount. A hit is the only path that may resolve an
   *     existing user.
   *  2. On a miss, decide whether a new user is warranted. It is NOT warranted
   *     when a Prometheus user already holds this email - that is the
   *     second-provider-login case, and it requires explicit linking.
   *  3. Otherwise create User + AuthAccount atomically.
   *
   * No Wallet is created here. `User.wallet` is nullable in the schema, so a
   * user without one is a valid, expected state, and provisioning one is
   * Module 03's decision about its own domain - not an authentication concern.
   */
  async resolveIdentity(identity: VerifiedIdentity): Promise<AuthContext> {
    const account = await this.prisma.authAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: identity.provider,
          providerAccountId: identity.providerAccountId,
        },
      },
      include: { user: true },
    });

    if (account) {
      return await this.toContext(account.user, identity);
    }

    return this.onFirstLogin(identity);
  }

  /**
   * Loads the user's granted role names from `user_roles`, applying the
   * test-only default fixture role if configured. Used by both the existing-
   * user and first-login paths so every AuthContext carries roles.
   *
   * The baseline `USER` row is also ensured here, not only at account
   * creation: `user_roles` rows can be missing for accounts that predate the
   * RBAC migration (observed in development when a duplicate migration record
   * wiped the backfill), and every account is defined to hold `USER`. The
   * write only fires when the row is absent, so a healthy account still pays
   * one read and nothing else.
   */
  private async loadRoles(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: true },
      orderBy: { role: 'asc' },
    });

    const roles = new Set(rows.map((row) => row.role));

    if (!roles.has(Role.USER)) {
      await this.prisma.userRole.upsert({
        where: { userId_role: { userId, role: Role.USER } },
        create: { userId, role: Role.USER },
        update: {},
      });
      roles.add(Role.USER);
    }

    const fixtureRole = testFixtureRole();
    if (fixtureRole && !roles.has(fixtureRole)) {
      await this.prisma.userRole.upsert({
        where: { userId_role: { userId, role: fixtureRole } },
        create: { userId, role: fixtureRole },
        update: {},
      });
      roles.add(fixtureRole);
    }

    return [...roles].sort();
  }

  private async onFirstLogin(identity: VerifiedIdentity): Promise<AuthContext> {
    // An OAuth provider may omit the email, and Prometheus requires one for a
    // user row. Fail explicitly rather than inventing a placeholder address.
    if (!identity.email) {
      throw new DomainException(
        ERROR_CODES.FORBIDDEN,
        'Your account provider did not share an email address, so a Prometheus account cannot be created. ' +
          'Add an email address to your provider account and try again.',
        HttpStatus.FORBIDDEN,
      );
    }

    const email = identity.email.toLowerCase();

    const existingUser = await this.prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      // Deliberately not auto-linking. Logged so an operator can see it, and
      // surfaced as a conflict rather than silently succeeding or silently
      // creating a duplicate Prometheus user for the same person.
      this.logger.warn(
        `Provider login for an email that already has a Prometheus user. Not auto-linking. ` +
          `provider=${identity.provider} userId=${existingUser.id}`,
      );

      throw new DomainException(
        ERROR_CODES.CONFLICT,
        'An account already exists for this email address with a different sign-in provider. ' +
          'Account linking is not available yet.',
        HttpStatus.CONFLICT,
      );
    }

    // The unique constraints on users.email and
    // auth_accounts(provider, provider_account_id) are the real guarantee
    // against duplicates: a concurrent first login loses here rather than
    // producing a second user. The USER role is granted in the same
    // transaction so a brand-new account is never momentarily roleless.
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, authUserId: identity.externalIdentity },
      });

      await tx.authAccount.create({
        data: {
          userId: created.id,
          provider: identity.provider,
          providerAccountId: identity.providerAccountId,
          providerEmail: identity.email,
          label: identity.provider,
        },
      });

      await tx.userRole.create({
        data: { userId: created.id, role: 'USER' },
      });

      return created;
    });

    this.logger.log(`Created Prometheus user on first login. userId=${user.id} provider=${identity.provider}`);

    const heldRoles = await this.loadRoles(user.id);

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      externalIdentity: identity.externalIdentity,
      provider: identity.provider,
      heldRoles,
      roles: narrowRoles(heldRoles, identity.loginRole),
      activeRole: identity.loginRole,
    };
  }

  /**
   * Builds the request-scoped context and enforces `User.status`.
   *
   * Authentication (who you are) and authorization (may you act) are separate
   * decisions. The guard proves the former; this decides the latter for the
   * account's own lifecycle state. Per-resource ownership checks belong to the
   * module that owns that resource. Roles are loaded here so every request
   * reflects the current grant state with no cache to invalidate.
   */
  private async toContext(user: User, identity: VerifiedIdentity): Promise<AuthContext> {
    if (user.status !== 'ACTIVE') {
      // One message for SUSPENDED and CLOSED alike. Distinguishing them would
      // let a caller holding a valid token enumerate which email addresses
      // exist on the platform and what state they are in.
      throw new DomainException(
        ERROR_CODES.FORBIDDEN,
        'This account is not permitted to use Prometheus.',
        HttpStatus.FORBIDDEN,
      );
    }

    const heldRoles = await this.loadRoles(user.id);

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      externalIdentity: identity.externalIdentity,
      provider: identity.provider,
      heldRoles,
      roles: narrowRoles(heldRoles, identity.loginRole),
      activeRole: identity.loginRole,
    };
  }
}