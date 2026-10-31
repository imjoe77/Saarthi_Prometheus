import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReconciliationOnChainBlockDto {
  @ApiProperty({ description: 'On-chain total supply, 18dp string.', example: '10000000.000000000000000000' })
  totalSupply!: string;

  @ApiProperty({ description: 'Lifetime contract cap, 18dp string.', example: '100000000.000000000000000000' })
  maxSupply!: string;

  @ApiProperty({ description: 'Treasury token balance on-chain.', example: '9500000.000000000000000000' })
  treasuryBalance!: string;

  @ApiProperty({ description: 'Sum of ingested TokensMinted events.', example: '10000000.000000000000000000' })
  mintedEventsTotal!: string;

  @ApiProperty({ description: 'Sum of ingested TokensBurned events.', example: '500000.000000000000000000' })
  burnedEventsTotal!: string;

  static from(view: {
    totalSupply: string;
    maxSupply: string;
    treasuryBalance: string;
    mintedEventsTotal: string;
    burnedEventsTotal: string;
  }): ReconciliationOnChainBlockDto {
    const dto = new ReconciliationOnChainBlockDto();
    dto.totalSupply = view.totalSupply;
    dto.maxSupply = view.maxSupply;
    dto.treasuryBalance = view.treasuryBalance;
    dto.mintedEventsTotal = view.mintedEventsTotal;
    dto.burnedEventsTotal = view.burnedEventsTotal;
    return dto;
  }
}

export class ReconciliationOffChainBlockDto {
  @ApiProperty({ description: 'Ledger total EMBER issuance: SUM(DEPOSIT) legs, including seeds/demo credits.', example: '12000000.000000000000000000' })
  ledgerIssuedSupply!: string;

  @ApiProperty({ description: 'Ledger burned: SUM(BURN) legs.', example: '480000.000000000000000000' })
  ledgerBurnedSupply!: string;

  @ApiProperty({ description: 'Ledger circulating: issued minus withdrawals minus burns.', example: '11000000.000000000000000000' })
  ledgerCirculatingSupply!: string;

  @ApiProperty({ description: 'Treasury wallet available EMBER in PostgreSQL.', example: '9200000.000000000000000000' })
  treasuryAvailableEmber!: string | null;

  @ApiProperty({ description: 'Sum of CONFIRMED mint requests (platform-auditable issuance).', example: '10000000.000000000000000000' })
  confirmedMintRequestsTotal!: string;

  @ApiProperty({ description: 'Ledger issuance with no confirmed on-chain mint behind it (seed/demo EMBER).', example: '2000000.000000000000000000' })
  seedAndDemoIssuedEstimate!: string;

  @ApiProperty({ description: 'CONFIRMED mint requests without an ingested TokensMinted event.', example: 0 })
  confirmedMintsWithMissingEvent!: number;

  @ApiProperty({ description: 'SUBMITTED/PENDING mint requests still unconfirmed.', example: 0 })
  unconfirmedMintRequests!: number;

  static from(view: {
    ledgerIssuedSupply: string;
    ledgerBurnedSupply: string;
    ledgerCirculatingSupply: string;
    treasuryAvailableEmber: string | null;
    confirmedMintRequestsTotal: string;
    seedAndDemoIssuedEstimate: string;
    confirmedMintsWithMissingEvent: number;
    unconfirmedMintRequests: number;
  }): ReconciliationOffChainBlockDto {
    const dto = new ReconciliationOffChainBlockDto();
    dto.ledgerIssuedSupply = view.ledgerIssuedSupply;
    dto.ledgerBurnedSupply = view.ledgerBurnedSupply;
    dto.ledgerCirculatingSupply = view.ledgerCirculatingSupply;
    dto.treasuryAvailableEmber = view.treasuryAvailableEmber;
    dto.confirmedMintRequestsTotal = view.confirmedMintRequestsTotal;
    dto.seedAndDemoIssuedEstimate = view.seedAndDemoIssuedEstimate;
    dto.confirmedMintsWithMissingEvent = view.confirmedMintsWithMissingEvent;
    dto.unconfirmedMintRequests = view.unconfirmedMintRequests;
    return dto;
  }
}

export class ReconciliationDifferenceDto {
  @ApiProperty({ description: 'What differs.', example: 'total_supply_vs_ledger_circulating' })
  kind!: string;

  @ApiProperty({ description: 'On-chain side of the comparison.', example: '10000000.000000000000000000' })
  onChainValue!: string;

  @ApiProperty({ description: 'Off-chain side of the comparison.', example: '11000000.000000000000000000' })
  offChainValue!: string;
}

export class ReconciliationResponseDto {
  @ApiProperty({ description: 'This comparison reconciles the on-chain token against the PostgreSQL ledger; differences are reported, never mutated.' })
  note!: string;

  @ApiProperty({ type: ReconciliationOnChainBlockDto })
  onChain!: ReconciliationOnChainBlockDto;

  @ApiProperty({ type: ReconciliationOffChainBlockDto })
  offChain!: ReconciliationOffChainBlockDto;

  @ApiProperty({ type: [ReconciliationDifferenceDto] })
  differences!: ReconciliationDifferenceDto[];

  static from(view: {
    note: string;
    onChain: {
      totalSupply: string;
      maxSupply: string;
      treasuryBalance: string;
      mintedEventsTotal: string;
      burnedEventsTotal: string;
    };
    offChain: {
      ledgerIssuedSupply: string;
      ledgerBurnedSupply: string;
      ledgerCirculatingSupply: string;
      treasuryAvailableEmber: string | null;
      confirmedMintRequestsTotal: string;
      seedAndDemoIssuedEstimate: string;
      confirmedMintsWithMissingEvent: number;
      unconfirmedMintRequests: number;
    };
    differences: { kind: string; onChainValue: string; offChainValue: string }[];
  }): ReconciliationResponseDto {
    const dto = new ReconciliationResponseDto();
    dto.note = view.note;
    dto.onChain = ReconciliationOnChainBlockDto.from(view.onChain);
    dto.offChain = ReconciliationOffChainBlockDto.from(view.offChain);
    dto.differences = view.differences.map((difference) => {
      const row = new ReconciliationDifferenceDto();
      row.kind = difference.kind;
      row.onChainValue = difference.onChainValue;
      row.offChainValue = difference.offChainValue;
      return row;
    });
    return dto;
  }
}

export class EventSyncResponseDto {
  @ApiProperty({ description: 'Scanned block range start (from configuration).', example: 0 })
  fromBlock!: number;

  @ApiProperty({ description: 'Scanned block range end (latest at scan time).', example: '1250' })
  toBlock!: string;

  @ApiProperty({ description: 'Events read from the chain.', example: 4 })
  scanned!: number;

  @ApiProperty({ description: 'New event rows written; re-scans are no-ops by dedupe constraint.', example: 4 })
  ingested!: number;

  @ApiProperty({ description: 'Events linked to a mint request or burn row by transaction hash.', example: 4 })
  linked!: number;

  static from(view: { fromBlock: number; toBlock: string; scanned: number; ingested: number; linked: number }): EventSyncResponseDto {
    const dto = new EventSyncResponseDto();
    dto.fromBlock = view.fromBlock;
    dto.toBlock = view.toBlock;
    dto.scanned = view.scanned;
    dto.ingested = view.ingested;
    dto.linked = view.linked;
    return dto;
  }
}

export class RecoveryResponseDto {
  @ApiProperty({ description: 'Mint requests examined.', example: 2 })
  examined!: number;

  @ApiProperty({ description: 'Requests moved to CONFIRMED by this recovery run.', example: 1 })
  confirmed!: number;

  @ApiProperty({ description: 'Requests moved to FAILED by this recovery run.', example: 0 })
  failed!: number;

  @ApiProperty({ description: 'Requests left in their current state for the operator.', example: 1 })
  stillOpen!: number;

  static from(view: { examined: number; confirmed: number; failed: number; stillOpen: number }): RecoveryResponseDto {
    const dto = new RecoveryResponseDto();
    dto.examined = view.examined;
    dto.confirmed = view.confirmed;
    dto.failed = view.failed;
    dto.stillOpen = view.stillOpen;
    return dto;
  }
}
