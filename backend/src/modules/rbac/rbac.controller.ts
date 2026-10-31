import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, RoleRequestStatus } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthContext } from '../auth/auth.service';
import { DomainException } from '../../common/errors/domain.exception';
import { CreateRoleRequestDto, DecideRoleRequestDto, GrantRoleDto } from './dto/role-request.dto';
import { conflictingHeldRole, oneRoleRefusalReason, RbacService, REQUESTABLE_ROLES } from './rbac.service';
import { Roles } from './roles.decorator';

/**
 * Role discovery and the self-serve role-request flow.
 *
 * `GET /rbac/me` is the frontend's source of truth for navigation. It exists
 * beside `GET /auth/me` rather than extending it because that endpoint's
 * response shape is pinned by the Module 02 contract tests.
 */
@ApiTags('rbac')
@ApiBearerAuth()
@Controller('rbac')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('me')
  @ApiOperation({ summary: 'The caller’s active, held and requestable roles' })
  @ApiOkResponse({
    description:
      'Granted role names plus the roles the caller may still request. `roles` is narrowed ' +
      'to the session’s active role; `heldRoles` is the full grant set.',
  })
  @HttpCode(HttpStatus.OK)
  getMyRoles(
    @CurrentUser() user: AuthContext,
  ): {
    userId: string;
    roles: string[];
    heldRoles: string[];
    activeRole: string | null;
    requestable: string[];
  } {
    // `user.roles` is already the session-scoped set (see `narrowRoles`) and
    // `user.heldRoles` the full one — both reloaded from the database by the
    // AuthGuard on this very request, so no second read is needed. Requestable
    // is computed from what the account *holds*: signing in as one persona must
    // not make a role the account already owns look requestable again.
    const heldRoles = user.heldRoles;
    const requestable = REQUESTABLE_ROLES.filter((role) => !heldRoles.includes(role)).map(String);

    return {
      userId: user.id,
      roles: user.roles,
      heldRoles,
      activeRole: user.activeRole,
      requestable,
    };
  }

  @Post('role-requests')
  @ApiOperation({ summary: 'Request EXPERT_TRADER, LIQUIDITY_PROVIDER or (env-listed) PLATFORM_ADMIN access' })
  @HttpCode(HttpStatus.CREATED)
  async requestRole(
    @CurrentUser() user: AuthContext,
    @Body() body: CreateRoleRequestDto,
  ): Promise<{ id: string }> {
    return this.rbac.requestRole(user, body.role, body.note);
  }

  /**
   * Whether this account's email is on the allowlist for the given role.
   *
   * The dedicated login flow asks this before routing an elevated sign-in:
   * only the backend may answer, because only the backend has read the env
   * allowlists. The answer says nothing about roles already held - a caller
   * holding the role routes via `/rbac/me` without ever consulting this -
   * except for the one-role rule: an account that already holds a *different*
   * elevated role is refused with an explicit `reason`, which the denial flow
   * shows instead of a generic failure.
   */
  @Get('authorize')
  @ApiOperation({ summary: 'Whether this email may self-authorize the given role' })
  @ApiOkResponse({
    schema: {
      properties: {
        role: { type: 'string' },
        authorized: { type: 'boolean' },
        reason: { type: 'string' },
      },
    },
  })
  @HttpCode(HttpStatus.OK)
  authorizeEmail(
    @CurrentUser() user: AuthContext,
    @Query('role') role?: string,
  ): { role: string | null; authorized: boolean; reason?: string } {
    const parsed = Object.values(Role).find((value) => value === role);
    if (!parsed) {
      return { role: role ?? null, authorized: false };
    }
    if (!REQUESTABLE_ROLES.includes(parsed) && parsed !== Role.PLATFORM_ADMIN) {
      // USER is held by everyone already and needs no allowlist lookup.
      return { role: parsed, authorized: false };
    }

    // One-role rule before the allowlist: a refusal must name the real reason
    // ("try a different account") rather than an allowlist answer about an
    // address that was never the problem.
    const conflict = conflictingHeldRole(user.heldRoles, parsed);
    if (conflict) {
      return {
        role: parsed,
        authorized: false,
        reason: oneRoleRefusalReason(conflict, parsed),
      };
    }

    return { role: parsed, authorized: this.rbac.isEmailAuthorized(user.email, parsed) };
  }

  @Get('role-requests/me')
  @ApiOperation({ summary: 'The caller’s own role-request history' })
  @HttpCode(HttpStatus.OK)
  async myRequests(
    @CurrentUser() user: AuthContext,
  ): Promise<Array<{ id: string; role: string; status: string; note: string | null; createdAt: Date; decidedAt: Date | null }>> {
    return this.rbac.myRequests(user.id);
  }
}

/**
 * Platform-administration endpoints: user/role management and the audit
 * trail. Every route carries `@Roles(PLATFORM_ADMIN)`, enforced server-side by
 * the global RolesGuard; hiding the admin UI is a convenience, not the
 * boundary.
 *
 * Note what is deliberately absent: any route that grants PLATFORM_ADMIN.
 * Privileged grants through this API are limited to EXPERT_TRADER and
 * LIQUIDITY_PROVIDER; PLATFORM_ADMIN is created only by the operator CLI.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly rbac: RbacService) {}

  @Get('users')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'List users with their roles (admin only)' })
  @HttpCode(HttpStatus.OK)
  async listUsers(): Promise<
    Array<{ id: string; email: string; status: string; roles: string[]; createdAt: Date }>
  > {
    return this.rbac.listUsers();
  }

  @Post('users/:id/roles')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Grant EXPERT_TRADER or LIQUIDITY_PROVIDER (admin only)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async grantRole(
    @CurrentUser() actor: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GrantRoleDto,
  ): Promise<void> {
    await this.rbac.grantRole(actor.id, id, body.role, 'role.grant');
  }

  @Delete('users/:id/roles/:role')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Revoke a privileged role (admin only)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeRole(
    @CurrentUser() actor: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
  ): Promise<void> {
    const parsed = Object.values(Role).find((value) => value === role);
    if (!parsed) {
      throw new DomainException(ERROR_CODES.NOT_FOUND, 'Unknown role.', HttpStatus.NOT_FOUND);
    }
    await this.rbac.revokeRole(actor.id, id, parsed);
  }

  @Get('role-requests')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'List role requests, optionally filtered by status (admin only)' })
  @HttpCode(HttpStatus.OK)
  async listRequests(
    @Query('status') status?: string,
  ): Promise<
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
    const parsed =
      status && Object.values(RoleRequestStatus).includes(status as RoleRequestStatus)
        ? (status as RoleRequestStatus)
        : undefined;
    return this.rbac.listRequests(parsed);
  }

  @Post('role-requests/:id/decision')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Approve or reject a role request (admin only)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async decide(
    @CurrentUser() actor: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideRoleRequestDto,
  ): Promise<void> {
    await this.rbac.decideRequest(actor.id, id, body.decision);
  }

  @Get('audit-logs')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Recent administrative audit records (admin only)' })
  @HttpCode(HttpStatus.OK)
  async auditLogs(): Promise<
    Array<{
      id: string;
      action: string;
      targetUserId: string | null;
      detail: unknown;
      createdAt: Date;
      actor: { id: string; email: string };
    }>
  > {
    return this.rbac.listAuditLogs();
  }
}
