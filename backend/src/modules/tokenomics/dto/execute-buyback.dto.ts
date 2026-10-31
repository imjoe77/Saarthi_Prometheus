import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * MODULE 11 — the request body for POST /tokenomics/buybacks/:id/execute.
 *
 * Records a SIMULATED execution against a buyback: the price the simulated
 * buyback was "executed" at, from which the executed quantity is derived
 * (floored to 18dp). It still moves no balances and funds nothing - the
 * architecture has no price venue, no buyback funding and no settlement, so
 * no state in this module may claim an actual execution.
 *
 * There is deliberately no `clientRequestId`: the one-way SIMULATED ->
 * RECORDED_SIMULATED_EXECUTION status transition is the idempotency guard.
 * Replaying the same price returns the original record (200); naming a
 * different price for an already-recorded execution is 409 CONFLICT, and two
 * racing executions resolve to exactly one winner through a guarded update.
 */
export class ExecuteBuybackDto {
  @ApiProperty({
    description: 'Illustrative price (INR per EMBER) the simulated execution was recorded at.',
    example: '12.5',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  executedPrice!: string;
}
