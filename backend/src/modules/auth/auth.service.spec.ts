import { Role } from '@prisma/client';

import { narrowRoles } from './auth.service';

/**
 * Unit tests for the MODULE 13 narrowing rule — the single function that
 * decides which roles a session may actually act as.
 *
 * Pure data in, pure data out: no database, no Nest container, no mock. The
 * guard's ANY-semantics and the HTTP behaviour of `/rbac/me` are covered by
 * `roles.guard.spec.ts` and the RBAC e2e suite respectively; what matters here
 * is the intersection itself, because every authorization decision downstream
 * inherits it.
 */
describe('narrowRoles', () => {
  const held = [Role.USER, Role.EXPERT_TRADER, Role.LIQUIDITY_PROVIDER];

  it('returns every held role when no persona was chosen', () => {
    // Old sessions carry no login-intent claim. They must keep behaving exactly
    // as before the feature existed — backward compatibility is the contract.
    expect(narrowRoles(held, null)).toEqual(held);
  });

  it('scopes a multi-role account to USER when it signed in as a normal user', () => {
    // The bug this whole module exists to fix: a Gmail account holding three
    // roles that picks the Normal User card is a normal user, full stop.
    expect(narrowRoles(held, Role.USER)).toEqual([Role.USER]);
  });

  it('scopes to EXPERT_TRADER when it signed in as an expert trader', () => {
    expect(narrowRoles(held, Role.EXPERT_TRADER)).toEqual([Role.EXPERT_TRADER]);
  });

  it('scopes to LIQUIDITY_PROVIDER when it signed in as a liquidity provider', () => {
    expect(narrowRoles(held, Role.LIQUIDITY_PROVIDER)).toEqual([Role.LIQUIDITY_PROVIDER]);
  });

  it('never widens: an active role the account does not hold yields no persona role', () => {
    // Intersection only. A forged or stale claim for a role the database does
    // not grant must not conjure it.
    const userOnly = [Role.USER];
    expect(narrowRoles(userOnly, Role.EXPERT_TRADER)).toEqual([]);
  });

  it('narrows an admin to USER when they sign in through the Normal User card', () => {
    // One click, one surface: the login page's admin card is the only way to
    // reach the admin surface, so picking Normal User scopes the session to
    // USER even for an address that holds PLATFORM_ADMIN.
    const admin = [Role.USER, Role.PLATFORM_ADMIN];
    expect(narrowRoles(admin, Role.USER)).toEqual([Role.USER]);
  });

  it('drops an elevated persona when the account also holds admin', () => {
    // The admin slot is not preserved across other personas either — the
    // account reaches Expert Trader only by clicking that card, and Platform
    // Admin only by clicking its own.
    const admin = [Role.USER, Role.EXPERT_TRADER, Role.PLATFORM_ADMIN];
    expect(narrowRoles(admin, Role.EXPERT_TRADER)).toEqual([Role.EXPERT_TRADER]);
  });

  it('scopes an admin-signed-in session to the admin surface alone', () => {
    // The Platform Admin card is a persona like any other: it yields exactly
    // PLATFORM_ADMIN, never the whole held set.
    const admin = [Role.USER, Role.PLATFORM_ADMIN];
    expect(narrowRoles(admin, Role.PLATFORM_ADMIN)).toEqual([Role.PLATFORM_ADMIN]);
  });

  it('narrows an admin holding no PLATFORM_ADMIN row to nothing (fails closed)', () => {
    // A claim for a role the database does not grant conjures nothing — the
    // session may reach no surface at all.
    expect(narrowRoles([Role.USER], Role.PLATFORM_ADMIN)).toEqual([]);
  });

  it('does not mutate the held-role array it was given', () => {
    const input = [...held];
    narrowRoles(input, Role.USER);
    expect(input).toEqual(held);
  });

  it('handles an account that holds nothing beyond the baseline USER row', () => {
    expect(narrowRoles([Role.USER], Role.USER)).toEqual([Role.USER]);
  });
});
