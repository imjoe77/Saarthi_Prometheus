import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { Role } from '@prisma/client';

/** Body for `POST /rbac/role-requests`. */
export class CreateRoleRequestDto {
  /**
   * PLATFORM_ADMIN is accepted at validation so the service - not the
   * validator - decides: `RbacService.requestRole` auto-approves only an
   * address listed in `PLATFORM_ADMIN_EMAILS` and refuses every other admin
   * request outright, so a queued admin grant can never be produced here.
   */
  @IsIn([Role.EXPERT_TRADER, Role.LIQUIDITY_PROVIDER, Role.PLATFORM_ADMIN])
  role!: Role;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Body for `POST /admin/role-requests/:id/decision`. */
export class DecideRoleRequestDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';
}

/** Body for `POST /admin/users/:id/roles`. */
export class GrantRoleDto {
  @IsIn([Role.EXPERT_TRADER, Role.LIQUIDITY_PROVIDER])
  role!: Role;
}
