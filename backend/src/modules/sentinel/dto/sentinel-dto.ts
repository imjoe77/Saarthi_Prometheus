import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsRFC3339,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * MODULE 14 - request bodies, one class each.
 *
 * PRICES ARRIVE AS STRINGS. A `number` field would round `8520.10` before
 * validation could object, so the target price is text and the value rules
 * live in the service, where `Prisma.Decimal` answers "is this a decimal
 * greater than zero" with an exact answer.
 */

export class CreateSentinelAlertDto {
  @ApiProperty({ description: 'Canonical symbol from the live instrument catalogue.', example: 'AAPL' })
  @IsString()
  symbol!: string;

  @ApiProperty({
    description: 'The name the user thinks in, shown in the UI and spoken in the call.',
    example: 'Reliance Industries',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @ApiProperty({ description: 'Target price as an exact decimal string.', example: '85.20' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  targetPrice!: string;

  @ApiProperty({ enum: ['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL'] })
  @IsIn(['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL'])
  condition!: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL';

  @ApiPropertyOptional({ description: 'RFC 3339 instant after which the alert is expired instead of evaluated.' })
  @IsOptional()
  @IsRFC3339()
  expiresAt?: string | null;

  @ApiProperty({ description: 'Whether triggering this alert may phone the verified number.' })
  @IsBoolean()
  voiceEnabled!: boolean;
}

export class UpdateSentinelAlertDto {
  @ApiPropertyOptional({ description: 'Target price as an exact decimal string.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  targetPrice?: string;

  @ApiPropertyOptional({ enum: ['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL'] })
  @IsOptional()
  @IsIn(['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL'])
  condition?: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL';

  @ApiPropertyOptional({ description: 'RFC 3339 future instant, or null to remove the expiry.' })
  @IsOptional()
  @ValidateIf((body) => body.expiresAt !== null)
  @IsRFC3339()
  expiresAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;
}

export class CancelSentinelAlertDto {
  @ApiProperty({ description: 'User-facing, machine-readable reason kept on the alert.', example: 'OWNER_REQUEST' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  reason!: string;
}

export class SentinelPageQueryDto {
  @ApiPropertyOptional({ description: '1-based page.' })
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({ description: 'Page size, 1-100.' })
  @IsOptional()
  limit?: string;

  @ApiPropertyOptional({ description: 'Filter by status.' })
  @IsOptional()
  @IsIn(['ACTIVE', 'TRIGGERED', 'CALL_QUEUED', 'CALLING', 'CALL_COMPLETED', 'CALL_FAILED', 'CANCELLED', 'EXPIRED'])
  status?: string;
}

export class SetPhoneDto {
  @ApiProperty({ description: 'E.164 with country code, e.g. +14155552671.' })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  phone!: string;
}

export class VerifyPhoneDto {
  @ApiProperty({ description: 'The six-digit code that was issued.' })
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}

export class SetQuietHoursDto {
  @ApiPropertyOptional({ description: 'Start of the quiet window, minutes since UTC midnight (0-1439), or null to clear.' })
  @ValidateIf((body) => body.quietHoursStartUtc !== null)
  quietHoursStartUtc?: number | null;

  @ApiPropertyOptional({ description: 'End of the quiet window, minutes since UTC midnight (0-1439), or null to clear.' })
  @ValidateIf((body) => body.quietHoursEndUtc !== null)
  quietHoursEndUtc?: number | null;
}

export class SetVoiceDisabledDto {
  @ApiProperty({ description: 'true switches voice calls off for the account without deleting alerts.' })
  @IsBoolean()
  disabled!: boolean;
}

/**
 * The browser's answer to a ringing SIMULATED call. Only meaningful while the
 * `fake` provider is selected - a real Twilio call's outcome arrives from the
 * provider's signed webhook and can never be asserted by a client.
 */
export class SettleLiveCallDto {
  @ApiProperty({ description: 'The ringing call row this decision belongs to.' })
  @IsUUID()
  callId!: string;

  @ApiProperty({
    enum: ['ANSWERED', 'DECLINED', 'ENDED'],
    description: 'ANSWERED picks up (and hears the message), DECLINED refuses the ring, ENDED hangs up.',
  })
  @IsIn(['ANSWERED', 'DECLINED', 'ENDED'])
  action!: 'ANSWERED' | 'DECLINED' | 'ENDED';
}

/** Path param guard so a malformed id is a 400 rather than a lookup miss. */
export class AlertIdParams {
  @ApiProperty()
  @IsUUID()
  alertId!: string;
}
