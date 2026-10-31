import { ApiProperty } from '@nestjs/swagger';
import type { TokenAllocation, TokenBuyback, TokenBurn } from '@prisma/client';

import { TokenAllocationResponseDto } from './token-allocation-response.dto';
import { TokenBuybackResponseDto } from './token-buyback-response.dto';
import { TokenBurnResponseDto } from './token-burn-response.dto';

/**
 * MODULE 11 — the response of GET /tokenomics/records.
 *
 * The caller's own simulation history, newest first, bounded to the 50 most
 * recent entries per record type. Per-caller like every other listing in the
 * codebase: there is no admin role through which one user could read another's
 * records, and global supply figures come from Module 10's `GET /ember/supply`
 * rather than being summed out of this list - the two reconcile because every
 * burn here corresponds to exactly one BURN ledger leg there.
 *
 * The bound is a snapshot, not a page: tokenomics records are per-caller
 * simulation history for one dashboard. If volume ever outgrows it, keyset
 * paging like Module 08's orders is the pattern to add.
 */
export class TokenomicsRecordsResponseDto {
  @ApiProperty({ description: 'Recorded allocation proposals, newest first.' })
  allocations!: TokenAllocationResponseDto[];

  @ApiProperty({ description: 'Recorded simulated buybacks, newest first.' })
  buybacks!: TokenBuybackResponseDto[];

  @ApiProperty({ description: 'Completed burns, newest first.' })
  burns!: TokenBurnResponseDto[];

  static from(records: {
    allocations: TokenAllocation[];
    buybacks: (TokenBuyback & { allocation: TokenAllocation })[];
    burns: TokenBurn[];
  }): TokenomicsRecordsResponseDto {
    const dto = new TokenomicsRecordsResponseDto();
    dto.allocations = records.allocations.map((row) => TokenAllocationResponseDto.from(row));
    dto.buybacks = records.buybacks.map((row) => TokenBuybackResponseDto.from(row));
    dto.burns = records.burns.map((row) => TokenBurnResponseDto.from(row));
    return dto;
  }
}
