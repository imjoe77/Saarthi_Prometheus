import { ApiProperty } from '@nestjs/swagger';

/**
 * MODULE 11 — the response of GET /tokenomics/config.
 *
 * The configured allocation split, exactly as the backend resolved it at
 * boot (defaults 60/40 unless environment overrides are set and valid - a
 * pair that does not sum to 100 refuses to boot rather than serving here).
 */
export class TokenomicsConfigResponseDto {
  @ApiProperty({
    description: 'Share of every reference amount allocated to direct burn, in percent.',
    example: 60,
  })
  directBurnPct!: number;

  @ApiProperty({
    description: 'Share of every reference amount allocated to simulated buyback, in percent.',
    example: 40,
  })
  buybackPct!: number;

  static from(config: { directBurnPct: number; buybackPct: number }): TokenomicsConfigResponseDto {
    const dto = new TokenomicsConfigResponseDto();
    dto.directBurnPct = config.directBurnPct;
    dto.buybackPct = config.buybackPct;
    return dto;
  }
}
