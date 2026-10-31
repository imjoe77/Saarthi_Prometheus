import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import { HealthQueryDto } from './dto/health-query.dto';
import { HealthStatusDto } from './dto/health-status.dto';
import { HealthService } from './health.service';

/**
 * Operational endpoint.
 *
 * Kept in its own module with no domain dependencies so an operator (or a load
 * balancer, or a monitoring agent) can probe it without pulling in feature
 * modules or triggering side effects.
 *
 * Note: rate limiting is not configured yet. It arrives with the auth module
 * (Module 02), which is where per-identity throttling becomes meaningful.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Service and dependency health',
    description:
      'Returns aggregate health. Always responds 200 with a body describing state so the caller can distinguish an application failure from a dependency failure. Pass verbose=true for latency and failure detail.',
  })
  @ApiOkResponse({ type: HealthStatusDto })
  async getHealth(@Query() query: HealthQueryDto): Promise<HealthStatusDto> {
    return this.healthService.check(query.verbose ?? false);
  }
}