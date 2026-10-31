import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Result of a single dependency check.
 *
 * Field initialisers are intentionally absent: these classes describe response
 * payloads, and the only writer is `HealthService`. `!` documents that the
 * properties are assigned by that writer rather than at construction time.
 */
export class HealthCheckEntryDto {
  @ApiProperty({ description: 'Dependency name, e.g. "database".' })
  name!: string;

  @ApiProperty({
    description: 'Dependency state.',
    enum: ['up', 'down'],
  })
  status!: 'up' | 'down';

  @ApiPropertyOptional({ description: 'Round-trip latency in milliseconds.' })
  latencyMs?: number;

  @ApiPropertyOptional({
    description: 'Human-readable failure reason. Omitted when the check passes.',
  })
  error?: string;
}

/** Aggregate health of the service and its dependencies. */
export class HealthStatusDto {
  @ApiProperty({
    description: 'Overall state. "error" means at least one dependency is down.',
    enum: ['ok', 'error'],
  })
  status!: 'ok' | 'error';

  @ApiProperty({ description: 'Application name.', example: 'prometheus-backend' })
  service!: string;

  @ApiProperty({ description: 'API version.', example: '0.1.0' })
  version!: string;

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp of the check.',
    example: '2026-01-01T00:00:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({ description: 'Uptime in seconds.' })
  uptimeSeconds!: number;

  @ApiPropertyOptional({ description: 'Active environment name.', example: 'development' })
  environment?: string;

  @ApiProperty({ type: [HealthCheckEntryDto], description: 'Per-dependency results.' })
  checks!: HealthCheckEntryDto[];

  @ApiProperty({
    description:
      'Whether the trade-buddy AI endpoint can answer: true whenever the built-in knowledge base is present, and still true with a model configured. Read by the widget to show "AI ready".',
    example: true,
  })
  providerConfigured!: boolean;

  @ApiPropertyOptional({
    description: 'Which answer source backs /ai-doubt-solver right now.',
    enum: ['knowledge-base', 'model'],
    example: 'knowledge-base',
  })
  aiProvider?: 'knowledge-base' | 'model';
}