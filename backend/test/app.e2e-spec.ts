import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { createApp } from '../src/bootstrap';

/**
 * Boots the real application - same `createApp()` used by `main.ts` - and
 * exercises the HTTP surface end to end.
 *
 * Deliberately no mocks: this is the Module 00 checkpoint proof that
 * configuration validation, the global pipe, the global filter and the health
 * module are wired together correctly.
 *
 * The database is NOT required. `/health` reports dependency state instead of
 * failing, which is exactly the behaviour this suite pins down.
 */
describe('Application bootstrap (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('boot', () => {
    it('initialises without throwing', () => {
      expect(app).toBeDefined();
    });

    it('mounts the health route under the configured global prefix', async () => {
      // Asserted behaviourally rather than by reading Express internals:
      // `_router`/`router.stack` are implementation details that have moved
      // between Express 4 and 5 and are not part of any contract we rely on.
      await http().get('/api/health').expect(200);
      await http().get('/health').expect(404);
    });
  });

  describe('GET /api/health', () => {
    it('succeeds with the documented shape', async () => {
      const response = await http().get('/api/health').expect(200);

      expect(response.body).toMatchObject({
        status: expect.stringMatching(/^(ok|error)$/),
        service: 'prometheus-backend',
        version: expect.any(String),
        timestamp: expect.any(String),
        uptimeSeconds: expect.any(Number),
      });
      expect(Array.isArray(response.body.checks)).toBe(true);
      expect(response.body.checks[0]).toMatchObject({ name: 'database', status: expect.any(String) });
    });

    it('returns a correlation id header on every response', async () => {
      const response = await http().get('/api/health').expect(200);

      expect(response.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('echoes a caller-supplied correlation id', async () => {
      const correlationId = 'test-correlation-123';

      const response = await http()
        .get('/api/health')
        .set('x-request-id', correlationId)
        .expect(200);

      expect(response.headers['x-request-id']).toBe(correlationId);
    });

    it('generates a fresh correlation id when the header is absent or blank', async () => {
      const response = await http().get('/api/health').set('x-request-id', '   ').expect(200);

      expect(response.headers['x-request-id']).not.toBe('');
      expect(response.headers['x-request-id']).toHaveLength(36);
    });

    it('omits failure detail by default', async () => {
      const response = await http().get('/api/health').expect(200);

      for (const check of response.body.checks as Array<{ status: string; error?: string }>) {
        if (check.status === 'down') {
          expect(check.error).toBeUndefined();
        }
      }
    });

    it('includes the environment name in verbose mode', async () => {
      const response = await http().get('/api/health?verbose=true').expect(200);

      expect(response.body.environment).toBe('test');
    });

    it('accepts verbose spelled several ways', async () => {
      for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
        const response = await http().get(`/api/health?verbose=${value}`).expect(200);
        expect(response.body.environment).toBe('test');
      }

      for (const value of ['false', '0', 'no', 'off']) {
        const response = await http().get(`/api/health?verbose=${value}`).expect(200);
        expect(response.body.environment).toBeUndefined();
      }
    });

    it('tolerates an absent query string', async () => {
      await http().get('/api/health').expect(200);
    });
  });

  describe('GET /api/health - DTO validation', () => {
    it('rejects a non-boolean verbose value with 400', async () => {
      const response = await http().get('/api/health?verbose=maybe').expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.message).toEqual(expect.any(String));
      expect(response.body.requestId).toEqual(expect.any(String));
      // `path` is the full request target, query string included, so a support
      // request can be reproduced exactly from the log line.
      expect(response.body.path).toBe('/api/health?verbose=maybe');
    });

    it('rejects an unrecognised query property with 400', async () => {
      const response = await http().get('/api/health?verbose=true&verbosee=true').expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('returns the standard error envelope', async () => {
      const response = await http().get('/api/health?verbose=maybe').expect(400);

      expect(Object.keys(response.body).sort()).toEqual(
        ['code', 'message', 'path', 'requestId', 'timestamp'].sort(),
      );
    });
  });

  describe('error handling', () => {
    it('returns a 404 envelope for an unknown route', async () => {
      const response = await http().get('/api/does-not-exist').expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.path).toBe('/api/does-not-exist');
    });

    it('never returns a 500 with a stack trace for a client error', async () => {
      const response = await http().get('/api/health?verbose=maybe').expect(400);

      expect(response.body.message).not.toContain('at ');
      expect(response.body).not.toHaveProperty('stack');
    });
  });
});