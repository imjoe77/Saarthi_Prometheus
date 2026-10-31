import { ApiPropertyOptional } from '@nestjs/swagger';
import { StrategyStatus, StrategyVisibility } from '@prisma/client';
import { Transform } from 'class-transformer';
import { Equals, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * MODULE 05 - body of `PATCH /strategies/:id`.
 *
 * Every field is optional and every field may be sent alone, which is why this is
 * a PATCH and not a PUT: a client changing only the description must not have to
 * resend the name and visibility it already knows.
 *
 * `status` is an allow-list of exactly one value, ARCHIVED, enforced here with
 * `@Equals` rather than with `@IsEnum`. An enum membership check would accept
 * ACTIVE as well, and the difference is not cosmetic: "unarchive" would then be a
 * request this API accepts and answers, with the outcome decided by the service's
 * archived check. Retirement is one-way by decision, so it is one-way at the
 * boundary too and ACTIVE is a 400 rather than a 409 that depends on the row.
 *
 * As in the create DTO, there is no owner field - the caller in the token is the
 * only owner this request can address.
 */
export class UpdateStrategyDto {
  @ApiPropertyOptional({
    description: 'New display name. Unique per owner, compared case-insensitively.',
    minLength: 1,
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    description: 'Replacement description. Send an empty string to clear it.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  description?: string;

  @ApiPropertyOptional({
    description: 'Publish or un-publish the strategy. Does not affect an archived strategy.',
    enum: ['PRIVATE', 'PUBLIC'],
  })
  @IsOptional()
  @IsEnum(StrategyVisibility)
  visibility?: StrategyVisibility;

  @ApiPropertyOptional({
    description: 'ARCHIVED retires the strategy permanently. ACTIVE is not accepted: archiving is one-way.',
    enum: ['ARCHIVED'],
  })
  @IsOptional()
  @Equals(StrategyStatus.ARCHIVED, {
    message: 'status may only be set to ARCHIVED; archiving is permanent and cannot be undone',
  })
  status?: StrategyStatus;
}
