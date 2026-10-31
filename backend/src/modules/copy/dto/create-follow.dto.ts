import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * MODULE 07 - the request body for following a strategy.
 *
 * ALLOCATION IS REQUIRED, WITH NO DEFAULT. A default of 1 would silently mirror
 * the expert in full the moment anyone follows, which is the largest possible
 * copy and the least deliberate one. Making the follower state it means every
 * follow is the result of a decision, and the number is stored on the follow
 * row where the history can show what was decided.
 *
 * `strategyId` travels in the body rather than the path because this is a
 * create with a target: the relationship does not exist yet, so there is no
 * resource to address. It is still a UUID here, so a malformed id is a 400 with
 * a field name rather than a 404 about a strategy that was never meant to be
 * looked up.
 *
 * The allocation arrives as a string and is validated as one, for the same
 * reason every other decimal in this application does: `0.25` is not
 * representable exactly in a binary float, and a body field typed as `number`
 * would round it before anyone could object. The real rule - digits, at most 18
 * decimal places, strictly greater than 0 and at most 1 - lives in
 * `domain/copy-sizing.ts`, the one place where the shape and the value are
 * written down together.
 */
export class CreateFollowDto {
  @ApiProperty({ description: 'Strategy to follow.', example: '3f1d3f0e-8a2c-4d0b-9d3a-1f2b3c4d5e6f' })
  @IsUUID()
  strategyId!: string;

  @ApiProperty({
    description: 'Share of each expert order to mirror, in (0, 1]. "1" mirrors the expert exactly.',
    example: '0.25',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  allocationFraction!: string;
}
