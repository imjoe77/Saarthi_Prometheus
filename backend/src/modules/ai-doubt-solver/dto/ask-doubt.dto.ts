import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Request contract for the trade-buddy widget's answer endpoint.
 *
 * The shape is fixed by the widget (`public/ai-doubt-solver.js`), which is the
 * client here: it posts the question, an optional inspected element, a digest
 * of the visible page and the last few turns of conversation. The optional
 * parts arrive as free-form objects — they are client-side descriptions of DOM
 * state, not a domain model — so they are size-limited and type-checked here
 * and picked apart field by field in the service, where a missing or oddly
 * typed field can degrade to "no context" instead of a 400.
 *
 * Deliberately public (no bearer token): the widget fetches from the page with
 * plain headers, the endpoint answers with general explanations, and it touches
 * no user data. The abuse rails are the length caps below plus whatever the
 * configured model endpoint enforces on its side.
 */
export interface AskHistoryMessage {
  role: string;
  content: string;
  target?: string;
}

export class AskDoubtDto {
  @ApiProperty({ description: 'The question in the visitor\'s own words.', example: 'What is impermanent loss?' })
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  query!: string;

  @ApiPropertyOptional({
    description: 'The element the visitor inspected, if any: { id, title, tag, type, text }.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  elementContext?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Digest of the visible page: { pageTitle, url, headings, visibleContent }.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  pageContext?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Recent conversation turns, newest last; the widget sends at most 8.',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  history?: AskHistoryMessage[];
}
