import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StrategyVisibility } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * MODULE 05 - body of `POST /strategies`.
 *
 * There is no `ownerId` here, and there never will be: ownership is taken from
 * the verified caller. A create DTO that accepted one would let a caller file a
 * strategy under somebody else's name.
 *
 * There is no `status` here either. A strategy is created ACTIVE; ARCHIVED is
 * reached only by archiving, which is the operation that owns that decision.
 */
export class CreateStrategyDto {
  @ApiProperty({
    description: 'Display name. Unique per owner, compared case-insensitively.',
    minLength: 1,
    maxLength: 80,
    example: 'EMBER momentum',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  // Trimmed on the way in rather than rejected when padded, so `" Momentum "` and
  // `"Momentum"` cannot become two strategies that look identical on screen and
  // then collide on the functional unique index with an opaque error.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiPropertyOptional({
    description: 'What the strategy does, in the owner’s words.',
    maxLength: 1000,
    example: 'Holds EMBER through momentum swings, rebalanced weekly.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether other users may discover this strategy. Defaults to PRIVATE.',
    enum: ['PRIVATE', 'PUBLIC'],
    default: 'PRIVATE',
  })
  @IsOptional()
  @IsEnum(StrategyVisibility)
  visibility?: StrategyVisibility;
}
