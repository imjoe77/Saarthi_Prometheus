import { Injectable } from '@nestjs/common';

import type { LiveBar, LiveQuote, MarketDataProvider } from './market-data-provider.port';

/**
 * MODULE 06c - the provider for a disabled live feed.
 *
 * DEFAULT AND SAFE. `off` is the configuration default and the only default
 * that cannot misbehave: no credentials, no outbound network, nothing to fail
 * at boot. Every endpoint honestly reports absence (quotes) or an empty set
 * (bars), and the service translates that into the documented 503s, so a fresh
 * deployment with no Alpaca account is a working deployment with a disabled
 * feed rather than a broken one.
 *
 * NOT A STUB. This is the real behavior of the disabled configuration, the same
 * way `EmptyEquitySeries` is the real behavior of "no equity history exists".
 */
@Injectable()
export class OffMarketDataProvider implements MarketDataProvider {
  readonly mode = 'off' as const;

  latestQuote(): Promise<LiveQuote | null> {
    return Promise.resolve(null);
  }

  bars(): Promise<LiveBar[]> {
    return Promise.resolve([]);
  }
}