import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Query parameters for `GET /health`.
 *
 * Exists so the endpoint has a real, validated DTO in Module 00. That gives the
 * global {@link ValidationPipe} a genuine subject for its test suite before any
 * feature module needs one, rather than shipping an untested pipe.
 */
export class HealthQueryDto {
  /**
   * Include per-dependency detail. Query-string values arrive as strings, so
   * `?verbose=yes` is normalised rather than rejected.
   */
  @ApiPropertyOptional({
    description: 'Include per-dependency latency and failure detail.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off'].includes(normalised)) return false;
    }
    // Anything else is returned untouched so `@IsBoolean` can reject it with a
    // message about the expected format rather than a coercion error.
    return value;
  })
  @IsBoolean({ message: 'verbose must be a boolean value (true or false).' })
  verbose?: boolean;
}