import { ApiPropertyOptional } from '@nestjs/swagger';
import { StrategyStatus, StrategyVisibility } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * MODULE 05 - query parameters for the two strategy listings.
 *
 * OFFSET PAGINATION, NOT A CURSOR. Module 03's keyset cursor is correct for a
 * ledger, which only ever grows at one end, and it is deliberately not reused
 * here: importing it would reach into a frozen module's internals, and it is the
 * wrong tool for a catalogue that is re-read, re-sorted and re-filtered by its
 * owner. A strategy list is short, changes rarely and is read from the first page
 * far more often than it is paged through, so an offset is honest here and costs
 * one count per request.
 *
 * The known cost, stated rather than hidden: rows created or archived between two
 * requests can shift an offset, so a page boundary may repeat or skip a row.
 * Nothing here is money and nothing here is cumulative, so a repeat is a
 * cosmetic artefact rather than a correctness problem.
 *
 * `page` is 1-based, which is what a user interface displays.
 */
export class ListStrategiesQueryDto {
  @ApiPropertyOptional({ description: '1-based page number.', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Page size.', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Owner listing only. Absent means both states, so an owner sees their archived
   * strategies rather than having them disappear the moment they retire one.
   *
   * Discovery does not read this: it is pinned to ACTIVE, because a catalogue of
   * things nobody may follow again would be a catalogue of dead ends.
   */
  @ApiPropertyOptional({
    description: 'Owner listing only. Filter by lifecycle state.',
    enum: ['ACTIVE', 'ARCHIVED'],
  })
  @IsOptional()
  @IsEnum(StrategyStatus)
  status?: StrategyStatus;

  /**
   * Owner listing only. Absent means both.
   *
   * Discovery does not read this either: PUBLIC is not a filter there, it is the
   * definition of the set.
   */
  @ApiPropertyOptional({
    description: 'Owner listing only. Filter by visibility.',
    enum: ['PRIVATE', 'PUBLIC'],
  })
  @IsOptional()
  @IsEnum(StrategyVisibility)
  visibility?: StrategyVisibility;
}
