import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * MODULE 07 - changing the allocation of an existing follow.
 *
 * Identical shape to {@link CreateFollowDto}, deliberately a separate type: the
 * two routes make different promises. Following creates a relationship (and
 * seeds its cursor); this one changes a number that applies to the *next*
 * event the engine consumes and never rewrites the events already in the
 * history, which each carry the fraction they were sized with.
 *
 * Allowed while unfollowed as well as active - the setting belongs to the
 * relationship and waits for whoever follows again.
 */
export class UpdateFollowConfigDto {
  @ApiProperty({
    description: 'New share of each expert order to mirror, in (0, 1].',
    example: '0.1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  allocationFraction!: string;
}
