import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * MODULE 08 — the request body for POST /usdt/buy and POST /usdt/sell.
 *
 * The side is the route, not the body: one endpoint buys and one sells, so a
 * body that disagreed with its own path could only ever be a bug.
 *
 * `clientRequestId` makes re-submission idempotent on `(user,
 * clientRequestId)`, exactly like Module 06c's paper orders: a replayed
 * request returns the original order instead of applying the balance movements
 * a second time.
 *
 * OPTIONAL PRICE GUARD (the explicit slippage rule). `maxExecutionPrice` on a
 * BUY and `minExecutionPrice` on a SELL are customer-supplied limits: the
 * order settles at the fresh order-book VWAP computed in the same request,
 * and the response's pricing block shows exactly that price. When a guard is
 * supplied and the fresh VWAP has moved through it, the order is refused with
 * 409 CONFLICT and nothing settles - a price shown earlier is never silently
 * replaced by a worse one. Omitted, the order executes at whatever fresh
 * market price the response then reports.
 */
export class UsdtOrderWriteDto {
  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: '4b556011-9474-4e9b-a3cb-042c99e70ae8',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({ description: 'USDT volume to buy or sell.', example: '10000' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  usdtAmount!: string;

  @ApiPropertyOptional({
    description: 'BUY only: refuse the order if the fresh execution price exceeds this limit, INR per USDT.',
    example: '100.50',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^\d+(\.\d{1,8})?$/, { message: 'maxExecutionPrice must be a positive decimal string' })
  maxExecutionPrice?: string;

  @ApiPropertyOptional({
    description: 'SELL only: refuse the order if the fresh execution price falls below this limit, INR per USDT.',
    example: '99.50',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^\d+(\.\d{1,8})?$/, { message: 'minExecutionPrice must be a positive decimal string' })
  minExecutionPrice?: string;
}
