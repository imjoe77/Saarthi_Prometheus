import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * MODULE 06c - query parameters for `GET /api/market-data/quotes`.
 *
 * `symbol` lives in the query string, not the path, because the catalogue
 * contains `BTC/USD`: a slash inside a path segment is URL-encoded by clients,
 * decoded by proxies in inconsistent ways, and generally a footgun that a query
 * parameter simply does not have. The symbol is validated against the closed
 * catalogue by the service, which is also who produces the 404 for a symbol
 * that is not in it.
 */
export class QuotesQueryDto {
  @ApiProperty({ description: 'Canonical symbol, exactly as the catalogue spells it.', example: 'BTC/USD' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;
}