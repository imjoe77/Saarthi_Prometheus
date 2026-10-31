import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BlockchainStatusResponseDto {
  @ApiProperty({ description: 'Whether the blockchain layer is enabled.', example: false })
  enabled!: boolean;

  @ApiProperty({ description: 'Configured network label.', example: 'localhost' })
  network!: string;

  @ApiProperty({ description: 'Configured chain id.', example: 31337 })
  chainId!: number;

  @ApiProperty({ description: 'Whether an RPC endpoint is configured.', example: true })
  rpcConfigured!: boolean;

  @ApiPropertyOptional({ description: 'Deployed token contract address, when configured.' })
  tokenAddress!: string | null;

  @ApiPropertyOptional({ description: 'Treasury (mint destination / burn source) address, when configured.' })
  treasuryAddress!: string | null;

  @ApiProperty({ description: 'Whether a minter signer key file is configured.', example: false })
  minterSignerConfigured!: boolean;

  @ApiProperty({ description: 'Whether a treasury (burner) signer key file is configured.', example: false })
  treasurySignerConfigured!: boolean;

  @ApiPropertyOptional({ description: 'Deployment-recorded whole-EMBER lifetime cap, for audit display.' })
  maxSupplyWhole!: string | null;

  @ApiProperty({ description: 'Deployment block event scans start from.', example: 0 })
  deploymentBlock!: number;

  @ApiProperty({ description: 'Confirmations required before an operation is CONFIRMED.', example: 1 })
  confirmations!: number;

  @ApiProperty({ description: 'Whether the RPC answered a live probe.', example: null })
  rpcReachable!: boolean | null;

  static from(view: {
    enabled: boolean;
    network: string;
    chainId: number;
    rpcConfigured: boolean;
    tokenAddress: string | null;
    treasuryAddress: string | null;
    minterSignerConfigured: boolean;
    treasurySignerConfigured: boolean;
    maxSupplyWhole: string | null;
    deploymentBlock: number;
    confirmations: number;
    rpcReachable: boolean | null;
  }): BlockchainStatusResponseDto {
    const dto = new BlockchainStatusResponseDto();
    dto.enabled = view.enabled;
    dto.network = view.network;
    dto.chainId = view.chainId;
    dto.rpcConfigured = view.rpcConfigured;
    dto.tokenAddress = view.tokenAddress;
    dto.treasuryAddress = view.treasuryAddress;
    dto.minterSignerConfigured = view.minterSignerConfigured;
    dto.treasurySignerConfigured = view.treasurySignerConfigured;
    dto.maxSupplyWhole = view.maxSupplyWhole;
    dto.deploymentBlock = view.deploymentBlock;
    dto.confirmations = view.confirmations;
    dto.rpcReachable = view.rpcReachable;
    return dto;
  }
}
