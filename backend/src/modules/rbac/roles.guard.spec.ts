import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

/** Builds a minimal ExecutionContext carrying handler metadata and a request. */
function contextWith(metadata: unknown, roles?: string[]): ExecutionContext {
  return {
    getHandler: () => ({} as never),
    getClass: () => ({} as never),
    switchToHttp: () => ({
      getRequest: () => (roles === undefined ? {} : { user: { roles } }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  /** Stubs the reflector to return fixed metadata for the ROLES_KEY. */
  function withMetadata(required: unknown): void {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
  }

  it('allows any authenticated caller when no roles are declared', () => {
    withMetadata(undefined);
    expect(guard.canActivate(contextWith(undefined, ['USER']))).toBe(true);
  });

  it('allows any authenticated caller when the declared list is empty', () => {
    withMetadata([]);
    expect(guard.canActivate(contextWith([], ['USER']))).toBe(true);
  });

  it('allows a caller holding one of the required roles', () => {
    withMetadata([Role.EXPERT_TRADER, Role.PLATFORM_ADMIN]);
    expect(
      guard.canActivate(contextWith(undefined, [Role.USER, Role.EXPERT_TRADER])),
    ).toBe(true);
  });

  it('does not special-case PLATFORM_ADMIN: a listed-role check still applies', () => {
    // No hidden bypass. An EXPERT_TRADER-only route rejects a caller who only
    // holds PLATFORM_ADMIN; the strategy controller lists both roles for that
    // reason.
    withMetadata([Role.EXPERT_TRADER]);
    expect(() => guard.canActivate(contextWith(undefined, [Role.PLATFORM_ADMIN]))).toThrow(
      DomainException,
    );
  });

  it('allows a PLATFORM_ADMIN through a route that lists it', () => {
    withMetadata([Role.EXPERT_TRADER, Role.PLATFORM_ADMIN]);
    expect(guard.canActivate(contextWith(undefined, [Role.PLATFORM_ADMIN]))).toBe(true);
  });

  it('rejects a caller holding none of the required roles with 403 FORBIDDEN', () => {
    withMetadata([Role.PLATFORM_ADMIN]);
    try {
      guard.canActivate(contextWith(undefined, [Role.USER]));
      fail('expected DomainException');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      const domain = error as DomainException;
      expect(domain.code).toBe(ERROR_CODES.FORBIDDEN);
      expect(domain.getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
  });

  it('rejects a caller with no roles at all', () => {
    withMetadata([Role.EXPERT_TRADER]);
    expect(() => guard.canActivate(contextWith(undefined, []))).toThrow(DomainException);
  });

  it('treats a missing request.user as having no roles', () => {
    withMetadata([Role.EXPERT_TRADER]);
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(DomainException);
  });

  it('reads metadata via getAllAndOverride with handler and class', () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    guard.canActivate(contextWith(undefined, ['USER']));
    expect(spy).toHaveBeenCalledWith(ROLES_KEY, [expect.anything(), expect.anything()]);
  });
});
