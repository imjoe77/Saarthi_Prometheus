import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthContext } from '../auth/auth.service';
import { ProfileResponseDto, UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

/**
 * The caller's own profile and financial-preference questionnaire.
 *
 * Scoped to `/profile/me`: a user can only ever read or edit their own row.
 * There is no cross-user profile endpoint - displaying a public expert profile
 * is a future feature and must not be pre-wired through this controller.
 */
@ApiTags('profile')
@ApiBearerAuth()
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('me')
  @ApiOperation({ summary: 'The caller’s profile and questionnaire answers' })
  @ApiOkResponse({ type: ProfileResponseDto })
  @HttpCode(HttpStatus.OK)
  async getMe(@CurrentUser() user: AuthContext): Promise<ProfileResponseDto> {
    return this.profile.getProfile(user.id);
  }

  @Put('me')
  @ApiOperation({ summary: 'Update profile and questionnaire fields (partial)' })
  @HttpCode(HttpStatus.OK)
  async updateMe(
    @CurrentUser() user: AuthContext,
    @Body() body: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    return this.profile.updateProfile(user.id, body);
  }

  @Post('me/onboarding/complete')
  @ApiOperation({ summary: 'Mark onboarding complete (idempotent, requires core answers)' })
  @HttpCode(HttpStatus.OK)
  async completeOnboarding(@CurrentUser() user: AuthContext): Promise<ProfileResponseDto> {
    return this.profile.completeOnboarding(user.id);
  }
}
