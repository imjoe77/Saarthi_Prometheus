import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Role } from '@prisma/client';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../rbac/roles.decorator';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { ListStrategiesQueryDto } from './dto/list-strategies-query.dto';
import { PublicStrategyDto } from './dto/public-strategy.dto';
import {
  PublicStrategyPageDto,
  StrategyPageDto,
} from './dto/strategy-page.dto';
import { StrategyResponseDto } from './dto/strategy-response.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import { StrategyService } from './strategy.service';

/**
 * MODULE 05 - the strategy registry over HTTP.
 *
 * Every route here is authenticated. The global guard from Module 02 is
 * default-deny and nothing in this controller opts out with `@Public()`,
 * including discovery: browsing the public catalogue is still a signed-in
 * action, because who is browsing is the input to what a later module may let
 * them do with what they find.
 *
 * THE OWNER IS THE TOKEN. There is no `ownerId` in any body, no `:userId` in any
 * path and no query parameter that would change it, so a caller cannot file,
 * rename or retire somebody else's strategy - and cannot enumerate what other
 * users own either.
 *
 * THERE IS NO DELETE ROUTE, and that is a design decision rather than an omission.
 * Strategies will carry follow and copy history (Modules 06/07), and a strategy
 * that somebody acted on is not the owner's private note to erase. Retirement is
 * `PATCH { "status": "ARCHIVED" }`, which is one-way.
 *
 * `me` is declared before `:id` so the literal path wins over the parameter. Both
 * are stable routes; the order is the only thing that keeps `/strategies/me` from
 * being parsed as a strategy id and rejected.
 */
@ApiTags('strategies')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('strategies')
export class StrategyController {
  constructor(private readonly strategyService: StrategyService) {}

  @Post()
  @Roles(Role.EXPERT_TRADER, Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: "Create one of the caller's strategies",
    description:
      'Created ACTIVE. Visibility defaults to PRIVATE; pass PUBLIC to publish it for discovery. ' +
      'Names are unique per account, compared case-insensitively. Requires EXPERT_TRADER or PLATFORM_ADMIN.',
  })
  @ApiCreatedResponse({ type: StrategyResponseDto })
  @ApiConflictResponse({ description: 'The caller already owns a strategy with this name.' })
  async create(
    @CurrentUser() user: AuthContext,
    @Body() body: CreateStrategyDto,
  ): Promise<StrategyResponseDto> {
    return StrategyResponseDto.from(await this.strategyService.create(user.id, body));
  }

  @Get()
  @ApiOperation({
    summary: 'Browse public strategies',
    description:
      'The public catalogue: PUBLIC and ACTIVE strategies from every account, newest first. ' +
      'Owner identity is not included in the response. Requires authentication; the global guard denies anonymous requests.',
  })
  @ApiOkResponse({ type: PublicStrategyPageDto })
  async discover(@Query() query: ListStrategiesQueryDto): Promise<PublicStrategyPageDto> {
    // Only the page parameters are forwarded. `status` and `visibility` are
    // ignored here by design - they would let a client ask for rows this route
    // must never return, and the service pins both regardless.
    const page = await this.strategyService.listPublic({
      page: query.page,
      limit: query.limit,
    });

    return {
      items: page.items.map((strategy) => PublicStrategyDto.from(strategy)),
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    };
  }

  @Get('me')
  @Roles(Role.EXPERT_TRADER, Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: "List the caller's own strategies",
    description:
      'Newest first, offset-paginated. Includes archived strategies unless filtered out. The owner sees their own records in full; this is the only route that returns the owner-shaped DTO. Requires EXPERT_TRADER or PLATFORM_ADMIN.',
  })
  @ApiOkResponse({ type: StrategyPageDto })
  async mine(
    @CurrentUser() user: AuthContext,
    @Query() query: ListStrategiesQueryDto,
  ): Promise<StrategyPageDto> {
    const page = await this.strategyService.listForOwner(user.id, query);

    return {
      items: page.items.map((strategy) => StrategyResponseDto.from(strategy)),
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one strategy',
    description:
      'The owner receives the full record, including an archived one. Any other authenticated user receives it only while it is PUBLIC and ACTIVE, and receives the narrower shape with no owner identity. ' +
      'A strategy that is not visible is reported as not found rather than as forbidden.',
  })
  @ApiOkResponse({ type: StrategyResponseDto, description: 'The caller owns this strategy.' })
  @ApiOkResponse({ type: PublicStrategyDto, description: 'A public, active strategy belonging to somebody else.' })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one the caller may see.' })
  async findOne(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StrategyResponseDto | PublicStrategyDto> {
    const strategy = await this.strategyService.findVisibleTo(user.id, id);

    // The same route serves two audiences with two shapes. Which one is decided by
    // ownership, and the DTOs share no owner field, so the wider shape cannot be
    // returned by accident - there is nothing in it that another user may read.
    return strategy.ownerId === user.id
      ? StrategyResponseDto.from(strategy)
      : PublicStrategyDto.from(strategy);
  }

  @Patch(':id')
  @Roles(Role.EXPERT_TRADER, Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: "Change one of the caller's strategies",
    description:
      'Every field is optional. Send { "status": "ARCHIVED" } to retire the strategy permanently; ' +
      'there is no way back, and an archived strategy refuses every further change. Send an empty description to clear it. Requires EXPERT_TRADER or PLATFORM_ADMIN.',
  })
  @ApiOkResponse({ type: StrategyResponseDto })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one the caller owns.' })
  @ApiConflictResponse({ description: 'The name is taken, or the strategy is archived.' })
  @ApiBadRequestResponse({ description: 'A field failed validation - for example a status other than ARCHIVED.' })
  async update(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateStrategyDto,
  ): Promise<StrategyResponseDto> {
    return StrategyResponseDto.from(await this.strategyService.updateOwned(user.id, id, body));
  }
}
