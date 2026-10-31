import { ApiProperty } from '@nestjs/swagger';

import type { EmberLiquiditySlab } from '../../../config/app.config';

/**
 * MODULE 09 — the EMBER-locking slab table, as the API reports it.
 *
 * The table is configuration, not a secret: it says what a commitment costs
 * in EMBER, so a client can tell the provider the lock before it pledges
 * instead of discovering it from a refusal. The values are the configured
 * ones, formatted exactly as the commitment arithmetic reads them - the
 * server remains the only authority that applies them.
 */
export class LiquiditySlabDto {
  @ApiProperty({ description: 'Lowest USDT commitment this slab covers.', example: '100000' })
  minUsdt!: string;

  @ApiProperty({ description: 'EMBER this slab locks.', example: '20000' })
  requiredEmber!: string;

  static from(slab: EmberLiquiditySlab): LiquiditySlabDto {
    return { minUsdt: slab.minUsdt, requiredEmber: slab.requiredEmber };
  }
}

/**
 * The whole table plus the switch that says whether it is in force.
 *
 * `commitmentsEnabled` is false when no slabs are approved, which is what
 * tells a client "pledging is closed" apart from "you have not pledged yet".
 */
export class LiquiditySlabsDto {
  @ApiProperty({ description: 'Whether commitment mutations may run.', example: true })
  commitmentsEnabled!: boolean;

  @ApiProperty({ type: [LiquiditySlabDto], description: 'Approved slabs, ascending by minUsdt.' })
  slabs!: LiquiditySlabDto[];
}
