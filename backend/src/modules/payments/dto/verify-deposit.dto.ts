import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * MODULE 03b — the request body for POST /payments/deposits/:id/verify.
 *
 * These are the three values Razorpay's checkout hands back to the browser
 * after a successful payment. The browser sends them unaltered; the backend
 * recomputes the checkout signature from the order and payment ids with the
 * key secret it holds, and compares. A signature that does not match is a
 * refusal, not a warning: it is the only thing standing between "the browser
 * says it paid" and "the money arrived".
 *
 * Nothing here names a user or an amount. The deposit being verified owns both,
 * so a tampered body cannot redirect a payment.
 */
export class VerifyDepositDto {
  @ApiProperty({ description: 'Razorpay order id the checkout was opened with.', example: 'order_QkXxxxxxxx' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  razorpayOrderId!: string;

  @ApiProperty({ description: 'Razorpay payment id of the captured payment.', example: 'pay_QkXxxxxxxx' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  razorpayPaymentId!: string;

  @ApiProperty({
    description: 'Checkout signature returned by Razorpay: HMAC-SHA256 of "<orderId>|<paymentId>".',
    example: 'a1b2c3d4e5f6…',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  razorpaySignature!: string;
}
