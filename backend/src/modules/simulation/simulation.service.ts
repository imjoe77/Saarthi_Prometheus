import { Injectable } from '@nestjs/common';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { StrategyService } from '../strategy/strategy.service';
import { BalanceResponseDto } from './dto/balance-response.dto';
import { FillResponseDto } from './dto/fill-response.dto';
import { SimulationBalancePageDto, SimulationFillPageDto } from './dto/simulation-page.dto';
import { SimulationResponseDto } from './dto/simulation-response.dto';
import {
  findSimulation,
  pageBalances,
  pageFills,
  runSimulation,
} from './persistence/simulation-store';
import { findRule } from './rules/rule-catalog';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/**
 * MODULE 06b - the read side of a simulation.
 *
 * EVERY READ PASSES THROUGH STRATEGY VISIBILITY FIRST. There is no "public
 * simulation" concept, and there must not be one: a strategy is either visible
 * to the caller or it is not, and the simulation is evidence *about* that
 * strategy. Measuring evidence about a hidden strategy would leak it through a
 * second door, so `findVisibleTo` is the gate everything here walks through,
 * and it reports a hidden strategy as not found rather than asking the caller
 * to interpret a denial.
 *
 * A VISIBLE STRATEGY WITHOUT A SIMULATION IS `404`. "This strategy exists but
 * was never simulated" is a different statement, and a client that wants to
 * distinguish it from "this strategy does not exist" already can - by asking the
 * strategy API and getting a 200. Returning an empty "simulation" would invent
 * a shape for a thing that does not exist.
 *
 * THE WRITE IS HERE FOR THE SEED AND THE SUITE, NOT FOR HTTP. There is no route
 * that simulates, and this is the reason its absence is a design decision rather
 * than an omission: a user-triggered simulation would be a computation running
 * against a dataset the strategy may not match, and the project's rule curves
 * belong to the seed - where the input data and the fee assumption are both
 * visible in the same place.
 */
@Injectable()
export class SimulationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyService: StrategyService,
  ) {}

  async summary(viewerId: string, strategyId: string): Promise<SimulationResponseDto> {
    await this.strategyService.findVisibleTo(viewerId, strategyId);

    const record = await findSimulation(this.prisma, strategyId);
    if (record === null) {
      throw DomainException.notFound('Simulation', strategyId);
    }

    return SimulationResponseDto.from(record);
  }

  async fills(
    viewerId: string,
    strategyId: string,
    pageValue?: number,
    limitValue?: number,
  ): Promise<SimulationFillPageDto> {
    await this.strategyService.findVisibleTo(viewerId, strategyId);

    const page = pageValue ?? DEFAULT_PAGE;
    const limit = limitValue ?? DEFAULT_LIMIT;
    const { items, total } = await pageFills(this.prisma, strategyId, page, limit);

    return {
      items: items.map(FillResponseDto.from),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async balances(
    viewerId: string,
    strategyId: string,
    pageValue?: number,
    limitValue?: number,
  ): Promise<SimulationBalancePageDto> {
    await this.strategyService.findVisibleTo(viewerId, strategyId);

    const page = pageValue ?? DEFAULT_PAGE;
    const limit = limitValue ?? DEFAULT_LIMIT;
    const { items, total } = await pageBalances(this.prisma, strategyId, page, limit);

    return {
      items: items.map(BalanceResponseDto.from),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async runForStrategy(strategyId: string, ruleKey: string): Promise<SimulationResponseDto> {
    const rule = findRule(ruleKey);
    if (rule === null) {
      throw DomainException.badRequest(`Unknown rule '${ruleKey}'.`);
    }

    const record = await runSimulation(this.prisma, strategyId, rule);
    return SimulationResponseDto.from(record);
  }
}