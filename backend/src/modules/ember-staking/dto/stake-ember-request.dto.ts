import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength } from 'class-validator';

export class StakeEmberRequestDto {
  @ApiProperty({
    description: 'EMBER to lock into the simulated staking position. Real wallet lock; rewards are simulation-only.',
    example: '1000',
  })
  @IsString()
  @MaxLength(40)
  emberAmount!: string;

  @ApiProperty({
    description: 'Client-generated UUID. One stake outcome per key; a replay returns the original position.',
    example: '1d7e9f2a-4b5c-4d6e-8f7a-1b2c3d4e5f6a',
  })
  @IsUUID()
  clientRequestId!: string;
}
