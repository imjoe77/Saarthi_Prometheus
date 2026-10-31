import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Strategy } from '@prisma/client';

/**
 * MODULE 05 - one strategy as another user may see it in discovery.
 *
 * NARROWER THAN THE OWNER DTO, ON PURPOSE. Every field removed here is one whose
 * absence protects the owner:
 *
 *  - `ownerId` - would turn a public catalogue into a directory of user ids.
 *  - Any owner email, name or handle - and there is no display-name field in
 *    Prometheus to expose even if one were wanted, so none is invented here.
 *  - `status` and `visibility` - both are constants in this set (ACTIVE and
 *    PUBLIC, by the query that produced it). Carrying them would suggest they
 *    can vary, which would let a client filter on a field it can never see.
 *
 * What remains is exactly what a strategy is: a name, the owner's description of
 * it, and when it was last changed.
 *
 * There is still no performance figure, no risk score and no follower count. The
 * absence is deliberate rather than pending: those need modules that do not exist
 * yet, and a placeholder would be rendered as a real number.
 */
export class PublicStrategyDto {
  @ApiProperty({ description: 'Strategy identifier.', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Display name, as the owner wrote it.', example: 'EMBER momentum' })
  name!: string;

  @ApiPropertyOptional({
    description: 'The owner’s own description of the strategy.',
    nullable: true,
    example: 'Holds EMBER through momentum swings, rebalanced weekly.',
  })
  description!: string | null;

  @ApiProperty({ description: 'When it was created, ISO-8601.', example: '2026-10-05T09:12:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: 'When it was last changed, ISO-8601.', example: '2026-10-05T09:12:00.000Z' })
  updatedAt!: string;

  static from(strategy: Strategy): PublicStrategyDto {
    return {
      id: strategy.id,
      name: strategy.name,
      description: strategy.description,
      createdAt: strategy.createdAt.toISOString(),
      updatedAt: strategy.updatedAt.toISOString(),
    };
  }
}
