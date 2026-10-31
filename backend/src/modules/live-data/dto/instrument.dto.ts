import { ApiProperty } from '@nestjs/swagger';

import type { MarketInstrument } from '../instruments/instrument-catalogue';

/**
 * MODULE 06c - one entry of the read-only live-market catalogue.
 *
 * THE CATALOGUE IS THE CLOSED SET. `GET /api/market-data/instruments` returns
 * exactly the eight supported instruments, in the module's own display order,
 * with the facts an order form and a chart need: the liquidity class (which
 * decides the session rule), the venue, the quote currency and the precision a
 * fill quantity may carry. It changes only in code, never in a schema, so a
 * client can cache it for the life of a page.
 */
export class InstrumentDto {
  @ApiProperty({ description: 'Canonical symbol, exactly as this module spells it.', example: 'BTC/USD' })
  symbol!: string;

  @ApiProperty({ description: 'STOCK trades a regular US session; CRYPTO trades 24/7.', enum: ['STOCK', 'CRYPTO'] })
  kind!: 'STOCK' | 'CRYPTO';

  @ApiProperty({ description: 'Human display name.', example: 'Bitcoin' })
  name!: string;

  @ApiProperty({ description: 'Primary venue label, informational.', example: 'crypto' })
  venue!: string;

  @ApiProperty({ description: 'Quote currency of every live and paper price.', example: 'USD' })
  quoteCurrency!: string;

  @ApiProperty({ description: 'Decimal places a fill quantity may carry.', example: 8 })
  quantityPrecision!: number;

  static from(instrument: MarketInstrument): InstrumentDto {
    return {
      symbol: instrument.symbol,
      kind: instrument.kind,
      name: instrument.name,
      venue: instrument.venue,
      quoteCurrency: instrument.quoteCurrency,
      quantityPrecision: instrument.quantityPrecision,
    };
  }
}