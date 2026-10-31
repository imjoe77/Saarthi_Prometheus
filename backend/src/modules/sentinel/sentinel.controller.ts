import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { DomainException } from '../../common/errors/domain.exception';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { SentinelService } from './sentinel.service';
import { SentinelCallerService } from './sentinel-caller.service';
import { SentinelLiveCallService } from './sentinel-live-call.service';
import { SentinelMonitorService } from './sentinel-monitor.service';
import { SentinelVoiceService } from './sentinel-voice.service';
import {
  CancelSentinelAlertDto,
  CreateSentinelAlertDto,
  SentinelPageQueryDto,
  SetPhoneDto,
  SetQuietHoursDto,
  SettleLiveCallDto,
  SetVoiceDisabledDto,
  UpdateSentinelAlertDto,
  VerifyPhoneDto,
} from './dto/sentinel-dto';
import type { VoiceWebhookInput } from './providers/voice-call-provider.port';
import {
  AlertPageDto,
  AlertResponseDto,
  CallHistoryPageDto,
  LiveCallEnvelopeResponseDto,
  LiveCallResponseDto,
  PassResponseDto,
  SentinelStatusResponseDto,
  VerificationResponseDto,
  VoiceSettingsResponseDto,
} from './dto/sentinel-response.dto';

/**
 * MODULE 14 - Sentinel over HTTP.
 *
 * THE TOKEN IS THE OWNER. No route accepts a userId: every alert, every
 * settings row and every history page reads its owner from the verified
 * token. There is no "trigger a call" endpoint and no user-controlled user id
 * anywhere in this controller - a call happens only when the monitor proves a
 * target with fresh market data.
 *
 * RBAC: Sentinel is for NORMAL_USER and EXPERT_TRADER alike; the global
 * AuthGuard's authenticated caller is the only gate, exactly as the copy
 * module handles its mixed audience. No @Roles decorator appears here, so no
 * role is granted or bypassed.
 *
 * RUN-ONCE IS A CONTROLLED DUTY-BELT, NOT A PUBLIC TRIGGER: it runs the same
 * two passes the worker runs, over the same guarded database paths, so
 * calling it cannot fabricate a trigger or bypass a gate. It exists so the
 * automated suites and an operator can drive a pass deterministically without
 * waiting for the interval.
 */
@ApiTags('sentinel')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('sentinel')
export class SentinelController {
  constructor(
    private readonly sentinelService: SentinelService,
    private readonly voiceService: SentinelVoiceService,
    private readonly monitorService: SentinelMonitorService,
    private readonly callerService: SentinelCallerService,
    private readonly liveCallService: SentinelLiveCallService,
  ) {}

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------

  @Post('alerts')
  @ApiOperation({
    summary: 'Create an alert',
    description: 'Creates a price alert owned by the caller. Symbols are validated against the instrument catalogue.',
  })
  @ApiCreatedResponse({ type: AlertResponseDto })
  async create(
    @CurrentUser() user: AuthContext,
    @Body() body: CreateSentinelAlertDto,
  ): Promise<AlertResponseDto> {
    return alertToDto(await this.sentinelService.create(user.id, body));
  }

  @Get('alerts')
  @ApiOperation({ summary: "List the caller's alerts" })
  @ApiOkResponse({ type: AlertPageDto })
  async list(
    @CurrentUser() user: AuthContext,
    @Query() query: SentinelPageQueryDto,
  ): Promise<AlertPageDto> {
    const page = parsePageInt(query.page, 'page', 1);
    const limit = parsePageInt(query.limit, 'limit', 20);
    const result = await this.sentinelService.list(
      user.id,
      page,
      limit,
      query.status as Parameters<SentinelService['list']>[3],
    );
    return AlertPageDto.from(result);
  }

  @Get('alerts/:alertId')
  @ApiOperation({ summary: "Fetch one of the caller's alerts" })
  @ApiOkResponse({ type: AlertResponseDto })
  async get(
    @CurrentUser() user: AuthContext,
    @Param('alertId') alertId: string,
  ): Promise<AlertResponseDto> {
    return alertToDto(await this.sentinelService.get(user.id, alertId));
  }

  @Patch('alerts/:alertId')
  @ApiOperation({ summary: 'Edit an ACTIVE alert' })
  @ApiOkResponse({ type: AlertResponseDto })
  async edit(
    @CurrentUser() user: AuthContext,
    @Param('alertId') alertId: string,
    @Body() body: UpdateSentinelAlertDto,
  ): Promise<AlertResponseDto> {
    return alertToDto(await this.sentinelService.edit(user.id, alertId, body));
  }

  @Delete('alerts/:alertId')
  @ApiOperation({
    summary: 'Cancel an alert',
    description: 'Stops the alert without deleting it: cancelled alerts never trigger, and history keeps them.',
  })
  @ApiOkResponse({ type: AlertResponseDto })
  async cancel(
    @CurrentUser() user: AuthContext,
    @Param('alertId') alertId: string,
    @Body() body: CancelSentinelAlertDto,
  ): Promise<AlertResponseDto> {
    return alertToDto(await this.sentinelService.cancel(user.id, alertId, body.reason));
  }

  @Get('calls')
  @ApiOperation({ summary: "The caller's voice-call history" })
  @ApiOkResponse({ type: CallHistoryPageDto })
  async callHistory(
    @CurrentUser() user: AuthContext,
    @Query() query: SentinelPageQueryDto,
  ): Promise<CallHistoryPageDto> {
    const page = parsePageInt(query.page, 'page', 1);
    const limit = parsePageInt(query.limit, 'limit', 20);
    return CallHistoryPageDto.from(await this.sentinelService.callHistory(user.id, page, limit));
  }

  @Get('status')
  @ApiOperation({ summary: 'Sentinel status and monitoring health for the caller' })
  @ApiOkResponse({ type: SentinelStatusResponseDto })
  async status(@CurrentUser() user: AuthContext): Promise<SentinelStatusResponseDto> {
    return SentinelStatusResponseDto.from(await this.sentinelService.status(user.id, new Date()));
  }

  // ---------------------------------------------------------------------------
  // Voice settings, verification and consent
  // ---------------------------------------------------------------------------

  @Get('voice/settings')
  @ApiOperation({ summary: "The caller's voice settings (masked number)" })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async voiceSettings(@CurrentUser() user: AuthContext): Promise<VoiceSettingsResponseDto> {
    const settings = await this.voiceService.settingsFor(user.id);
    return VoiceSettingsResponseDto.from(this.voiceService.toPublicSettings(settings));
  }

  @Patch('voice/phone')
  @ApiOperation({ summary: 'Set the E.164 phone number', description: 'Setting a new number resets its verification.' })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async setPhone(
    @CurrentUser() user: AuthContext,
    @Body() body: SetPhoneDto,
  ): Promise<VoiceSettingsResponseDto> {
    return VoiceSettingsResponseDto.from(
      this.voiceService.toPublicSettings(await this.voiceService.setPhone(user.id, body.phone)),
    );
  }

  @Post('voice/phone/verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a verification code',
    description: 'Outside production the response carries the code, because no SMS delivery is configured.',
  })
  @ApiOkResponse({ type: VerificationResponseDto })
  async requestVerification(@CurrentUser() user: AuthContext): Promise<VerificationResponseDto> {
    const result = await this.voiceService.requestVerification(user.id);
    return { status: result.status, ...(result.code !== undefined ? { code: result.code } : {}) };
  }

  @Post('voice/phone/verification/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm the verification code' })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async confirmVerification(
    @CurrentUser() user: AuthContext,
    @Body() body: VerifyPhoneDto,
  ): Promise<VoiceSettingsResponseDto> {
    return VoiceSettingsResponseDto.from(
      this.voiceService.toPublicSettings(await this.voiceService.confirmVerification(user.id, body.code)),
    );
  }

  @Post('voice/consent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant automated-call consent', description: 'Requires a verified number.' })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async grantConsent(@CurrentUser() user: AuthContext): Promise<VoiceSettingsResponseDto> {
    return VoiceSettingsResponseDto.from(
      this.voiceService.toPublicSettings(await this.voiceService.grantConsent(user.id)),
    );
  }

  @Delete('voice/consent')
  @ApiOperation({ summary: 'Withdraw automated-call consent' })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async withdrawConsent(@CurrentUser() user: AuthContext): Promise<VoiceSettingsResponseDto> {
    return VoiceSettingsResponseDto.from(
      this.voiceService.toPublicSettings(await this.voiceService.withdrawConsent(user.id)),
    );
  }

  @Patch('voice/quiet-hours')
  @ApiOperation({ summary: 'Set or clear quiet hours', description: 'Minutes since UTC midnight, both ends or neither.' })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async setQuietHours(
    @CurrentUser() user: AuthContext,
    @Body() body: SetQuietHoursDto,
  ): Promise<VoiceSettingsResponseDto> {
    return VoiceSettingsResponseDto.from(
      this.voiceService.toPublicSettings(
        await this.voiceService.setQuietHours(user.id, body.quietHoursStartUtc ?? null, body.quietHoursEndUtc ?? null),
      ),
    );
  }

  @Patch('voice/disabled')
  @ApiOperation({ summary: 'Enable or disable voice calls for the account' })
  @ApiOkResponse({ type: VoiceSettingsResponseDto })
  async setVoiceDisabled(
    @CurrentUser() user: AuthContext,
    @Body() body: SetVoiceDisabledDto,
  ): Promise<VoiceSettingsResponseDto> {
    return VoiceSettingsResponseDto.from(
      this.voiceService.toPublicSettings(await this.voiceService.setVoiceDisabled(user.id, body.disabled)),
    );
  }

  // ---------------------------------------------------------------------------
  // In-app simulated call (the `fake` provider's phone, rendered in the app)
  // ---------------------------------------------------------------------------

  @Get('voice/live')
  @ApiOperation({
    summary: 'The ringing in-app simulated call, if any',
    description:
      "Returns the caller's own simulated call that has been dialled but not settled - the ring the in-app phone shows - " +
      'as `call`, or `call: null` when nothing is ringing (including under the real Twilio provider, where the phone ' +
      'rings on the PSTN instead). The envelope is explicit so an empty answer is never confused with a failed one.',
  })
  @ApiOkResponse({ type: LiveCallEnvelopeResponseDto })
  async liveCall(@CurrentUser() user: AuthContext): Promise<LiveCallEnvelopeResponseDto> {
    const call = await this.liveCallService.ringingCallFor(user.id);
    return { call: call === null ? null : LiveCallResponseDto.from(call) };
  }

  @Post('voice/live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer, decline or end the ringing simulated call',
    description:
      'Owner-scoped and fake-provider only. Applies the same guarded transitions the provider webhook uses, so a ' +
      'double-tap or replay cannot settle the call twice, and reports the resulting row. Never places a trade.',
  })
  @ApiOkResponse({ type: LiveCallResponseDto })
  async settleLiveCall(
    @CurrentUser() user: AuthContext,
    @Body() body: SettleLiveCallDto,
  ): Promise<LiveCallResponseDto> {
    return LiveCallResponseDto.from(
      await this.liveCallService.settleLiveCall(user.id, {
        callId: body.callId,
        action: body.action,
        at: new Date(),
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Provider webhook and the run-once duty-belt
  // ---------------------------------------------------------------------------

  /**
   * The voice provider's status callback.
   *
   * Deliberately NOT guarded by the AuthGuard: a provider is not a user. Its
   * proof is the signature the caller service verifies before the payload is
   * read - the response says 204 for an applied event, 403 for a forged one,
   * and 202 with a diagnostic code for a badly-formed but authenticated event
   * (an unknown call id is worth retrying from the provider's side, not
   * burying in 4xx).
   */
  @Post('voice/webhook')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async voiceWebhook(@Req() request: Request): Promise<void> {
    const input = await readUrlencodedBody(request);
    const result = await this.callerService.processWebhook(input, new Date());

    if (!result.handled && result.refusal === 'WEBHOOK_SIGNATURE_INVALID') {
      throw new ForbiddenException('Webhook signature did not verify.');
    }
    if (!result.handled && result.refusal?.startsWith('WEBHOOK_')) {
      throw new DomainException(
        ERROR_CODES.VALIDATION_FAILED,
        `Webhook refused: ${result.refusal}.`,
        HttpStatus.ACCEPTED,
      );
    }
  }

  @Post('run-once')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run one monitor and one caller pass now',
    description: 'Drives the same guarded passes the worker timer runs. Exists for tests and operators.',
  })
  @ApiOkResponse({ type: PassResponseDto })
  async runOnce(): Promise<PassResponseDto> {
    const at = new Date();
    return {
      monitor: await this.monitorService.runOnce(at),
      caller: await this.callerService.runOnce(at),
    };
  }

}

/**
 * Collects the raw request body and decodes it as
 * application/x-www-form-urlencoded. Express does not parse this content
 * type, so the stream is still intact - collecting it here keeps the
 * signature verification byte-faithful rather than re-serialised.
 */
async function readUrlencodedBody(request: Request & { body?: unknown }): Promise<VoiceWebhookInput> {
  // Nest's default body parser (body-parser urlencoded) has already consumed
  // and parsed the form body into `request.body` by the time a handler runs,
  // so the parsed object is the byte-faithful source; the manual stream read
  // is only the fallback for a parser-less wiring.
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
    return finishWebhookInput(request, request.body as Record<string, unknown>);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    parsed[key] = value;
  }
  return finishWebhookInput(request, parsed);
}

/**
 * Assembles the webhook input: canonical URL, lower-cased headers, string
 * params. Behind `trust proxy`, `req.protocol` reflects X-Forwarded-Proto, so
 * the signed URL matches the one the provider wrote even after TLS
 * termination.
 */
function finishWebhookInput(request: Request, parsed: Record<string, unknown>): VoiceWebhookInput {
  const url = `${request.protocol}://${request.get('host') ?? ''}${request.originalUrl}`;

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') params[key] = value;
  }

  return {
    url,
    headers: Object.freeze(headers),
    params: Object.freeze(params),
  };
}

/** Loose query-string integer parsing with a domain error answer. */
function parsePageInt(raw: string | undefined, field: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw) {
    throw DomainException.badRequest(`${field} must be an integer.`);
  }
  return Math.min(Math.max(value, 1), 100);
}

/** Maps the service's include-shape onto the response DTO, sharing the call pick. */
function alertToDto(alert: Awaited<ReturnType<SentinelService['get']>>): AlertResponseDto {
  const call = Array.isArray(alert.calls) ? alert.calls[0] ?? null : null;
  return AlertResponseDto.from(alert, call);
}
