import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/app.config';
import {
  AiDoubtSolverService,
  describeContext,
  normalizeAnswer,
} from './ai-doubt-solver.service';
import type { AskDoubtDto } from './dto/ask-doubt.dto';
import { FALLBACK_ENTRY, KNOWLEDGE_BASE, matchKnowledgeEntry, normalize } from './knowledge-base';

function makeAppConfig(aiModelUrl: string | null = null): AppConfig {
  return new AppConfig({ nodeEnv: 'test', aiModelUrl });
}

function ask(overrides: Partial<AskDoubtDto> = {}): AskDoubtDto {
  return { query: 'What is impermanent loss?', ...overrides };
}

describe('AiDoubtSolverService', () => {
  let warnSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeAll(() => {
    // Failure paths (model down, malformed model answer) are asserted through
    // the answer that comes back, not through log output.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  afterAll(() => {
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  async function build(aiModelUrl: string | null = null): Promise<AiDoubtSolverService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiDoubtSolverService,
        { provide: APP_CONFIG, useValue: makeAppConfig(aiModelUrl) },
      ],
    }).compile();
    return moduleRef.get(AiDoubtSolverService);
  }

  describe('knowledge-base path (no model configured)', () => {
    it('answers an exact concept question from the curated entries', async () => {
      const service = await build();

      const answer = await service.ask(ask());

      expect(answer.concept).toBe('Impermanent loss');
      expect(answer.sections.simple.toLowerCase()).toContain('change price relative to each other');
      expect(answer.sections.remember.toLowerCase()).toContain('fees');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('matches a whole-word keyword so "il" never resolves to a token called off', async () => {
      const entry = matchKnowledgeEntry({ query: 'what does il mean here' });

      // "il" is not a keyword of any entry; the fallback says so rather than
      // matching some substring inside "portfolio" or "token'.
      expect(entry.id).toBe(FALLBACK_ENTRY.id);
    });

    it('uses the inspected element when the question itself is generic', async () => {
      const service = await build();

      const answer = await service.ask(
        ask({
          query: 'explain this',
          elementContext: { title: 'Copy trading', text: 'Follow a lead trader automatically' },
        }),
      );

      expect(answer.concept).toBe('Copy trading');
    });

    it('falls back honestly when nothing matches', async () => {
      const service = await build();

      const answer = await service.ask(ask({ query: 'zzzz qqqq xyzzy plugh' }));

      expect(answer.concept).toBe('No knowledge-base entry yet');
      expect(answer.sections.simple).toContain("don't have an entry");
    });

    it('answers without page context — the widget may send none', async () => {
      const service = await build();

      const answer = await service.ask(ask({ query: 'how does copy trading work' }));

      expect(answer.concept).toBe('Copy trading');
    });

    it('every knowledge entry already satisfies the widget contract', () => {
      for (const entry of KNOWLEDGE_BASE) {
        const answer = normalizeAnswer({
          concept: entry.concept,
          sections: {
            what: entry.what,
            simple: entry.simple,
            howItWorks: entry.howItWorks,
            example: entry.example,
            remember: entry.remember,
          },
        });
        expect(answer.concept.length).toBeLessThanOrEqual(120);
        for (const section of Object.values(answer.sections)) {
          expect(section.length).toBeLessThanOrEqual(1800);
        }
      }
    });
  });

  describe('model path', () => {
    const modelAnswer = {
      concept: 'A locally trained explanation',
      sections: {
        what: 'What.',
        simple: 'Simple.',
        howItWorks: 'How.',
        example: 'Example.',
        remember: 'Remember.',
      },
    };

    it('forwards the widget payload and returns the model answer', async () => {
      const service = await build('http://model.local/answer');
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => modelAnswer,
      } as Response);

      const answer = await service.ask(ask({ history: [{ role: 'user', content: 'hi' }] }));

      expect(answer.concept).toBe('A locally trained explanation');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://model.local/answer');
      expect(JSON.parse(String(init.body))).toMatchObject({
        query: 'What is impermanent loss?',
        history: [{ role: 'user', content: 'hi' }],
      });
      expect(init.signal).toBeDefined();
    });

    it('trims history to the widget maximum of 8 turns', async () => {
      const service = await build('http://model.local/answer');
      fetchSpy.mockResolvedValue({ ok: true, json: async () => modelAnswer } as Response);

      const history = Array.from({ length: 12 }, (_, index) => ({
        role: 'user',
        content: `turn ${index}`,
      }));
      await service.ask(ask({ history }));

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((JSON.parse(String(init.body)).history as unknown[]).length).toBe(8);
    });

    it('falls back to the knowledge base when the model errors', async () => {
      const service = await build('http://model.local/answer');
      fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response);

      const answer = await service.ask(ask());

      expect(answer.concept).toBe('Impermanent loss');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('falls back when the model is unreachable (network/timeout)', async () => {
      const service = await build('http://model.local/answer');
      fetchSpy.mockRejectedValue(new Error('The operation was aborted due to timeout'));

      const answer = await service.ask(ask());

      expect(answer.concept).toBe('Impermanent loss');
    });

    it('falls back when the model answers in the wrong shape', async () => {
      const service = await build('http://model.local/answer');
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ concept: 'Model', sections: {} }),
      } as Response);

      const answer = await service.ask(ask());

      expect(answer.concept).toBe('Impermanent loss');
    });
  });
});

describe('normalizeAnswer', () => {
  const valid = {
    concept: 'Concept',
    sections: { what: 'w', simple: 's', howItWorks: 'h', example: 'e', remember: 'r' },
  };

  it('passes a well-formed answer through', () => {
    expect(normalizeAnswer(valid)).toEqual(valid);
  });

  it('caps the concept at 120 characters', () => {
    const answer = normalizeAnswer({ ...valid, concept: 'x'.repeat(500) });
    expect(answer.concept).toHaveLength(120);
  });

  it('caps each section at 1800 characters', () => {
    const answer = normalizeAnswer({
      ...valid,
      sections: { ...valid.sections, what: 'y'.repeat(4000) },
    });
    expect(answer.sections.what.length).toBeLessThanOrEqual(1800);
  });

  it('coerces non-string sections to empty strings rather than echoing objects', () => {
    const answer = normalizeAnswer({
      ...valid,
      sections: { ...valid.sections, example: { nested: true } },
    });
    expect(answer.sections.example).toBe('');
  });

  it('throws when the concept is missing', () => {
    expect(() => normalizeAnswer({ ...valid, concept: '' })).toThrow(/concept/);
  });

  it('throws when sections.simple is missing — the widget requires it', () => {
    expect(() =>
      normalizeAnswer({ ...valid, sections: { ...valid.sections, simple: undefined } }),
    ).toThrow(/sections\.simple/);
  });

  it('throws on a non-object answer', () => {
    expect(() => normalizeAnswer(null)).toThrow(/not an object/);
    expect(() => normalizeAnswer('text')).toThrow(/not an object/);
  });
});

describe('describeContext', () => {
  it('extracts strings from a well-formed context', () => {
    const text = describeContext(
      ask({
        elementContext: { title: 'TVL', text: 'Total value locked', tag: 'article' },
        pageContext: {
          pageTitle: 'Liquidity',
          url: '/liquidity',
          headings: ['Pools', 42, null],
          visibleContent: [{ title: 'APY', text: '12.4%' }, 'not-an-object'],
        },
      }),
    );

    expect(text).toContain('TVL');
    expect(text).toContain('Total value locked');
    expect(text).toContain('Liquidity');
    expect(text).toContain('/liquidity');
    expect(text).toContain('Pools');
    expect(text).toContain('12.4%');
  });

  it('degrades to an empty string for missing or oddly typed context', () => {
    expect(describeContext(ask({ elementContext: undefined, pageContext: undefined }))).toBe('');
    expect(
      describeContext(
        ask({
          elementContext: 'a string' as unknown as Record<string, unknown>,
          pageContext: 7 as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe('');
    expect(
      describeContext(ask({ pageContext: { headings: 'not-an-array', visibleContent: {} } })),
    ).toBe('');
  });

  it('bounds the corpus it feeds the matcher', () => {
    const text = describeContext(
      ask({ elementContext: { text: 'a'.repeat(20_000) } }),
    );
    expect(text.length).toBeLessThanOrEqual(4_000);
  });
});

describe('knowledge base normalization', () => {
  it('normalizes case, punctuation and spacing consistently', () => {
    expect(normalize('  Impermanent   LOSS! ')).toBe('impermanent loss');
  });

  it('matches longer phrases ahead of stray single words', () => {
    const entry = matchKnowledgeEntry({ query: 'what is impermanent loss' });
    expect(entry.id).toBe('impermanent-loss');
  });
});
