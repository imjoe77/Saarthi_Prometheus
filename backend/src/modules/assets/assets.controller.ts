import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AssetsService } from './assets.service';
import { AssetResponseDto } from './dto/asset-response.dto';

/**
 * MODULE 03 — the supported assets.
 *
 * No `@Public()`: the asset catalogue is harmless, but the whole API is
 * authenticated by default and there is no reason for this route to be the one
 * exception. No `userId` or ownership is involved; assets are shared reference
 * data.
 */
@ApiTags('assets')
@ApiBearerAuth()
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  @ApiOperation({
    summary: 'List supported assets',
    description:
      'Returns every active asset. Retired assets are omitted, so a client never offers something that cannot be moved.',
  })
  @ApiOkResponse({ type: [AssetResponseDto] })
  async list(): Promise<AssetResponseDto[]> {
    const assets = await this.assetsService.listActive();
    return assets.map((asset) => AssetResponseDto.from(asset));
  }
}
