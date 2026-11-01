import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DomainException } from '../../common/errors/domain.exception';
import { decimalString } from '../market-data/domain/decimal-string';
import { CopyWorkerService } from './copy-worker.service';
import { CopyExplainerService } from './copy-explainer.service';
import { CopyService } from './copy.service';
import {
  CopyEventPageDto,
  CopyEventResponseDto,
  CopySyncResponseDto,
} from './dto/copy-event-response.dto';
import {
  CopyPerformanceResponseDto,
  toPerformanceResponse,
} from './dto/copy-performance-response.dto';
import {
  CopyAccountResponseDto,
  CopyAggregateAccountResponseDto,
  CopyFollowAccountResponseDto,
  CopyPositionResponseDto,
} from './dto/copy-account-response.dto';
import { CopyPageQueryDto } from './dto/copy-page-query.dto';
import { CreateFollowDto } from './dto/create-follow.dto';
import {
  CopyExplanationResponseDto,
  ExplainCopyDto,
} from './dto/explain-copy.dto';
import {
  FollowPageDto,
  FollowResponseDto,
  FollowerPageDto,
  FollowerResponseDto,
} from './dto/follow-response.dto';
import {
  ConnectExpertResponseDto,
  ExpertChatMessageDto,
  ExpertChatResponseDto,
} from './dto/connect-expert.dto';
import { UpdateFollowConfigDto } from './dto/update-follow-config.dto';

/**
 * MODULE 07 - copy trading over HTTP.
 *
 * THE TOKEN IS THE FOLLOWER. No route accepts a `followerId`, a `userId` or
 * any other handle: every one of them reads `user.id` from the verified token.
 * A caller therefore cannot follow on somebody else's behalf, read somebody
 * else's copy cash, or page through somebody else's history - the id they would
 * need to supply does not exist anywhere in this controller's surface.
 *
 * ALL FOLLOWING IS SIMULATED. Every balance this module reports is a paper
 * balance seeded by Module 07, distinct from Module 03's wallet and from the
 * expert's Module 06c paper account. Nothing here places a real order, and the
 * engine it drives only reads the expert's committed paper fills.
 *
 * ONE CONTROLLER, TWELVE ROUTES, ALL UNDER `/copy`. Follow state lives under
 * `/copy/follows` rather than under `/strategies/:id` because a follow is a
 * relationship the *caller* owns, not a property of the strategy - the only
 * strategy-scoped read here is the follower list, which is the strategy
 * owner's, not the follower's. The two book-wide routes - `/copy/events` and
 * `/copy/performance` - sit beside `/copy/account`, which is the third read
 * that spans every follow at once.
 *
 * FAILURE VOCABULARY, FOR THE WHOLE CONTROLLER:
 *  - 400 - the request is malformed, or the allocation is out of (0, 1].
 *  - 404 - no such follow for this caller, or a strategy this caller cannot
 *          see (Module 05's rule: not-yours reads as not-there).
 *  - 409 - the caller already follows this strategy, or tried to follow their
 *          own.
 * Ownership of a strategy is never a 403 here; it is a 404, for the reason
 * Module 05 recorded.
 */
@ApiTags('copy')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('copy')
export class CopyController {
  constructor(
    private readonly copyService: CopyService,
    private readonly copyWorkerService: CopyWorkerService,
    private readonly copyExplainerService: CopyExplainerService,
  ) {}

  // ---------------------------------------------------------------------------
  // Follows
  // ---------------------------------------------------------------------------

  @Post('follows')
  @ApiOperation({
    summary: 'Follow a public strategy',
    description:
      'Creates the caller\'s follow for that strategy, or reactivates an unfollowed one. Allocation is required and must be in (0, 1]. ' +
      'The copy cursor is seeded at this instant: the expert\'s next fill is copied, and any fill that already exists is never back-filled. ' +
      'The account is not provisioned here - it appears with the first eligible fill the engine consumes.',
  })
  @ApiCreatedResponse({ type: FollowResponseDto })
  @ApiBadRequestResponse({ description: 'Allocation outside (0, 1], or a malformed strategy id.' })
  @ApiConflictResponse({ description: 'The caller already follows this strategy, or it is their own.' })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one this caller may see.' })
  async follow(
    @CurrentUser() user: AuthContext,
    @Body() body: CreateFollowDto,
  ): Promise<FollowResponseDto> {
    const record = await this.copyService.follow(user.id, body.strategyId, body.allocationFraction);
    return FollowResponseDto.from(record);
  }

  @Get('follows')
  @ApiOperation({
    summary: "List the caller's follows",
    description:
      'Newest first, offset-paginated, with copied and rejected counts per follow. Strategies that were archived or ' +
      'unpublished after being followed are included - a follow is the caller\'s own record and is not re-filtered ' +
      'by discovery. `eligibility` on each row says whether it is copying right now.',
  })
  @ApiOkResponse({ type: FollowPageDto })
  async list(
    @CurrentUser() user: AuthContext,
    @Query() query: CopyPageQueryDto,
  ): Promise<FollowPageDto> {
    const page = await this.copyService.listFollows(user.id, query);

    return {
      items: page.items.map((record) => FollowResponseDto.from(record)),
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    };
  }

  @Get('follows/:strategyId')
  @ApiOperation({
    summary: 'Read one follow and its processing state',
    description:
      'The follow itself, its derived eligibility, its outcome counts, and whether the expert has committed a fill ' +
      'this follow has not consumed yet. 404 when the caller does not follow that strategy.',
  })
  @ApiOkResponse({ type: FollowResponseDto })
  @ApiNotFoundResponse({ description: 'No such follow for this caller.' })
  async status(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<FollowResponseDto> {
    return FollowResponseDto.from(await this.copyService.getStatus(user.id, strategyId));
  }

  @Patch('follows/:strategyId')
  @ApiOperation({
    summary: "Change one of the caller's follow allocations",
    description:
      'Applies to the next fill the engine consumes. Events already in the history keep the fraction they were sized ' +
      'with, so changing this never rewrites a past execution. Allowed while unfollowed as well as active.',
  })
  @ApiOkResponse({ type: FollowResponseDto })
  @ApiBadRequestResponse({ description: 'Allocation outside (0, 1].' })
  @ApiNotFoundResponse({ description: 'No such follow for this caller.' })
  async update(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Body() body: UpdateFollowConfigDto,
  ): Promise<FollowResponseDto> {
    const record = await this.copyService.setAllocation(user.id, strategyId, body.allocationFraction);
    return FollowResponseDto.from(record);
  }

  @Delete('follows/:strategyId')
  @ApiOperation({
    summary: 'Stop following a strategy',
    description:
      'Idempotent: unfollowing twice returns the same state rather than an error. Copying stops at once, but cash and ' +
      'positions are NOT liquidated - there is no price in this module to liquidate at, and inventing one would move a ' +
      'balance on a guess. The account stays readable and resumes only if the caller follows again. Fills committed but ' +
      'not yet consumed are still recorded afterwards as FOLLOW_NOT_ACTIVE: never copied, never silently dropped either.',
  })
  @ApiOkResponse({ type: FollowResponseDto })
  @ApiNotFoundResponse({ description: 'No such follow for this caller.' })
  async unfollow(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<FollowResponseDto> {
    const record = await this.copyService.unfollow(user.id, strategyId);
    return FollowResponseDto.from(record);
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  @Post('follows/:strategyId/sync')
  // An action, not a resource: the response reports work this call did rather
  // than a resource it created, so 200 - not the 201 a POST would default to.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consume this follow\'s pending fills now',
    description:
      'Runs the same engine loop the background worker runs, once, for this one follow, and returns how many events ' +
      'were written plus the follow\'s state immediately afterwards. This is the responsive path a screen uses after ' +
      'an expert trades; the worker is only the schedule that means nobody has to call it.',
  })
  @ApiOkResponse({ type: CopySyncResponseDto })
  @ApiNotFoundResponse({ description: 'No such follow for this caller.' })
  async sync(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<CopySyncResponseDto> {
    const { consumed } = await this.copyWorkerService.syncFollow(user.id, strategyId);
    const status = await this.copyService.getStatus(user.id, strategyId);
    return { consumed, status: FollowResponseDto.from(status) };
  }

  @Get('follows/:strategyId/orders')
  @ApiOperation({
    summary: 'Copy history for one follow',
    description:
      'Newest first, offset-paginated. Refusals are in the same list as copies, each with its reason, because a gap in ' +
      'the copies with no explanation is worse than a row that says why nothing was copied.',
  })
  @ApiOkResponse({ type: CopyEventPageDto })
  @ApiNotFoundResponse({ description: 'No such follow for this caller.' })
  async orders(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Query() query: CopyPageQueryDto,
  ): Promise<CopyEventPageDto> {
    const page = await this.copyService.listEvents(user.id, strategyId, query);

    return {
      items: page.items.map((record) => CopyEventResponseDto.from(record.event, record.strategy)),
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    };
  }

  // ---------------------------------------------------------------------------
  // The whole book
  // ---------------------------------------------------------------------------

  @Get('events')
  @ApiOperation({
    summary: 'Every copy the caller has made, across every follow',
    description:
      'Newest first, offset-paginated. Each row carries the strategy whose fill it mirrors, because a copy without ' +
      'its strategy is a row of numbers with nothing to attribute them to. Refusals are included, with their reasons, ' +
      'for the same reason the per-follow history includes them: a gap in the copies with no explanation is worse ' +
      'than a row that says why nothing was copied.',
  })
  @ApiOkResponse({ type: CopyEventPageDto })
  async events(
    @CurrentUser() user: AuthContext,
    @Query() query: CopyPageQueryDto,
  ): Promise<CopyEventPageDto> {
    const page = await this.copyService.listFollowEvents(user.id, query);

    return {
      items: page.items.map((record) => CopyEventResponseDto.from(record.event, record.strategy)),
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    };
  }

  @Get('performance')
  @ApiOperation({
    summary: "The caller's realised profit and loss, and the path that reached it",
    description:
      'The total is the ledger\'s own figure, summed over the caller\'s separate pots. The points are the same ' +
      'ledger replayed: one per executed fill, in the order the engine consumed them, each carrying the profit or ' +
      'loss that fill realised and the running total. Refusals are excluded from the path because they moved ' +
      'nothing. No unrealised mark - pricing an open position needs a quote this module does not fetch.',
  })
  @ApiOkResponse({ type: CopyPerformanceResponseDto })
  async performance(@CurrentUser() user: AuthContext): Promise<CopyPerformanceResponseDto> {
    return toPerformanceResponse(await this.copyService.listPerformance(user.id));
  }

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------

  @Get('follows/:strategyId/account')
  @ApiOperation({
    summary: 'Copy cash and positions for one follow',
    description:
      'Null account until the first eligible fill provisions it. Never Module 03 money and never the expert\'s paper ' +
      'account: each follow holds its own simulated pot. Positions are marked at the market, so each one reports ' +
      'what it is worth and what it would realise if closed now. `walletUsdt` is the caller\'s real balance, which ' +
      'is the gate every further copy has to pass.',
  })
  @ApiOkResponse({ type: CopyFollowAccountResponseDto })
  @ApiNotFoundResponse({ description: 'No such follow for this caller.' })
  async followAccount(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<CopyFollowAccountResponseDto> {
    const { account, positions, walletUsdt } = await this.copyService.getFollowAccount(user.id, strategyId);

    return {
      account: account === null ? null : CopyAccountResponseDto.from(account),
      positions: positions.map((position) => CopyPositionResponseDto.from(position)),
      walletUsdt: decimalString(walletUsdt),
    };
  }

  @Get('account')
  @ApiOperation({
    summary: "The caller's copy cash across every follow",
    description:
      'A sum of separate pots, not one pooled balance - `followCount` is part of the answer for exactly that reason. ' +
      'Positions are merged per symbol AND direction, so a long and a short in the same instrument stay two rows. ' +
      'Each row is marked at the market. `walletUsdt` is the caller\'s real balance, the gate every further copy ' +
      'has to pass.',
  })
  @ApiOkResponse({ type: CopyAggregateAccountResponseDto })
  async aggregateAccount(@CurrentUser() user: AuthContext): Promise<CopyAggregateAccountResponseDto> {
    return CopyAggregateAccountResponseDto.from(await this.copyService.getAggregateAccount(user.id));
  }

  // ---------------------------------------------------------------------------
  // Explanation
  // ---------------------------------------------------------------------------

  @Post('explain')
  // An explanation is an answer, not a resource that was created, so 200.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Explain one of the caller's copy trades",
    description:
      "Answers \"why was it short at this point?\", \"why did it sell here?\", \"why was that not copied?\" and \"why is my size different?\" " +
      "from the caller's own copy ledger - the fills, their directions, prices, sizes, allocations, outcomes and refusal reasons, " +
      "and the positions they produced. " +
      'The caller may point at a market or a row; every fact in the answer is read server-side from the ledger, so nothing the request carries can put a number into the answer. ' +
      '404 when the caller holds no copy book that could answer the question, which is the signal to fall back to a general explanation.',
  })
  @ApiOkResponse({ type: CopyExplanationResponseDto })
  @ApiNotFoundResponse({ description: 'The caller holds nothing in the copy book that could answer this question.' })
  async explain(
    @CurrentUser() user: AuthContext,
    @Body() body: ExplainCopyDto,
  ): Promise<CopyExplanationResponseDto> {
    const explanation = await this.copyExplainerService.explain(
      user.id,
      body.query,
      body.symbol ?? null,
      body.focusId ?? null,
    );

    if (explanation === null) {
      throw DomainException.notFound('An explanation for this copy book');
    }

    return explanation;
  }

  @Post('strategies/:strategyId/connect-expert')
  @ApiOperation({
    summary: 'Directly connect and unlock consultation with an expert trader for 10 EMBER',
    description:
      'Deducts 10 EMBER from the caller\'s wallet and unlocks a direct 1-on-1 consultation session with the expert behind this strategy.',
  })
  @ApiCreatedResponse({ type: ConnectExpertResponseDto })
  async connectExpert(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<ConnectExpertResponseDto> {
    return this.copyService.connectExpert(user.id, strategyId);
  }

  @Post('strategies/:strategyId/expert-chat')
  @ApiOperation({
    summary: 'Send a message to the expert trader in an unlocked consultation session',
    description:
      'Receives guidance and trade explanations directly tailored to this strategy and market movements.',
  })
  @ApiOkResponse({ type: ExpertChatResponseDto })
  async expertChat(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Body() body: ExpertChatMessageDto,
  ): Promise<ExpertChatResponseDto> {
    return this.copyService.chatWithExpert(user.id, strategyId, body.message);
  }

  // ---------------------------------------------------------------------------
  // Owner view
  // ---------------------------------------------------------------------------

  @Get('strategies/:strategyId/followers')
  @ApiOperation({
    summary: 'Who follows one of my strategies',
    description:
      'Owner-only: a caller who does not own the strategy gets 404, never a 403 that would confirm the id exists. ' +
      'Follower addresses are masked to first character plus domain - enough to recognise an audience, useless for ' +
      'contacting it.',
  })
  @ApiOkResponse({ type: FollowerPageDto })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one this caller owns.' })
  async followers(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Query() query: CopyPageQueryDto,
  ): Promise<FollowerPageDto> {
    const page = await this.copyService.listFollowers(user.id, strategyId, query);

    return {
      items: page.items.map((record) => FollowerResponseDto.from(record)),
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    };
  }
}
