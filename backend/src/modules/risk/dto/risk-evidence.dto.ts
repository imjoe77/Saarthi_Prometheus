import { ApiProperty } from '@nestjs/swagger';

import { REQUIRED_OBSERVATIONS, SAMPLE_DESCRIPTION } from '../domain/risk.constants';
import type { RiskEvidence } from '../risk.types';

/**
 * The published shape of "what this statement was made from".
 *
 * Every field is safe to expose: counts, calendar dates and the policy in
 * force. No equity value, trade, price or provider detail appears, so a client
 * can explain an empty state without being handed anything the risk model was
 * not asked to reveal.
 */
export class RiskEvidenceDto {
  @ApiProperty({
    description: 'Observations offered for evaluation.',
    minimum: 0,
    example: 0,
  })
  observations!: number;

  @ApiProperty({
    description: 'UTC date of the first observation, or null when there are none.',
    type: String,
    nullable: true,
    example: null,
  })
  firstObservedAt!: string | null;

  @ApiProperty({
    description: 'UTC date of the last observation, or null when there are none.',
    type: String,
    nullable: true,
    example: null,
  })
  lastObservedAt!: string | null;

  @ApiProperty({
    description: 'Observations required before any risk figure is reported.',
    example: REQUIRED_OBSERVATIONS,
  })
  requiredObservations!: number;

  @ApiProperty({
    description: 'What one observation is, in words.',
    example: SAMPLE_DESCRIPTION,
  })
  sampleDescription!: string;

  static from(evidence: RiskEvidence): RiskEvidenceDto {
    const dto = new RiskEvidenceDto();

    dto.observations = evidence.observations;
    dto.firstObservedAt = evidence.firstObservedAt;
    dto.lastObservedAt = evidence.lastObservedAt;
    dto.requiredObservations = evidence.requiredObservations;
    dto.sampleDescription = evidence.sampleDescription;

    return dto;
  }
}
