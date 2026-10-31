import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RiskEvaluationDto } from './dto/risk-evaluation.dto';
import { RiskService } from './risk.service';

/**
 * MODULE 06 - the Risk Engine over HTTP.
 *
 * ONE ROUTE, ONE STRATEGY. `GET /api/risk/strategies/:strategyId` is the whole
 * surface. A batch endpoint is deliberately absent: an id list would be a new
 * query contract to keep honest, and nothing yet needs it. Where such an
 * endpoint might sit - `GET /api/risk/strategies?ids=...` - is documented, not
 * built, so the shape exists for a later consumer without a second route to
 * secure, page and test.
 *
 * AUTHENTICATED, LIKE EVERYTHING ELSE. The global guard from Module 02 is
 * default-deny and nothing here opts out with `@Public()`. Reading a risk
 * statement requires knowing who is asking, because visibility of the strategy
 * itself depends on the caller - a stranger must not be able to learn that a
 * private strategy exists, let alone how it moved.
 *
 * EVALUATION IS NOT AN ERROR. `INSUFFICIENT_DATA` returns 200 with a reason:
 * the request was well formed and the strategy was visible, and refusing it
 * with a 4xx would tell a client that a brand-new strategy is somehow
 * malformed. Errors are reserved for what they mean - 400 for an id that is not
 * a UUID, 404 for one that is not visible - so a client can branch on status
 * alone and never parse a message to discover whether its input was wrong.
 *
 * READ-ONLY. The handler computes and maps; it never writes. There is no
 * request body to validate beyond the path parameter, because there is nothing
 * to change.
 */
@ApiTags('risk')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('risk')
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Get('strategies/:strategyId')
  @ApiOperation({
    summary: 'Evaluate the risk of one strategy',
    description:
      "Computes maximum drawdown and volatility from the strategy's daily equity history and classifies it as LOW, MEDIUM or HIGH. " +
      'Returns status INSUFFICIENT_DATA with a reason when there are too few observations to state anything - that is a successful answer, not an error. ' +
      'Metrics and riskLevel are null in that case and are never defaulted. A strategy that is not visible is reported as not found rather than as forbidden.',
  })
  @ApiOkResponse({
    type: RiskEvaluationDto,
    description:
      'Either status EVALUATED with metrics and a riskLevel, or status INSUFFICIENT_DATA with a reason and both of those null.',
  })
  @ApiBadRequestResponse({ description: 'The strategy id is not a UUID.' })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one the caller may see.' })
  async evaluate(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<RiskEvaluationDto> {
    return RiskEvaluationDto.from(await this.riskService.evaluate(user.id, strategyId));
  }
}
