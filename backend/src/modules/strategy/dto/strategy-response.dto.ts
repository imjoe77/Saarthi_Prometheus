import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Strategy } from '@prisma/client';

/**
 * MODULE 05 - one strategy, as its owner sees it.
 *
 * `ownerId` is absent even here, and that is not an oversight: the only caller
 * this shape is ever returned to is the owner, who already knows their own id.
 * Echoing it would add a field with no reader and would tempt a later change to
 * hand this DTO to somebody else.
 *
 * What is absent for a stronger reason: no return, no risk figure, no follower
 * count. None of those can be computed from a row like this one, so a client that
 * received them would be displaying invented numbers. They arrive when a module
 * that can compute them exists.
 */
export class StrategyResponseDto {
  @ApiProperty({ description: 'Strategy identifier.', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Display name, unique per owner case-insensitively.', example: 'EMBER momentum' })
  name!: string;

  @ApiPropertyOptional({
    description: 'The owner’s own description of the strategy.',
    nullable: true,
    example: 'Holds EMBER through momentum swings, rebalanced weekly.',
  })
  description!: string | null;

  @ApiProperty({
    description: 'Whether other users may discover this strategy.',
    enum: ['PRIVATE', 'PUBLIC'],
    example: 'PRIVATE',
  })
  visibility!: string;

  @ApiProperty({
    description: 'Lifecycle state. ARCHIVED is terminal.',
    enum: ['ACTIVE', 'ARCHIVED'],
    example: 'ACTIVE',
  })
  status!: string;

  @ApiProperty({ description: 'When it was created, ISO-8601.', example: '2026-10-05T09:12:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: 'When it was last changed, ISO-8601.', example: '2026-10-05T09:12:00.000Z' })
  updatedAt!: string;

  static from(strategy: Strategy): StrategyResponseDto {
    return {
      id: strategy.id,
      name: strategy.name,
      description: strategy.description,
      visibility: strategy.visibility,
      status: strategy.status,
      createdAt: strategy.createdAt.toISOString(),
      updatedAt: strategy.updatedAt.toISOString(),
    };
  }
}
