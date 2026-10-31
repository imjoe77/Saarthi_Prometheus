import { ApiProperty } from '@nestjs/swagger';

import { RiskEvidenceDto } from './risk-evidence.dto';
import { RiskMetricsDto } from './risk-metrics.dto';
import type { RiskEvaluation, RiskReason, RiskStatus } from '../risk.types';

/**
 * The single response of `GET /api/risk/strategies/:strategyId`.
 *
 * THE NULLS ARE THE POINT. `reason`, `riskLevel` and `metrics` are null
 * together whenever the status is `INSUFFICIENT_DATA`, because they are one
 * claim: there is no reason to state, so there is no classification and no
 * figure to classify. Returning a zero here instead would be indistinguishable
 * from a measured zero once it reached a screen, and a follower sizing a
 * position against it would have no way to tell the difference.
 *
 * Exactly three shapes leave this module:
 * - `EVALUATED` with a level, metrics and no reason;
 * - `INSUFFICIENT_DATA` with a reason, null level and null metrics;
 * - nothing else. There is no partial evaluation and no estimated reading.
 */
export class RiskEvaluationDto {
  @ApiProperty({
    description: 'The strategy this evaluation describes.',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  strategyId!: string;

  @ApiProperty({
    description:
      'Whether enough observations exist to state anything at all. INSUFFICIENT_DATA is a successful, expected answer - HTTP 200 - not an error.',
    enum: ['EVALUATED', 'INSUFFICIENT_DATA'],
    example: 'INSUFFICIENT_DATA',
  })
  status!: RiskStatus;

  @ApiProperty({
    description:
      'Why the status is what it is. Never null on INSUFFICIENT_DATA; always null on EVALUATED. Exactly one reason is returned.',
    enum: ['NO_HISTORY', 'INSUFFICIENT_HISTORY', 'NO_ACTIVITY', 'INVALID_SERIES'],
    nullable: true,
    example: 'NO_HISTORY',
  })
  reason!: RiskReason | null;

  @ApiProperty({
    description:
      'Classification of the strategy. Null whenever there are no measurements - never defaulted to LOW.',
    enum: ['LOW', 'MEDIUM', 'HIGH'],
    nullable: true,
    example: null,
  })
  riskLevel!: 'LOW' | 'MEDIUM' | 'HIGH' | null;

  @ApiProperty({
    description:
      'Risk measurements, rounded to four decimal places. Null if and only if riskLevel is null.',
    type: RiskMetricsDto,
    nullable: true,
    example: null,
  })
  metrics!: RiskMetricsDto | null;

  @ApiProperty({
    description: 'What the statement was made from.',
    type: RiskEvidenceDto,
  })
  evidence!: RiskEvidenceDto;

  @ApiProperty({
    description: 'When this evaluation ran - not when any observation was made.',
    type: String,
    format: 'date-time',
    example: '2026-10-07T12:00:00.000Z',
  })
  evaluatedAt!: string;

  static from(evaluation: RiskEvaluation): RiskEvaluationDto {
    const dto = new RiskEvaluationDto();

    dto.strategyId = evaluation.strategyId;
    dto.status = evaluation.status;
    dto.reason = evaluation.reason;
    dto.riskLevel = evaluation.riskLevel;
    dto.metrics = evaluation.metrics ? RiskMetricsDto.from(evaluation.metrics) : null;
    dto.evidence = RiskEvidenceDto.from(evaluation.evidence);
    dto.evaluatedAt = evaluation.evaluatedAt;

    return dto;
  }
}
