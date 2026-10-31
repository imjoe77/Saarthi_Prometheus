import { ApiProperty } from '@nestjs/swagger';

import type { MarketDataProviderMode } from '../providers/market-data-provider.port';

/**
 * MODULE 06c - the live-feed status, one get, cheap, for any screen that wants
 * to say "live", "demo" or "off" before it tries to draw a price.
 */
export class FeedStatusDto {
  @ApiProperty({ description: 'Which provider is configured.', enum: ['off', 'fake', 'alpaca'] })
  provider!: MarketDataProviderMode;

  @ApiProperty({ description: 'True when the provider can produce real observations.' })
  enabled!: boolean;

  @ApiProperty({ description: 'True when the observations are deterministic fakes.' })
  isDemo!: boolean;

  @ApiProperty({ description: 'Human sentence for the top of a page.', example: 'Live feed is disabled.' })
  message!: string;

  static from(this: void, provider: MarketDataProviderMode): FeedStatusDto {
    return {
      provider,
      enabled: provider !== 'off',
      isDemo: provider === 'fake',
      message:
        provider === 'off'
          ? 'Live feed is disabled. Set MARKET_DATA_PROVIDER to continue.'
          : provider === 'fake'
            ? 'Showing deterministic demo data. No live feed is connected.'
            : 'Live feed is enabled.',
    };
  }
}