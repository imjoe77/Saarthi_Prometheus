import { Role } from '@prisma/client';

import { conflictingHeldRole, ELEVATED_ROLES, oneRoleRefusalReason, REQUESTABLE_ROLES } from './rbac.service';

/**
 * Unit tests for the "one Gmail, one privileged role" rule — the pure helpers
 * both decision points share.
 *
 * `GET /rbac/authorize` and `RbacService.requestRole` answer the same
 * question from different data (the session's held set vs a fresh database
 * read), so the rule itself lives in `conflictingHeldRole` and is tested here
 * without a database: what matters is that every call site refuses for the
 * same reason, and that the refusal names the roles involved.
 */
describe('the one-privileged-role rule', () => {
  describe('ELEVATED_ROLES', () => {
    it('counts every privileged role, including the env-granted admin', () => {
      // USER is baseline (everyone holds it) and must never be part of the
      // count; PLATFORM_ADMIN occupies the single slot like any other.
      expect([...ELEVATED_ROLES].sort()).toEqual(
        [Role.EXPERT_TRADER, Role.LIQUIDITY_PROVIDER, Role.PLATFORM_ADMIN].sort(),
      );
      expect(ELEVATED_ROLES).not.toContain(Role.USER);
    });

    it('keeps the self-serve request list a strict subset of the elevated one', () => {
      // `requestable` (and therefore the preferences UI) stays EXPERT +
      // LIQUIDITY: admin occupies the elevated slot but is never queueable,
      // only auto-granted from config.
      expect(REQUESTABLE_ROLES.every((role) => ELEVATED_ROLES.includes(role))).toBe(true);
      expect(REQUESTABLE_ROLES).not.toContain(Role.PLATFORM_ADMIN);
      expect(ELEVATED_ROLES).toContain(Role.PLATFORM_ADMIN);
    });
  });

  describe('conflictingHeldRole', () => {
    it('returns null when the account holds nothing elevated', () => {
      expect(conflictingHeldRole([Role.USER], Role.EXPERT_TRADER)).toBeNull();
    });

    it('returns null when the account holds the requested role itself', () => {
      // Already holding it is a CONFLICT of a different kind ("you already
      // hold this role"), never the one-role refusal.
      expect(
        conflictingHeldRole([Role.USER, Role.EXPERT_TRADER], Role.EXPERT_TRADER),
      ).toBeNull();
    });

    it('returns the held role when a different elevated role is requested', () => {
      expect(
        conflictingHeldRole([Role.USER, Role.EXPERT_TRADER], Role.LIQUIDITY_PROVIDER),
      ).toBe(Role.EXPERT_TRADER);
      expect(
        conflictingHeldRole([Role.USER, Role.LIQUIDITY_PROVIDER], Role.EXPERT_TRADER),
      ).toBe(Role.LIQUIDITY_PROVIDER);
    });

    it('counts PLATFORM_ADMIN as occupying the slot', () => {
      // The env-granted admin still blocks a self-serve second role: an
      // address is either the operator's admin or one privileged persona.
      expect(
        conflictingHeldRole([Role.USER, Role.PLATFORM_ADMIN], Role.EXPERT_TRADER),
      ).toBe(Role.PLATFORM_ADMIN);
      expect(
        conflictingHeldRole([Role.USER, Role.EXPERT_TRADER], Role.PLATFORM_ADMIN),
      ).toBe(Role.EXPERT_TRADER);
    });

    it('never treats the baseline USER role as a conflict', () => {
      // Every account holds USER; counting it would refuse everyone.
      expect(conflictingHeldRole([Role.USER], Role.PLATFORM_ADMIN)).toBeNull();
    });

    it('declines to rule on a non-elevated request', () => {
      // USER is not requestable through this path at all; the helper must not
      // manufacture a refusal for it.
      expect(conflictingHeldRole([Role.USER, Role.EXPERT_TRADER], Role.USER)).toBeNull();
    });
  });

  describe('oneRoleRefusalReason', () => {
    it('names both roles and tells the visitor to try a different account', () => {
      const reason = oneRoleRefusalReason(Role.EXPERT_TRADER, Role.LIQUIDITY_PROVIDER);

      expect(reason).toContain('Expert Trader');
      expect(reason).toContain('Liquidity Provider');
      expect(reason).toContain('Try a different account');
    });

    it('names Platform Admin for an env-granted account reaching for a persona', () => {
      const reason = oneRoleRefusalReason(Role.PLATFORM_ADMIN, Role.EXPERT_TRADER);

      expect(reason).toContain('Platform Admin');
      expect(reason).toContain('Expert Trader');
    });

    it('never leaks an email address', () => {
      // The denial flow signs the visitor out before rendering; the message
      // must be safe to show with no session behind it.
      expect(oneRoleRefusalReason(Role.EXPERT_TRADER, Role.PLATFORM_ADMIN)).not.toContain('@');
    });
  });
});
