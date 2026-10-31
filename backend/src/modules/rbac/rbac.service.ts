import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, RoleRequestStatus } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { isEmailAuthorized } from './email-allowlist';

/** Roles a user may request through the self-serve request flow. */
export const REQUESTABLE_ROLES: readonly Role[] = [Role.EXPERT_TRADER, Role.LIQUIDITY_PROVIDER];

/**
 * Every privileged role an account may acquire through the login funnel.
 *
 * `USER` is excluded (it is baseline, granted to everyone) and this set is
 * what the one-privileged-role-per-account rule counts: a Gmail address may
 * hold at most one of them. PLATFORM_ADMIN joins the set even though it is
 * never *queueable* - it is granted from configuration (`PLATFORM_ADMIN_EMAILS`)
 * and never waits for an approval, but it still occupies the account's single
 * elevated slot.
 */
export const ELEVATED_ROLES: readonly Role[] = [
  Role.EXPERT_TRADER,
  Role.LIQUIDITY_PROVIDER,
  Role.PLATFORM_ADMIN,
];

/** Human labels for the refusal messages (mirrors the frontend's ROLE_LABELS). */
const ROLE_LABEL: Record<Role, string> = {
  [Role.USER]: 'Normal User',
  [Role.EXPERT_TRADER]: 'Expert Trader',
  [Role.LIQUIDITY_PROVIDER]: 'Liquidity Provider',
  [Role.PLATFORM_ADMIN]: 'Platform Admin',
};

/**
 * The elevated role (other than `requested`) the account already holds, if any.
 *
 * Pure so both decision points - `GET /rbac/authorize` (which already knows the
 * held set) and `requestRole` (which reloads it) - answer the same question
 * from the same code, and so the rule is unit-testable without a database.
 */
export function conflictingHeldRole(
  heldRoles: readonly string[],
  requested: Role,
): Role | null {
  if (!ELEVATED_ROLES.includes(requested)) {
    return null;
  }
  return ELEVATED_ROLES.find((role) => role !== requested && heldRoles.includes(role)) ?? null;
}

/**
 * The refusal message for an account that already holds a different elevated
 * role. This is the "one Gmail, one role" error: the login funnel surfaces it
 * through the existing denial flow, so the visitor is told plainly to try a
 * different account rather than being left with a generic failure.
 */
export function oneRoleRefusalReason(heldRole: Role, requested: Role): string {
  return (
    `This account already has ${ROLE_LABEL[heldRole]} access, and one Gmail address may hold only ` +
    `one privileged role. Try a different account for ${ROLE_LABEL[requested]}.`
  );
}

/**
 * Role lookup, grant/revoke and the role-request workflow.
 *
 * Three safety rules live here rather than in the controllers:
 *
 *  1. PLATFORM_ADMIN is never granted through any authenticated HTTP grant
 *     path - the admin API refuses it (`grantRole`) and a PLATFORM_ADMIN
 *     request is never queued for approval. The only way an account acquires
 *     it through the API is the login funnel auto-approving an address that
 *     `PLATFORM_ADMIN_EMAILS` lists; the operator CLI remains the other way.
 *  2. One privileged role per account: an account that already holds an
 *     elevated role may not acquire a different one (see
 *     `conflictingHeldRole`). The rule fires before the allowlist so the
 *     refusal names the real reason instead of a generic "not approved".
 *  3. Every privileged grant/revoke/approval writes an admin audit row in the
 *     same transaction, so the authorization trail cannot drift from the
 *     state it describes.
 *
 * Privileged roles additionally carry an email allowlist (Module 13): only
 * addresses listed in `EXPERT_TRADER_EMAILS` / `LIQUIDITY_PROVIDER_EMAILS` /
 * `PLATFORM_ADMIN_EMAILS` may self-authorize, and for those the request is
 * approved and the role granted at once - inside the granting transaction, so
 * the request state can never disagree with the role it produced.
 */
@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether this address may self-authorize the given privileged role. */
  isEmailAuthorized(email: string, role: Role): boolean {
    return isEmailAuthorized(email, role);
  }

  /** The caller's granted roles, as a stable name list. */
  async rolesOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: true },
      orderBy: { role: 'asc' },
    });
    return rows.map((row) => row.role);
  }

  /**
   * Grants a role if the user does not already hold it, writing an audit row.
   * Idempotent: re-granting an existing role is a no-op that still audits the
   * attempt only when something changed.
   */
  async grantRole(
    actorUserId: string | null,
    targetUserId: string,
    role: Role,
    action: string,
  ): Promise<void> {
    if (role === Role.PLATFORM_ADMIN) {
      // Defence in depth: the HTTP layer never passes this, but the service
      // refuses it anyway so a future controller cannot accidentally open it.
      throw new DomainException(
        ERROR_CODES.FORBIDDEN,
        'PLATFORM_ADMIN cannot be granted through the API. Use the operator CLI.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userRole.findUnique({
        where: { userId_role: { userId: targetUserId, role } },
      });

      if (!existing) {
        await tx.userRole.create({
          data: { userId: targetUserId, role, grantedBy: actorUserId },
        });

        await tx.adminAuditLog.create({
          data: {
            actorUserId: actorUserId ?? targetUserId,
            action,
            targetUserId,
            detail: { role },
          },
        });
      }
    });
  }

  /** Revokes a role, auditing the change. USER cannot be revoked. */
  async revokeRole(actorUserId: string, targetUserId: string, role: Role): Promise<void> {
    if (role === Role.USER) {
      throw new DomainException(
        ERROR_CODES.VALIDATION_FAILED,
        'The baseline USER role cannot be revoked.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userRole.findUnique({
        where: { userId_role: { userId: targetUserId, role } },
      });

      if (existing) {
        await tx.userRole.delete({
          where: { userId_role: { userId: targetUserId, role } },
        });

        await tx.adminAuditLog.create({
          data: {
            actorUserId,
            action: 'role.revoke',
            targetUserId,
            detail: { role },
          },
        });
      }
    });
  }

  /**
   * Submits a role request. Rejects roles that cannot be requested.
   *
   * For an email on the role's allowlist the flow short-circuits: the request
   * is created (or, if one is already PENDING, reused), approved and the role
   * granted inside one transaction, so an authorized caller never waits for a
   * human step the configuration has already performed. `grantedBy` stays
   * null deliberately - the authorization came from configuration, not from
   * a person - and the audit row records the allowlist as the origin.
   *
   * PLATFORM_ADMIN is accepted here (it is one of {@link ELEVATED_ROLES}) but
   * is never queued: without the `PLATFORM_ADMIN_EMAILS` listing the request
   * is refused outright, because a pending admin request would put an admin
   * grant behind the ordinary approval queue - which is exactly what rule 1
   * of this class forbids.
   *
   * The allowlist is consulted BEFORE the pending-request conflict below, so an
   * authorized address always resolves to its role. Ordering matters: a request
   * submitted while the address was not yet allowlisted legitimately queued for
   * admin approval, and once the operator lists the address that configuration -
   * not the stale queue entry - must decide the outcome. Evaluating the pending
   * conflict first would let that obsolete PENDING row shadow the allowlist
   * forever, refusing the caller with CONFLICT and never firing the grant.
   *
   * The one-role rule (rule 2) runs before the allowlist so an account that
   * already holds a different elevated role is refused with the reason that
   * actually applies - "try a different account" - rather than with an
   * allowlist answer about an address that was never the problem.
   */
  async requestRole(
    caller: { id: string; email: string },
    role: Role,
    note?: string,
  ): Promise<{ id: string }> {
    const isAdminRole = role === Role.PLATFORM_ADMIN;
    if (!isAdminRole && !REQUESTABLE_ROLES.includes(role)) {
      throw new DomainException(
        ERROR_CODES.VALIDATION_FAILED,
        'Only EXPERT_TRADER and LIQUIDITY_PROVIDER can be requested.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // One read covers both the "already hold this role" conflict and the
    // one-role rule: the elevated set is at most three rows per account.
    const heldRows = await this.prisma.userRole.findMany({
      where: { userId: caller.id, role: { in: [...ELEVATED_ROLES] } },
      select: { role: true },
    });
    const heldRoles = heldRows.map((row) => row.role);

    if (heldRoles.includes(role)) {
      throw new DomainException(
        ERROR_CODES.CONFLICT,
        'You already hold this role.',
        HttpStatus.CONFLICT,
      );
    }

    const conflict = conflictingHeldRole(heldRoles, role);
    if (conflict) {
      throw new DomainException(
        ERROR_CODES.FORBIDDEN,
        oneRoleRefusalReason(conflict, role),
        HttpStatus.FORBIDDEN,
      );
    }

    // Admin is configuration-only: an address that `PLATFORM_ADMIN_EMAILS`
    // does not list is refused here rather than queued for approval, so no
    // path through this method can produce a PENDING PLATFORM_ADMIN request.
    if (isAdminRole && !isEmailAuthorized(caller.email, Role.PLATFORM_ADMIN)) {
      throw new DomainException(
        ERROR_CODES.FORBIDDEN,
        'Platform Admin access is granted by configuration only (PLATFORM_ADMIN_EMAILS). ' +
          'Try a different account if this address is not listed there.',
        HttpStatus.FORBIDDEN,
      );
    }

    // The allowlist is evaluated before any PENDING-request conflict, so an
    // authorized address always resolves to its role. The ordering matters: a
    // request submitted while the address was NOT yet allowlisted legitimately
    // queued for admin approval, but once the operator lists the address that
    // configuration - not the stale queue entry - must decide the outcome.
    // Otherwise the earlier PENDING row would shadow the allowlist forever and
    // the grant would never fire. An allowlisted caller re-submitting therefore
    // adopts and approves their own pending request instead of being refused.
    if (isEmailAuthorized(caller.email, role)) {
      const pending = await this.prisma.roleRequest.findFirst({
        where: { userId: caller.id, role, status: RoleRequestStatus.PENDING },
      });

      let requestId = '';
      await this.prisma.$transaction(async (tx) => {
        if (pending) {
          requestId = pending.id;
        } else {
          const created = await tx.roleRequest.create({
            data: { userId: caller.id, role, note: note ?? null },
          });
          requestId = created.id;
        }

        await tx.userRole.upsert({
          where: { userId_role: { userId: caller.id, role } },
          create: { userId: caller.id, role, grantedBy: null },
          update: {},
        });

        await tx.roleRequest.update({
          where: { id: requestId },
          data: { status: RoleRequestStatus.APPROVED, decidedBy: caller.id, decidedAt: new Date() },
        });

        await tx.adminAuditLog.create({
          data: {
            actorUserId: caller.id,
            action: 'role_request.approve',
            targetUserId: caller.id,
            detail: { requestId, role, via: 'email-allowlist' },
          },
        });
      });

      return { id: requestId };
    }

    const pending = await this.prisma.roleRequest.findFirst({
      where: { userId: caller.id, role, status: RoleRequestStatus.PENDING },
    });

    if (pending) {
      throw new DomainException(
        ERROR_CODES.CONFLICT,
        'You already have a pending request for this role.',
        HttpStatus.CONFLICT,
      );
    }

    const created = await this.prisma.roleRequest.create({
      data: { userId: caller.id, role, note: note ?? null },
    });

    return { id: created.id };
  }

  /** The caller's own request history, newest first. */
  async myRequests(userId: string): Promise<
    Array<{ id: string; role: string; status: string; note: string | null; createdAt: Date; decidedAt: Date | null }>
  > {
    const rows = await this.prisma.roleRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      status: row.status,
      note: row.note,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    }));
  }

  /** Admin view of the request queue. */
  async listRequests(status?: RoleRequestStatus): Promise<
    Array<{
      id: string;
      role: string;
      status: string;
      note: string | null;
      createdAt: Date;
      decidedAt: Date | null;
      user: { id: string; email: string };
    }>
  > {
    const rows = await this.prisma.roleRequest.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      status: row.status,
      note: row.note,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      user: row.user,
    }));
  }

  /** Approves or rejects a pending request, granting the role atomically. */
  async decideRequest(
    actorUserId: string,
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await tx.roleRequest.findUnique({ where: { id: requestId } });

      if (!request) {
        throw new DomainException(ERROR_CODES.NOT_FOUND, 'Role request not found.', HttpStatus.NOT_FOUND);
      }

      if (request.status !== RoleRequestStatus.PENDING) {
        throw new DomainException(
          ERROR_CODES.CONFLICT,
          'This request has already been decided.',
          HttpStatus.CONFLICT,
        );
      }

      if (decision === 'APPROVED' && request.role === Role.PLATFORM_ADMIN) {
        // Defence in depth: `requestRole` never queues an admin request, so a
        // PENDING PLATFORM_ADMIN row can only predate this rule. Approving one
        // here would make the decision endpoint an admin grant path, which is
        // exactly what class rule 1 forbids - the queue must never be the way
        // an account becomes an admin.
        throw new DomainException(
          ERROR_CODES.FORBIDDEN,
          'PLATFORM_ADMIN cannot be approved through the API. Use the operator CLI.',
          HttpStatus.FORBIDDEN,
        );
      }

      if (decision === 'APPROVED') {
        await tx.userRole.upsert({
          where: { userId_role: { userId: request.userId, role: request.role } },
          create: { userId: request.userId, role: request.role, grantedBy: actorUserId },
          update: {},
        });
      }

      await tx.roleRequest.update({
        where: { id: requestId },
        data: { status: decision, decidedBy: actorUserId, decidedAt: new Date() },
      });

      await tx.adminAuditLog.create({
        data: {
          actorUserId,
          action: decision === 'APPROVED' ? 'role_request.approve' : 'role_request.reject',
          targetUserId: request.userId,
          detail: { requestId, role: request.role },
        },
      });
    });
  }

  /** Admin view of users with their roles, for the Users & Roles screen. */
  async listUsers(): Promise<Array<{ id: string; email: string; status: string; roles: string[]; createdAt: Date }>> {
    const users = await this.prisma.user.findMany({
      include: { roles: { select: { role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      status: user.status,
      roles: user.roles.map((row) => row.role).sort(),
      createdAt: user.createdAt,
    }));
  }

  /** Append-only admin audit trail, newest first. */
  async listAuditLogs(): Promise<
    Array<{ id: string; action: string; targetUserId: string | null; detail: unknown; createdAt: Date; actor: { id: string; email: string } }>
  > {
    const rows = await this.prisma.adminAuditLog.findMany({
      include: { actor: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetUserId: row.targetUserId,
      detail: row.detail,
      createdAt: row.createdAt,
      actor: row.actor,
    }));
  }
}
