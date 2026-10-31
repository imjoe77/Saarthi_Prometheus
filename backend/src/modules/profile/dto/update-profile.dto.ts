import { IsIn, IsISO31661Alpha2, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The onboarding questionnaire and basic profile, all optional on update so a
 * user can fill it in over several sessions and revise answers later.
 *
 * Enumerated fields use `@IsIn` against the values the frontend offers, so a
 * caller cannot store free-text into a field the UI renders as a choice. The
 * values are plain strings in the database, which keeps future option additions
 * a code change rather than a schema migration.
 */

export const EXPERIENCE_LEVELS = ['NONE', 'BEGINNER', 'INTERMEDIATE', 'EXPERIENCED'] as const;
export const INVESTMENT_CAPITAL_RANGES = [
  'UNDER_10K',
  '10K_50K',
  '50K_250K',
  '250K_1M',
  'OVER_1M',
] as const;
export const CAPITAL_AVAILABILITY = ['SHORT_TERM', 'MEDIUM_TERM', 'LONG_TERM'] as const;
export const RISK_TOLERANCE = ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'] as const;
export const DRAWDOWN_COMFORT = ['LOW', 'MODERATE', 'HIGH'] as const;
export const VOLATILITY_COMFORT = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const PRIMARY_GOALS = ['CAPITAL_PRESERVATION', 'GROWTH', 'BALANCE', 'INCOME'] as const;
export const TIME_HORIZONS = ['UNDER_1_YEAR', '1_3_YEARS', '3_5_YEARS', 'OVER_5_YEARS'] as const;
export const EXPECTED_RETURN_RANGES = ['CONSERVATIVE', 'MODERATE', 'AMBITIOUS'] as const;
export const HOLDING_PERIODS = ['SHORT_TERM', 'MEDIUM_TERM', 'LONG_TERM'] as const;
export const LOSS_REACTIONS = ['SELL', 'HOLD', 'BUY_MORE'] as const;
export const LIQUIDITY_NEEDS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const CONTRIBUTION_FREQUENCIES = ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'FLEXIBLE'] as const;
export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'INR', 'GBP'] as const;

/** Fields required before onboarding may be marked complete. */
export const ONBOARDING_REQUIRED_FIELDS = [
  'experienceLevel',
  'investmentCapitalRange',
  'capitalAvailability',
  'riskTolerance',
  'drawdownComfort',
  'volatilityComfort',
  'primaryGoal',
  'timeHorizon',
  'expectedReturnRange',
  'holdingPeriod',
  'lossReaction',
  'liquidityNeeds',
  'contributionFrequency',
] as const;

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @IsOptional()
  @IsIn(DISPLAY_CURRENCIES)
  displayCurrency?: string;

  @IsOptional()
  @IsIn(EXPERIENCE_LEVELS)
  experienceLevel?: string;

  @IsOptional()
  @IsIn(INVESTMENT_CAPITAL_RANGES)
  investmentCapitalRange?: string;

  @IsOptional()
  @IsIn(CAPITAL_AVAILABILITY)
  capitalAvailability?: string;

  @IsOptional()
  @IsIn(RISK_TOLERANCE)
  riskTolerance?: string;

  @IsOptional()
  @IsIn(DRAWDOWN_COMFORT)
  drawdownComfort?: string;

  @IsOptional()
  @IsIn(VOLATILITY_COMFORT)
  volatilityComfort?: string;

  @IsOptional()
  @IsIn(PRIMARY_GOALS)
  primaryGoal?: string;

  @IsOptional()
  @IsIn(TIME_HORIZONS)
  timeHorizon?: string;

  @IsOptional()
  @IsIn(EXPECTED_RETURN_RANGES)
  expectedReturnRange?: string;

  @IsOptional()
  @IsIn(HOLDING_PERIODS)
  holdingPeriod?: string;

  @IsOptional()
  @IsIn(LOSS_REACTIONS)
  lossReaction?: string;

  @IsOptional()
  @IsIn(LIQUIDITY_NEEDS)
  liquidityNeeds?: string;

  @IsOptional()
  @IsIn(CONTRIBUTION_FREQUENCIES)
  contributionFrequency?: string;
}

/** The profile as the API returns it. */
export class ProfileResponseDto {
  displayName!: string | null;
  country!: string | null;
  displayCurrency!: string | null;
  experienceLevel!: string | null;
  investmentCapitalRange!: string | null;
  capitalAvailability!: string | null;
  riskTolerance!: string | null;
  drawdownComfort!: string | null;
  volatilityComfort!: string | null;
  primaryGoal!: string | null;
  timeHorizon!: string | null;
  expectedReturnRange!: string | null;
  holdingPeriod!: string | null;
  lossReaction!: string | null;
  liquidityNeeds!: string | null;
  contributionFrequency!: string | null;
  onboardingCompletedAt!: string | null;
}
