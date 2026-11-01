import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Response after unlocking direct consultation with an expert trader. */
export class ConnectExpertResponseDto {
  @ApiProperty({ description: 'Whether the consultation session was successfully unlocked', example: true })
  success!: boolean;

  @ApiProperty({ description: 'The strategy ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  strategyId!: string;

  @ApiProperty({ description: 'Strategy name', example: 'Demo Strategy' })
  strategyName!: string;

  @ApiProperty({ description: 'Fee paid in EMBER', example: '10' })
  fee!: string;

  @ApiProperty({ description: 'Asset symbol', example: 'EMBER' })
  asset!: string;

  @ApiProperty({ description: 'Remaining available EMBER balance', example: '90' })
  remainingBalance!: string;

  @ApiProperty({ description: 'When the consultation was unlocked' })
  unlockedAt!: string;
}

/** Request body for sending a message to an expert trader. */
export class ExpertChatMessageDto {
  @ApiProperty({
    description: 'The message to the expert trader',
    example: 'What is your risk management approach for this strategy?',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message!: string;
}

/** Response from the expert trader. */
export class ExpertChatResponseDto {
  @ApiProperty({ description: 'The strategy ID' })
  strategyId!: string;

  @ApiProperty({ description: 'Expert trader display name', example: 'Expert Trader (Demo Strategy)' })
  expertName!: string;

  @ApiProperty({ description: 'Reply from the expert trader' })
  reply!: string;

  @ApiProperty({ description: 'When the reply was sent' })
  timestamp!: string;
}
