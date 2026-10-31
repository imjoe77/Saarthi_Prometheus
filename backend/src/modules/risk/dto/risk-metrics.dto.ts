import { ApiProperty } from '@nestjs/swagger';

import type { RiskMetrics } from '../risk.types';

/**
 * The published risk measurements, and nothing else.
 *
 * Three dimensionless ratios: no equity balance, no return, no P&L, no price.
 * Each is a statement about how much a strategy *moved*, which is all the Risk
 * Engine was asked to establish - a performance module, if one is ever built,
 * will answer the separate question of what it made.
 *
 * All are present or none are. They are reported together because a drawdown
 * without the volatility beside it cannot be classified, and a classification
 * cannot be checked without both.
 */
export class RiskMetricsDto {
  @ApiProperty({
    description: 'Largest peak-to-trough decline in the series, as a fraction of the peak.',
    minimum: 0,
    example: 0.2181,
  })
  maxDrawdown!: number;

  @ApiProperty({
    description: 'Sample standard deviation of daily simple returns.',
    minimum: 0,
    example: 0.1017,
  })
  dailyVolatility!: number;

  @ApiProperty({
    description: 'Daily volatility scaled to a year by √252.',
    minimum: 0,
    example: 1.6146,
  })
  annualisedVolatility!: number;

  static from(metrics: RiskMetrics): RiskMetricsDto {
    const dto = new RiskMetricsDto();

    dto.maxDrawdown = metrics.maxDrawdown;
    dto.dailyVolatility = metrics.dailyVolatility;
    dto.annualisedVolatility = metrics.annualisedVolatility;

    return dto;
  }
}
