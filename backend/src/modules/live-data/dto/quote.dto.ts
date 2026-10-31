import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { MarketDataProviderMode } from '../providers/market-data-provider.port';

/**
 * MODULE 06c - one live quote read, as the market service sees it.
 *
 * AVAILABLE IS THE HONEST FLOOR. A quote for a *known* symbol is always a 200:
 * `available: false` with null prices means the feed said nothing just now
 * (disabled, unconfigured, an empty answer, a refused network), and a client
 * branches on that single flag instead of learning to read an error envelope
 * for "no data right now". `marketState` and `provider` are still reported in
 * that state, because they are facts about the feed rather than about the
 * quote.
 *
 * STALE IS A FACT, NOT A JUDGEMENT. `stale: true` (with prices still present)
 * means the observation is older than the instrument's freshness threshold and
 * no newer one has arrived - a normal transient, not a corruption - and the
 * paper engine refuses to fill on it. A client that wants to accuse the feed
 * of lying has a timestamp to do it with.
 */
export class QuoteDto {
  @ApiProperty({ description: 'Canonical symbol the quote was requested for.', example: 'AAPL' })
  symbol!: string;

  @ApiProperty({ description: 'Which provider produced this answer.', enum: ['off', 'fake', 'alpaca'] })
  provider!: MarketDataProviderMode;

  @ApiProperty({ description: 'Whether a fresh-enough price exists right now.' })
  available!: boolean;

  @ApiPropertyOptional({
    description: 'Midpoint of bid and ask when both are present, else the one that is. Null when unavailable.',
    nullable: true,
  })
  price!: string | null;

  @ApiPropertyOptional({ description: 'Best bid, when the source quoted one.', nullable: true })
  bid!: string | null;

  @ApiPropertyOptional({ description: 'Best ask, when the source quoted one.', nullable: true })
  ask!: string | null;

  @ApiPropertyOptional({
    description: 'When the source published the observation, RFC 3339 UTC. Null when unavailable.',
    nullable: true,
  })
  asOf!: string | null;

  @ApiProperty({ description: 'The observation is older than the instrument freshness threshold.' })
  stale!: boolean;

  @ApiProperty({ description: 'Whether the instrument market is open at server time.', enum: ['OPEN', 'CLOSED'] })
  marketState!: 'OPEN' | 'CLOSED';

  @ApiProperty({ description: 'Deterministic label for the fake provider, so it can never be mistaken for real data.' })
  isDemo!: boolean;
}