import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateMintRequestDto {
  @ApiProperty({
    description: 'EMBER to mint, whole or with up to 18 decimals. The contract routes it to the treasury and refuses anything past the lifetime cap.',
    example: '5000',
  })
  @IsString()
  @MaxLength(40)
  amount!: string;

  @ApiProperty({
    description: 'Client-generated UUID. One mint outcome per key: a replay or retry returns the original request state instead of minting twice.',
    example: '4b556011-9474-4e9b-a3cb-042c99e70ae8',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiPropertyOptional({
    description: 'Free-text justification recorded with the request for the audit trail.',
    example: 'Hub distribution inventory top-up, October supply cycle',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;
}
