import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';

import { Roles } from '../rbac/roles.decorator';
import { TreasurySummaryResponseDto } from './dto/treasury-summary-response.dto';
import { TreasuryService } from './treasury.service';

/**
 * MODULE 12 - treasury guardrail read routes.
 *
 * Authenticated like every other route (the global guard from Module 02):
 * there is no public route and no `@CurrentUser`, because the payload is the
 * platform treasury's system state, not caller-owned data - it contains no
 * individual user's balances or transactions (the USDT utilization aggregate
 * is scoped to the treasury wallet only).
 *
 * One endpoint, deliberately: enforcement lives where the money moves
 * (Module 11's burn transaction, via the exported reserve guard), not in a
 * separate sync or dry-run route this module would have to keep honest.
 * Every response here is produced without a single mutation.
 */
@ApiTags('treasury')
@ApiBearerAuth()
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Get('summary')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'The platform treasury balance/health snapshot, read-only (admin only)',
    description:
      'Treasury EMBER and USDT balances, wallet state, the computed 30% reserve floor over cumulative qualifying treasury EMBER funding (DEPOSIT legs), discretionary capacity above the floor, the approved demo monthly capacity in INR (₹30 crore by default, converted to USDT for display at the configured display-only rate) with treasury-wallet-scoped utilization in the current UTC month, and platform-wide recorded tokenomics activity. Reporting-only: writes nothing and blocks nothing - reserve enforcement happens inside Module 11\'s burn transaction, not on this route. Requires PLATFORM_ADMIN.',
  })
  @ApiOkResponse({ type: TreasurySummaryResponseDto })
  async summary(): Promise<TreasurySummaryResponseDto> {
    return TreasurySummaryResponseDto.from(await this.treasuryService.summary());
  }
}
