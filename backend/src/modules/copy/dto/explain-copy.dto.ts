import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * MODULE 07 - the request body for asking why a copy trade happened.
 *
 * THE QUESTION IS THE ONLY REQUIRED FIELD. Everything else is a pointer: which
 * market the reader is looking at, and which row they mean. A pointer says
 * *where to look*, never *what to say* - the facts are read from the caller's
 * own ledger on the server, so a page cannot put a number into an answer.
 */
export class ExplainCopyDto {
  @ApiProperty({
    description: 'The question in the reader\'s own words.',
    example: 'Why was it short at this point?',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_000)
  query!: string;

  @ApiPropertyOptional({
    description: 'The market the reader is looking at. Used to pick which trade the question is about.',
    example: 'BTC/USD',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  symbol?: string;

  @ApiPropertyOptional({
    description: 'The row the reader pointed at, as the page marked it: "copy-event:<expertOrderId>".',
    example: 'copy-event:2c9b0f3a-1d4e-4f6b-9a77-0c1d2e3f4a5b',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  focusId?: string;
}

/** One section of the answer. */
export class CopyExplanationSectionsDto {
  @ApiProperty({ description: 'What the record says, in full.' })
  what!: string;

  @ApiProperty({ description: 'The same thing in one plain sentence.' })
  simple!: string;

  @ApiProperty({ description: 'How the mechanics actually work.' })
  howItWorks!: string;

  @ApiProperty({ description: 'This trade, with its numbers.' })
  example!: string;

  @ApiProperty({ description: 'The caveat worth remembering.' })
  remember!: string;
}

/**
 * The answer, in the shape the trade-buddy widget renders: a concept and five
 * sections. The shape is the widget's contract, so the widget needs no change
 * to display it.
 */
export class CopyExplanationResponseDto {
  @ApiProperty({ description: 'Short title for the answer.', example: 'Why BTC/USD is SHORT' })
  concept!: string;

  @ApiProperty({ type: CopyExplanationSectionsDto })
  sections!: CopyExplanationSectionsDto;
}
