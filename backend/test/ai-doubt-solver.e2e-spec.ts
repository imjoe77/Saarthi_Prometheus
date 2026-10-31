import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { createApp } from '../src/bootstrap';

/**
 * End-to-end proof for the trade-buddy answer endpoint (design-integration
 * task): the widget is the client, so this suite pins the exact contract that
 * `public/ai-doubt-solver.js` validates — `{ concept, sections }` with
 * `sections.simple` present — plus the public/no-auth posture, the validation
 * failures that must reach the widget as `{ error: … }`, and the health flags
 * the widget reads to decide whether to say "AI ready".
 *
 * No model is configured in the test environment, so every answer comes from
 * the built-in knowledge base: that is the path exercised here by construction.
 * The model path itself is covered by the unit suite with a mocked `fetch`.
 */
describe('AI doubt solver (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const ask = (body: unknown) => http().post('/api/ai-doubt-solver').send(body as object);

  describe('POST /api/ai-doubt-solver', () => {
    it('answers a covered question with the widget contract', async () => {
      const response = await ask({ query: 'What is impermanent loss?' }).expect(200);

      expect(response.body).toMatchObject({
        concept: expect.any(String),
        sections: {
          what: expect.any(String),
          simple: expect.any(String),
          howItWorks: expect.any(String),
          example: expect.any(String),
          remember: expect.any(String),
        },
      });
      expect(response.body.concept.length).toBeLessThanOrEqual(120);
      for (const section of Object.values(response.body.sections as Record<string, string>)) {
        expect(section.length).toBeLessThanOrEqual(1800);
      }
      expect(response.body.concept).toBe('Impermanent loss');
    });

    it('requires no session or bearer token — the widget posts with plain headers', async () => {
      await ask({ query: 'how does copy trading work' }).expect(200);
    });

    it('accepts the optional context the widget sends alongside the question', async () => {
      const response = await ask({
        query: 'explain this',
        elementContext: { id: 'kpi', title: 'TVL', tag: 'article', text: 'Total value locked' },
        pageContext: {
          pageTitle: 'Liquidity dashboard',
          url: '/liquidity/dashboard',
          headings: ['Pools'],
          visibleContent: [{ title: 'APY', text: '12.4%' }],
        },
        history: [{ role: 'user', content: 'what is TVL' }],
      }).expect(200);

      expect(response.body.concept).toBe('TVL (total value locked)');
    });

    it('answers honestly instead of failing when nothing matches', async () => {
      const response = await ask({ query: 'zzzz qqqq xyzzy plugh' }).expect(200);

      expect(response.body.concept).toBe('No knowledge-base entry yet');
      expect(response.body.sections.simple).toEqual(expect.any(String));
    });

    it('tolerates an empty history array and absent optional fields', async () => {
      await ask({ query: 'what is staking', history: [] }).expect(200);
    });
  });

  describe('validation', () => {
    it('rejects a missing query', async () => {
      const response = await ask({}).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.message).toEqual(expect.any(String));
    });

    it('rejects an empty query', async () => {
      const response = await ask({ query: '' }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a query over the 1000-character cap', async () => {
      const response = await ask({ query: 'a'.repeat(1001) }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects more than 8 history turns', async () => {
      const response = await ask({
        query: 'hello',
        history: Array.from({ length: 9 }, () => ({ role: 'user', content: 'x' })),
      }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a non-object context', async () => {
      const response = await ask({ query: 'hello', elementContext: 'not an object' }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unexpected property rather than ignoring it', async () => {
      const response = await ask({ query: 'hello', model: 'gpt-9' }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('returns the standard error envelope the BFF maps to { error }', async () => {
      const response = await ask({}).expect(400);

      expect(Object.keys(response.body).sort()).toEqual(
        ['code', 'message', 'path', 'requestId', 'timestamp'].sort(),
      );
    });

    it('does not answer other verbs — the endpoint is POST-only', async () => {
      await http().get('/api/ai-doubt-solver').expect(404);
    });
  });

  describe('GET /api/health (widget status probe)', () => {
    it('reports the AI provider as configured and names the answer source', async () => {
      const response = await http().get('/api/health').expect(200);

      expect(response.body.providerConfigured).toBe(true);
      expect(response.body.aiProvider).toBe('knowledge-base');
    });
  });
});
