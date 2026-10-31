import { ApiProperty } from '@nestjs/swagger';

import { formatDecimal } from '../../wallet/decimal.util';
import type { EmberTransfer } from '@prisma/client';

/**
 * MODULE 10 — the response of POST /ember/transfers.
 *
 * Returns only what the sender needs to confirm their own action: the transfer
 * id, the amount, when it transferred, and whether this call created it (the
 * controller answers 201 on create and 200 on replay). The counterparties'
 * user ids and wallet ids are deliberately absent - the sender already knows
 * whom they paid, and nothing here grants a route to the recipient's account.
 */
export class EmberTransferResponseDto {
  @ApiProperty({ description: 'Server-generated transfer id.' })
  transferId!: string;

  @ApiProperty({ description: 'EMBER moved, at full ledger precision.', example: '250.000000000000000000' })
  amount!: string;

  @ApiProperty({ description: 'When the transfer committed (ISO 8601).' })
  transferredAt!: string;

  static from(transfer: EmberTransfer): EmberTransferResponseDto {
    const dto = new EmberTransferResponseDto();
    dto.transferId = transfer.transferId;
    dto.amount = formatDecimal(transfer.amount, 18);
    dto.transferredAt = transfer.transferredAt.toISOString();
    return dto;
  }
}
