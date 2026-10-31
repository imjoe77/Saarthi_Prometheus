import { ApiProperty } from '@nestjs/swagger';

import { BarDto } from './bar.dto';

/**
 * MODULE 06c - the bar page envelope.
 *
 * A small object, not a bare array: `isDemo` labels the fake provider the way
 * the quote DTO does, so a chart fed by the development provider can never
 * present invented prices as though they were observed ones.
 */
export class BarsDto {
  @ApiProperty({ description: 'Bars, ascending by time.', type: [BarDto] })
  items!: BarDto[];

  @ApiProperty({ description: 'Deterministic fake data, never a real market observation.' })
  isDemo!: boolean;

  static from(this: void, items: BarDto[], isDemo: boolean): BarsDto {
    return { items, isDemo };
  }
}