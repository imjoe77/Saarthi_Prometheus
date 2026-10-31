import type { AuthConfig } from '../../config/app.config';
import { AccessTokenVerifier } from './token-verifier.service';
import {
  expectRejection,
  mintAlgorithmConfusionToken,
  mintToken,
  mintUnsignedToken,
} from '../../../test/token-minting';

/**
 * Unit tests for the cryptographic half of authentication.
 *
 * No database and no Nest container: these assert only what the verifier can
 * prove by computation. Identity resolution and status enforcement live in
 * `auth.service.spec.ts`; the HTTP behaviour lives in the e2e suite.
 */
const ISSUER = 'prometheus-web';
const AUDIENCE = 'prometheus-api';

const verifier = new AccessTokenVerifier({
  publicKey: process.env['AUTH_API_SIGNING_PUBLIC_KEY'],
  issuer: ISSUER,
  audience: AUDIENCE,
  tokenTtlSeconds: 900,
} as AuthConfig);

describe('AccessTokenVerifier', () => {
  describe('accepting a legitimate token', () => {
    it('resolves the external identity from the subject claim', async () => {
      const identity = await verifier.verify(await mintToken({ subject: 'google:109876543210' }));

      expect(identity).toEqual({
        externalIdentity: 'google:109876543210',
        provider: 'google',
        providerAccountId: '109876543210',
        email: 'user@example.com',
        // No login-intent claim: the session is unscoped, every held role.
        loginRole: null,
      });
    });

    it('resolves a github identity as readily as a google one', async () => {
      const identity = await verifier.verify(await mintToken({ subject: 'github:87654321' }));

      expect(identity.provider).toBe('github');
      expect(identity.providerAccountId).toBe('87654321');
    });

    it('parses a provider account id containing colons', async () => {
      // Some providers scope their ids. Splitting on the first colon only keeps
      // the remainder intact instead of truncating the id.
      const identity = await verifier.verify(await mintToken({ subject: 'github:org:12345' }));

      expect(identity.provider).toBe('github');
      expect(identity.providerAccountId).toBe('org:12345');
    });

    it('lowercases the provider so lookups are stable', async () => {
      const identity = await verifier.verify(await mintToken({ subject: 'Google:12345' }));

      expect(identity.provider).toBe('google');
    });

    it('tolerates a missing email claim', async () => {
      const identity = await verifier.verify(await mintToken({ email: '' }));

      expect(identity.email).toBeNull();
    });

    it('accepts an audience array containing our audience', async () => {
      const identity = await verifier.verify(await mintToken({ audience: [AUDIENCE, 'other-service'] }));

      expect(identity.externalIdentity).toBe('google:109876543210');
    });

    it('accepts a token that expires in the future', async () => {
      const identity = await verifier.verify(await mintToken({ expiresIn: '10m' }));

      expect(identity.provider).toBe('google');
    });

    it('accepts a not-yet-valid token whose nbf has passed', async () => {
      const identity = await verifier.verify(await mintToken({ notBefore: '-1m' }));

      expect(identity.provider).toBe('google');
    });
  });

  describe('parsing the login-intent claim (MODULE 13)', () => {
    it('reads a persona role as the session’s active role', async () => {
      const identity = await verifier.verify(
        await mintToken({ extraClaims: { loginRole: 'EXPERT_TRADER' } }),
      );

      expect(identity.loginRole).toBe('EXPERT_TRADER');
    });

    it('reads the USER persona, which scopes an account to its baseline role', async () => {
      const identity = await verifier.verify(
        await mintToken({ extraClaims: { loginRole: 'USER' } }),
      );

      expect(identity.loginRole).toBe('USER');
    });

    it('treats an absent claim as an unscoped session', async () => {
      const identity = await verifier.verify(await mintToken());

      expect(identity.loginRole).toBeNull();
    });

    it('reads PLATFORM_ADMIN as the admin persona', async () => {
      // The Platform Admin card signs in with this claim so the session is
      // scoped to the admin surface alone. It still only narrows: AuthService
      // intersects it with the roles the database holds, so carrying it grants
      // nothing an account does not already have.
      const identity = await verifier.verify(
        await mintToken({ extraClaims: { loginRole: 'PLATFORM_ADMIN' } }),
      );

      expect(identity.loginRole).toBe('PLATFORM_ADMIN');
    });

    it.each([
      ['a non-string value', 42],
      ['an unknown role name', 'SUPERUSER'],
      ['a lowercased role name', 'expert_trader'],
      ['an empty string', ''],
    ])('treats %s as no active role rather than failing the token', async (_label, value) => {
      const identity = await verifier.verify(
        await mintToken({ extraClaims: { loginRole: value } }),
      );

      // Lenient by design: a bogus narrowing hint degrades to "all held roles",
      // it never breaks authentication and never widens anything.
      expect(identity.loginRole).toBeNull();
      expect(identity.provider).toBe('google');
    });
  });

  describe('rejecting a forged or tampered token', () => {
    it('rejects a token signed by a different key', async () => {
      const forged = await mintToken({ untrustedKey: true });

      await expectRejection((token) => verifier.verify(token), forged, 'bad_signature');
    });

    it('rejects a token whose payload was edited after signing', async () => {
      const valid = await mintToken({ subject: 'google:111' });
      const [header, , signature] = valid.split('.');
      // Re-encode a payload claiming a different subject, keeping the original
      // signature. This is the classic JWT substitution attack.
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: 'google:999',
          email: 'attacker@example.com',
          iss: ISSUER,
          aud: AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');

      await expectRejection(
        (token) => verifier.verify(token),
        `${header}.${tamperedPayload}.${signature}`,
        'bad_signature',
      );
    });

    it('rejects an unsigned token (alg: none)', async () => {
      const unsigned = mintUnsignedToken();

      await expectRejection((token) => verifier.verify(token), unsigned, 'unsupported_algorithm');
    });

    it('rejects an HS256 token signed with the public key as the secret', async () => {
      // The classic algorithm-confusion attack: if the verifier honoured the
      // token's own alg and treated the public key as an HMAC secret, anyone
      // holding the public key could mint tokens. Pinning RS256 prevents it.
      const hs256 = await mintAlgorithmConfusionToken();

      await expectRejection((token) => verifier.verify(token), hs256, 'unsupported_algorithm');
    });
  });

  describe('rejecting an expired or not-yet-valid token', () => {
    it('rejects a token that expired an hour ago', async () => {
      const token = await mintToken({ expiresIn: '-1h' });

      await expectRejection((value) => verifier.verify(value), token, 'expired');
    });

    it('rejects a token expiring immediately, tolerating no clock skew', async () => {
      // Deliberately strict: a small leeway would silently extend every token's
      // life by that margin. Tightening it later is safe; loosening it is not.
      const token = await mintToken({ expiresIn: '0s' });

      await expectRejection((value) => verifier.verify(value), token, 'expired');
    });

    it('rejects a token whose nbf is in the future', async () => {
      const token = await mintToken({ notBefore: '+10m', expiresIn: '1h' });

      await expectRejection((value) => verifier.verify(value), token, 'not_yet_valid');
    });

    it('rejects a token with no exp claim at all', async () => {
      const token = await mintToken({ expiresIn: null });

      await expectRejection((value) => verifier.verify(value), token, 'invalid_claims');
    });
  });

  describe('rejecting a token intended for someone else', () => {
    it('rejects a token from a different issuer', async () => {
      const token = await mintToken({ issuer: 'evil.example.com' });

      await expectRejection((value) => verifier.verify(value), token, 'wrong_issuer');
    });

    it('rejects a token with no issuer', async () => {
      const token = await mintToken({ issuer: null });

      await expectRejection((value) => verifier.verify(value), token, 'wrong_issuer');
    });

    it('rejects a token addressed to a different audience', async () => {
      const token = await mintToken({ audience: 'some-other-api' });

      await expectRejection((value) => verifier.verify(value), token, 'wrong_audience');
    });

    it('rejects a token with no audience', async () => {
      const token = await mintToken({ audience: null });

      await expectRejection((value) => verifier.verify(value), token, 'wrong_audience');
    });
  });

  describe('rejecting structurally invalid tokens', () => {
    it.each([
      ['an empty string', ''],
      ['whitespace', '   '],
      ['a non-JWT string', 'definitely-not-a-token'],
      ['two segments', 'aaaa.bbbb'],
      ['four segments', 'aaaa.bbbb.cccc.dddd'],
      ['garbage segments', 'a.b.c'],
    ])('rejects %s', async (_label, token) => {
      await expectRejection((value) => verifier.verify(value), token, 'malformed');
    });

    it.each([
      ['an empty subject', ''],
      ['whitespace subject', '   '],
      ['a subject with no provider prefix', '109876543210'],
      ['a subject ending in a separator', 'google:'],
      ['a subject starting with a separator', ':12345'],
      ['a subject that is only a separator', ':'],
    ])('rejects a token with %s', async (_label, subject) => {
      const token = await mintToken({ subject });

      await expectRejection((value) => verifier.verify(value), token, 'invalid_claims');
    });
  });

  describe('failing closed on misconfiguration', () => {
    it('rejects every token when no public key is configured', async () => {
      const unconfigured = new AccessTokenVerifier({
        publicKey: '',
        issuer: ISSUER,
        audience: AUDIENCE,
        tokenTtlSeconds: 900,
      });

      // A missing key must not degrade into "accept anything".
      const token = await mintToken();

      await expectRejection((value) => unconfigured.verify(value), token, 'malformed');
    });
  });

  describe('not leaking detail', () => {
    it('never puts the token in the error message', async () => {
      const token = await mintToken({ expiresIn: '-1h' });
      const error = await expectRejection((value) => verifier.verify(value), token, 'expired');

      expect(error.message).not.toContain(token);
      expect(error.message).toContain('expired');
    });

    it('reports a reason without quoting jose internals', async () => {
      const token = await mintToken({ issuer: 'evil.example.com' });
      const error = await expectRejection((value) => verifier.verify(value), token, 'wrong_issuer');

      expect(error.message).not.toContain('evil.example.com');
    });
  });
});