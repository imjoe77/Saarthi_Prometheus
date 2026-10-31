import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EmberHubStatementDto {
  @ApiProperty({ description: 'The configured distribution price, INR per EMBER. Configuration, not a market observation.', example: '2.45' })
  baselinePriceInr!: string;

  @ApiPropertyOptional({ description: 'The per-user daily EMBER limit; null when unset (unlimited).', example: '10000' })
  dailyEmberLimit!: string | null;

  @ApiPropertyOptional({ description: 'The per-user monthly EMBER limit; null when unset (unlimited).', example: '100000' })
  monthlyEmberLimit!: string | null;

  @ApiPropertyOptional({ description: 'The configured display-only USDT/INR rate used to convert the INR total into the USDT payment legs; null when unset.', example: '88.5' })
  usdtRateInr!: string | null;

  @ApiPropertyOptional({ description: 'The treasury wallet available EMBER inventory - what purchases can actually deliver.' })
  treasuryAvailableEmber!: string | null;

  @ApiProperty({ description: 'Purchases are internal transfers: treasury EMBER -> user EMBER and user USDT -> treasury USDT. On-chain supply does not change.' })
  note!: string;

  static from(view: {
    baselinePriceInr: string;
    dailyEmberLimit: string | null;
    monthlyEmberLimit: string | null;
    usdtRateInr: string | null;
    treasuryAvailableEmber: string | null;
    note: string;
  }): EmberHubStatementDto {
    const dto = new EmberHubStatementDto();
    dto.baselinePriceInr = view.baselinePriceInr;
    dto.dailyEmberLimit = view.dailyEmberLimit;
    dto.monthlyEmberLimit = view.monthlyEmberLimit;
    dto.usdtRateInr = view.usdtRateInr;
    dto.treasuryAvailableEmber = view.treasuryAvailableEmber;
    dto.note = view.note;
    return dto;
  }
}

export class EmberHubScenarioDto {
  @ApiProperty({ description: 'The scenario name, illustrative only.', example: 'First taste' })
  label!: string;

  @ApiProperty({ description: 'The illustrative EMBER quantity.', example: '250' })
  emberAmount!: string;

  @ApiProperty({ description: 'The INR cost of that quantity at the configured price.', example: '612.50' })
  totalInr!: string;

  @ApiPropertyOptional({ description: 'The USDT cost at the display-only rate; null when the rate is unavailable.', example: '6.92' })
  totalUsdt!: string | null;
}

export class EmberHubScenariosResponseDto {
  @ApiProperty({ description: 'Everything here is display-only simulation: no purchase is computed, recorded or executed.' })
  note!: string;

  @ApiProperty({ type: [EmberHubScenarioDto] })
  scenarios!: EmberHubScenarioDto[];

  static from(view: {
    note: string;
    scenarios: { label: string; emberAmount: string; totalInr: string; totalUsdt: string | null }[];
  }): EmberHubScenariosResponseDto {
    const dto = new EmberHubScenariosResponseDto();
    dto.note = view.note;
    dto.scenarios = view.scenarios.map((scenario) => {
      const row = new EmberHubScenarioDto();
      row.label = scenario.label;
      row.emberAmount = scenario.emberAmount;
      row.totalInr = scenario.totalInr;
      row.totalUsdt = scenario.totalUsdt;
      return row;
    });
    return dto;
  }
}
