import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * MODULE 11 — the request body for POST /tokenomics/buybacks.
 *
 * A buyback is always proposed from an ALREADY RECORDED allocation's buyback
 * portion; there is no independent amount, because inventing a second input
 * would let a buyback disagree with the proposal it claims to act on. One
 * buyback per allocation (`allocation_id` is unique), so the same proposal
 * cannot be bought back twice.
 */
export class CreateBuybackDto {
  @ApiProperty({
    description: 'The recorded allocation whose buyback portion this buyback acts on.',
    example: '0f8b6f4e-93ac-4c71-9f6a-96a2ecb2f9e8',
  })
  @IsUUID()
  allocationId!: string;

  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: '4b556011-9474-4e9b-a3cb-042c99e70ae8',
  })
  @IsUUID()
  clientRequestId!: string;
}
