import { HttpStatus, Injectable } from '@nestjs/common';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  ONBOARDING_REQUIRED_FIELDS,
  type ProfileResponseDto,
  type UpdateProfileDto,
} from './dto/update-profile.dto';

/** The profile fields the API reads and writes, in response shape. */
const PROFILE_FIELDS = {
  displayName: true,
  country: true,
  displayCurrency: true,
  experienceLevel: true,
  investmentCapitalRange: true,
  capitalAvailability: true,
  riskTolerance: true,
  drawdownComfort: true,
  volatilityComfort: true,
  primaryGoal: true,
  timeHorizon: true,
  expectedReturnRange: true,
  holdingPeriod: true,
  lossReaction: true,
  liquidityNeeds: true,
  contributionFrequency: true,
  onboardingCompletedAt: true,
} as const;

/**
 * The user's own profile and financial-preference questionnaire.
 *
 * Onboarding is a completion flag, not a state machine: the row can be written
 * field-by-field over several sessions, and `onboardingCompletedAt` is set once
 * when the required core answers exist. It never returns to null, so a
 * completed onboarding never repeats.
 */
@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's profile, or an all-null profile if none exists yet. */
  async getProfile(userId: string): Promise<ProfileResponseDto> {
    const row = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: PROFILE_FIELDS,
    });

    return toResponse(row);
  }

  /** Partial upsert: only the supplied fields are written. */
  async updateProfile(userId: string, input: UpdateProfileDto): Promise<ProfileResponseDto> {
    const data: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        data[key] = value as string | null;
      }
    }

    const row = await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
      select: PROFILE_FIELDS,
    });

    return toResponse(row);
  }

  /**
   * Marks onboarding complete once the required core answers are present.
   * Idempotent: if already complete, returns the current state unchanged.
   */
  async completeOnboarding(userId: string): Promise<ProfileResponseDto> {
    const row = await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: PROFILE_FIELDS,
    });

    if (row.onboardingCompletedAt) {
      return toResponse(row);
    }

    const missing = ONBOARDING_REQUIRED_FIELDS.filter(
      (field) => !row[field as keyof typeof row],
    );

    if (missing.length > 0) {
      throw new DomainException(
        ERROR_CODES.VALIDATION_FAILED,
        `Onboarding cannot be completed yet. Still needed: ${missing.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.userProfile.update({
      where: { userId },
      data: { onboardingCompletedAt: new Date() },
      select: PROFILE_FIELDS,
    });

    return toResponse(updated);
  }
}

/** Maps a stored row (or null) onto the API shape, ISO-dating the timestamp. */
function toResponse(
  row: Record<string, string | Date | null> | null,
): ProfileResponseDto {
  const str = (value: string | Date | null | undefined): string | null =>
    value === null || value === undefined
      ? null
      : value instanceof Date
        ? value.toISOString()
        : String(value);

  return {
    displayName: str(row?.displayName),
    country: str(row?.country),
    displayCurrency: str(row?.displayCurrency),
    experienceLevel: str(row?.experienceLevel),
    investmentCapitalRange: str(row?.investmentCapitalRange),
    capitalAvailability: str(row?.capitalAvailability),
    riskTolerance: str(row?.riskTolerance),
    drawdownComfort: str(row?.drawdownComfort),
    volatilityComfort: str(row?.volatilityComfort),
    primaryGoal: str(row?.primaryGoal),
    timeHorizon: str(row?.timeHorizon),
    expectedReturnRange: str(row?.expectedReturnRange),
    holdingPeriod: str(row?.holdingPeriod),
    lossReaction: str(row?.lossReaction),
    liquidityNeeds: str(row?.liquidityNeeds),
    contributionFrequency: str(row?.contributionFrequency),
    onboardingCompletedAt: str(row?.onboardingCompletedAt),
  };
}
