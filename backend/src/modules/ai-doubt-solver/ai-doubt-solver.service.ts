import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { AskDoubtDto } from './dto/ask-doubt.dto';
import type { DoubtAnswerDto, DoubtSectionsDto } from './dto/doubt-answer.dto';
import { matchKnowledgeEntry } from './knowledge-base';

/** Mirrors the widget's own caps so a verbose model cannot overflow its panel. */
const CONCEPT_MAX = 120;
const SECTION_MAX = 1800;
/** The widget aborts its fetch at 30s; the model must fail before that. */
const MODEL_TIMEOUT_MS = 20_000;
/** Context is a scoring hint, not a document — bound it before matching. */
const CONTEXT_MAX = 4_000;

/**
 * Answers trade-buddy questions (design-integration task).
 *
 * Two answer sources, one contract:
 *
 *  1. **A locally connected model**, when `AI_MODEL_URL` is set. The URL is a
 *     POST endpoint that receives `{ query, elementContext, pageContext,
 *     history }` and answers `{ concept, sections: { what, simple, howItWorks,
 *     example, remember } }` — the same contract the widget itself speaks, so
 *     swapping the built-in brain for a trained one needs no adapter.
 *  2. **The built-in knowledge base**, used by default and as the fallback
 *     whenever the model errors, times out or answers in the wrong shape. The
 *     endpoint therefore always answers: an unexplained 500 would surface to a
 *     visitor as a broken chat panel, while a knowledge-base answer — or an
 *     honest "no entry yet" — is still a true statement.
 *
 * Every answer, from either source, is normalised through `normalizeAnswer`:
 * concept ≤ 120 chars, sections ≤ 1800 chars each, all five sections present
 * as strings. That is the widget's validation contract, enforced here rather
 * than left to the model's goodwill.
 */
@Injectable()
export class AiDoubtSolverService {
  private readonly logger = new Logger(AiDoubtSolverService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async ask(dto: AskDoubtDto): Promise<DoubtAnswerDto> {
    const modelUrl = this.config.aiModelUrl;

    if (modelUrl) {
      try {
        return await this.askModel(modelUrl, dto);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`AI model backend failed (${reason}); answering from the knowledge base.`);
      }
    }

    return this.answerLocally(dto);
  }

  /** The offline path: match the question against the curated entries. */
  private answerLocally(dto: AskDoubtDto): DoubtAnswerDto {
    const entry = matchKnowledgeEntry({
      query: dto.query,
      context: describeContext(dto),
    });

    return normalizeAnswer({
      concept: entry.concept,
      sections: {
        what: entry.what,
        simple: entry.simple,
        howItWorks: entry.howItWorks,
        example: entry.example,
        remember: entry.remember,
      },
    });
  }

  /** Forwards the widget's payload verbatim (history trimmed) to the model. */
  private async askModel(modelUrl: string, dto: AskDoubtDto): Promise<DoubtAnswerDto> {
    const response = await fetch(modelUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: dto.query,
        elementContext: dto.elementContext ?? null,
        pageContext: dto.pageContext ?? null,
        history: (dto.history ?? []).slice(-8),
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`model answered ${response.status}`);
    }

    return normalizeAnswer(await response.json());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sectionText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // The widget truncates at 1800/120 anyway; normalising keeps the contract
  // true at the source and prevents one runaway section from bloating replies.
  return value.length > SECTION_MAX ? `${value.slice(0, SECTION_MAX - 1)}…` : value;
}

/**
 * Enforces the widget's validation contract on any candidate answer — the
 * knowledge base's own entries and a model's reply alike. Throws when the
 * required parts are missing, which is what routes a malformed model answer
 * into the knowledge-base fallback.
 */
export function normalizeAnswer(raw: unknown): DoubtAnswerDto {
  if (!isRecord(raw)) throw new Error('answer is not an object');

  const sections: Partial<DoubtSectionsDto> = isRecord(raw['sections']) ? raw['sections'] : {};
  const concept = sectionText(raw['concept']).slice(0, CONCEPT_MAX).trim();
  const simple = sectionText(sections['simple']).trim();

  if (!concept) throw new Error('answer is missing a concept');
  if (!simple) throw new Error('answer is missing sections.simple');

  return {
    concept,
    sections: {
      what: sectionText(sections['what']),
      simple,
      howItWorks: sectionText(sections['howItWorks']),
      example: sectionText(sections['example']),
      remember: sectionText(sections['remember']),
    },
  };
}

/** Pulls only strings, from the fields the widget actually sends. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Flattens the inspected element and the visible-page digest into one short
 * corpus for keyword scoring. Missing or oddly typed fields simply contribute
 * nothing — context is a hint, and its absence must not fail the request.
 */
export function describeContext(dto: AskDoubtDto): string {
  const parts: string[] = [];
  const element = dto.elementContext;
  if (isRecord(element)) {
    parts.push(textOf(element['title']), textOf(element['text']), textOf(element['tag']), textOf(element['type']));
  }

  const page = dto.pageContext;
  if (isRecord(page)) {
    parts.push(textOf(page['pageTitle']), textOf(page['url']));
    const headings = page['headings'];
    if (Array.isArray(headings)) parts.push(...headings.map(textOf));
    const visible = page['visibleContent'];
    if (Array.isArray(visible)) {
      for (const item of visible) {
        if (!isRecord(item)) continue;
        parts.push(textOf(item['title']), textOf(item['text']));
      }
    }
  }

  return parts.filter(Boolean).join(' ').slice(0, CONTEXT_MAX);
}
