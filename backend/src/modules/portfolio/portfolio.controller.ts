import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PortfolioResponseDto } from './dto/portfolio-response.dto';
import { PortfolioService } from './portfolio.service';

/**
 * MODULE 04 - the caller's portfolio.
 *
 * One route, no path parameters. There is no `GET /portfolio/:userId` and no
 * `GET /portfolio/:walletId`, so a caller has no way to name somebody else's
 * portfolio even by accident: the only identity in the request is the verified
 * one the guard attached, and a parameter would only ever be ignored.
 *
 * Read-only, like its service. There is no POST here because there is nothing a
 * browser may legitimately write to a portfolio - a derived view has no state of
 * its own to change.
 */
@ApiTags('portfolio')
@ApiBearerAuth()
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get()
  @ApiOperation({
    summary: "Get the caller's portfolio",
    description:
      'One coherent read model: the wallet, every holding with available/locked/total, categorical composition by asset kind, and a ledger activity summary. Amounts are strings at each asset’s own display precision. There is no valuation or P&L, because the platform has no price source yet.',
  })
  @ApiOkResponse({ type: PortfolioResponseDto })
  async me(@CurrentUser() user: AuthContext): Promise<PortfolioResponseDto> {
    return PortfolioResponseDto.from(await this.portfolioService.getSnapshot(user.id));
  }
}