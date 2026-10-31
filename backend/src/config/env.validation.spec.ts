import { generateKeyPairSync } from 'node:crypto';

import { formatEnvValidationError, validateEnvironment } from './env.validation';

// Module 02 added AUTH_API_SIGNING_PUBLIC_KEY as a required variable, so the
// "minimal valid" baseline is no longer just a database URL. The assertions
// below are unchanged: they still assert Module 00's defaults. Only the
// definition of "valid" grew.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const VALID_BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/prometheus?schema=public',
  AUTH_API_SIGNING_PUBLIC_KEY: publicKey,
};

describe('validateEnvironment', () => {
  it('accepts a minimal valid configuration and applies defaults', () => {
    const result = validateEnvironment({ ...VALID_BASE });

    expect(result['NODE_ENV']).toBe('development');
    expect(result['PORT']).toBe(3001);
    expect(result['HOST']).toBe('0.0.0.0');
    expect(result['API_PREFIX']).toBe('api');
    expect(result['LOG_LEVEL']).toBe('log');
    expect(result['SWAGGER_ENABLED']).toBe(true);
    expect(result['DATABASE_POOL_MAX']).toBe(10);
  });

  it('coerces numeric and boolean strings from the environment', () => {
    const result = validateEnvironment({
      ...VALID_BASE,
      PORT: '4000',
      SWAGGER_ENABLED: 'false',
      DATABASE_POOL_MAX: '25',
    });

    expect(result['PORT']).toBe(4000);
    expect(result['SWAGGER_ENABLED']).toBe(false);
    expect(result['DATABASE_POOL_MAX']).toBe(25);
  });

  describe('failure modes', () => {
    it('fails clearly when the required DATABASE_URL is missing', () => {
      expect(() => validateEnvironment({})).toThrow(/DATABASE_URL/);
    });

    it('rejects a non-PostgreSQL connection string', () => {
      expect(() =>
        validateEnvironment({ ...VALID_BASE, DATABASE_URL: 'mysql://localhost:3306/prometheus' }),
      ).toThrow(/DATABASE_URL/);
    });

    it('rejects a DATABASE_URL that is not a URI at all', () => {
      expect(() =>
        validateEnvironment({ ...VALID_BASE, DATABASE_URL: 'not-a-connection-string' }),
      ).toThrow(/DATABASE_URL/);
    });

    it('rejects an out-of-range PORT', () => {
      expect(() => validateEnvironment({ ...VALID_BASE, PORT: '70000' })).toThrow(/PORT/);
    });

    it('rejects a non-numeric PORT', () => {
      expect(() => validateEnvironment({ ...VALID_BASE, PORT: 'abc' })).toThrow(/PORT/);
    });

    it('rejects an invalid NODE_ENV', () => {
      expect(() => validateEnvironment({ ...VALID_BASE, NODE_ENV: 'stagingg' })).toThrow(/NODE_ENV/);
    });

    it('rejects an invalid LOG_LEVEL', () => {
      expect(() => validateEnvironment({ ...VALID_BASE, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
    });

    it('rejects a DATABASE_POOL_MAX below the minimum', () => {
      expect(() => validateEnvironment({ ...VALID_BASE, DATABASE_POOL_MAX: '0' })).toThrow(
        /DATABASE_POOL_MAX/,
      );
    });

    it('reports every problem at once rather than only the first', () => {
      expect(() =>
        validateEnvironment({ NODE_ENV: 'nope', LOG_LEVEL: 'nope', PORT: 'nope' }),
      ).toThrow(/NODE_ENV[\s\S]*LOG_LEVEL[\s\S]*PORT|DATABASE_URL/);
    });

    it('never echoes the value of a secret-bearing variable in the error', () => {
      const secret = 'super-secret-password-value';
      try {
        validateEnvironment({ DATABASE_URL: 'mysql://localhost' + secret });
      } catch (error) {
        expect((error as Error).message).toContain('DATABASE_URL');
        expect((error as Error).message).not.toContain(secret);
      }
      expect.assertions(2);
    });

    it('fails clearly when the signing public key is missing', () => {
      expect(() => validateEnvironment({ DATABASE_URL: VALID_BASE.DATABASE_URL })).toThrow(
        /AUTH_API_SIGNING_PUBLIC_KEY/,
      );
    });

    it('never echoes the signing key when it fails validation', () => {
      // Corrupt the body rather than the headers: a broken PEM still names the
      // variable in the message, which is all the operator needs.
      const corrupted = publicKey.replace(/A[\s\S]/, 'X');
      try {
        validateEnvironment({ ...VALID_BASE, AUTH_API_SIGNING_PUBLIC_KEY: corrupted });
      } catch (error) {
        expect((error as Error).message).not.toContain(corrupted.trim());
      }
      expect.assertions(1);
    });

    it('rejects a signing key that is not a real public key', () => {
      // The failure this prevents: a truncated or mistyped PEM otherwise boots
      // fine and then 401s every legitimate request, which reads as a client bug.
      expect(() =>
        validateEnvironment({
          ...VALID_BASE,
          AUTH_API_SIGNING_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nnot-base64\\n-----END PUBLIC KEY-----',
        }),
      ).toThrow(/AUTH_API_SIGNING_PUBLIC_KEY/);
    });

    it('rejects a private key pasted where the public key belongs', () => {
      expect(() =>
        validateEnvironment({ ...VALID_BASE, AUTH_API_SIGNING_PUBLIC_KEY: privateKey }),
      ).toThrow(/AUTH_API_SIGNING_PUBLIC_KEY/);
    });

    it('accepts the real key even with escaped newlines from a .env file', () => {
      // dotenv stores multi-line values on one line; the config layer unescapes
      // them later, so validation must tolerate the encoded form.
      const escaped = publicKey.replace(/\n/g, '\\n');

      expect(() => validateEnvironment({ ...VALID_BASE, AUTH_API_SIGNING_PUBLIC_KEY: escaped })).not.toThrow();
    });
  });

  describe('formatEnvValidationError', () => {
    it('produces an actionable, multi-line message', () => {
      const message = formatEnvValidationError([
        {
          path: ['PORT'],
          message: '"PORT" must be a valid port',
          type: 'number.port',
          context: {},
        },
        {
          path: ['DATABASE_URL'],
          message: '"DATABASE_URL" is required',
          type: 'any.required',
          context: {},
        },
      ]);

      expect(message).toContain('Prometheus cannot start');
      expect(message).toContain('PORT');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('.env.example');
    });

    it('includes a Joi hint when one is available', () => {
      const message = formatEnvValidationError([
        {
          path: ['PORT'],
          message: 'must be a valid port',
          type: 'number.port',
          context: { hint: 'PORT must be a number between 0 and 65535' },
        },
      ]);

      expect(message).toContain('PORT must be a number between 0 and 65535');
    });

    it('labels a field-less error as (root)', () => {
      const message = formatEnvValidationError([
        { path: [], message: 'root failure', type: 'any.custom', context: {} },
      ]);

      expect(message).toContain('(root)');
    });
  });
});