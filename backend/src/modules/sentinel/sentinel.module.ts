import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module';
import { DatabaseModule } from '../../database/database.module';
import { LiveDataModule } from '../live-data/live-data.module';
import { SentinelController } from './sentinel.controller';
import { SentinelCallerService } from './sentinel-caller.service';
import { SentinelLiveCallService } from './sentinel-live-call.service';
import { SentinelMonitorService } from './sentinel-monitor.service';
import { SentinelService } from './sentinel.service';
import { SentinelVoiceService } from './sentinel-voice.service';
import { SentinelWorkerService } from './sentinel-worker.service';
import { FakeVoiceCallProvider } from './providers/fake-voice-call-provider';
import { OffVoiceCallProvider } from './providers/off-voice-call-provider';
import { TwilioVoiceCallProvider } from './providers/twilio-voice-call-provider';
import { VOICE_CALL_PROVIDER } from './providers/voice-call-provider.port';

/**
 * MODULE 14 - the Sentinel module.
 *
 * DEPENDENCIES, AND WHAT EACH ONE IS FOR.
 *  - `DatabaseModule`: Prisma, for this module's three tables.
 *  - `LiveDataModule`: the *service*, for the shared quotes the monitor pass
 *    evaluates the alert book against. Sentinel creates no second market-data
 *    door; if the feed is off, the pass records that state and triggers
 *    nothing.
 *
 * THE VOICE PROVIDER IS CHOSEN ONCE, FROM CONFIGURATION. `off` is the safe
 * default (every dial answers with a disabled error, nothing is ever
 * contacted); `fake` is the deterministic adapter every automated test uses;
 * `twilio` is selected only when the environment asks for it AND carries all
 * three of its credentials - a half-told secret is a boot stop, in
 * SentinelConfig, before anything could dial.
 */
@Module({
  imports: [DatabaseModule, LiveDataModule],
  controllers: [SentinelController],
  providers: [
    // Registered as injectables too, so a test (and the factory below) can
    // obtain a concrete provider by class, exactly as the live-data module
    // exposes its own providers. Twilio stays factory-only: constructing it
    // without credentials throws by design, and a provider that should not be
    // reachable must not exist as a class instance.
    OffVoiceCallProvider,
    FakeVoiceCallProvider,
    {
      provide: VOICE_CALL_PROVIDER,
      useFactory: (
        off: OffVoiceCallProvider,
        fake: FakeVoiceCallProvider,
        config: { sentinel: { voiceProvider: 'off' | 'fake' | 'twilio'; twilioAccountSid: string; twilioAuthToken: string; twilioFromNumber: string } },
      ) => voiceProviderFor(off, fake, config),
      inject: [OffVoiceCallProvider, FakeVoiceCallProvider, APP_CONFIG],
    },
    SentinelVoiceService,
    SentinelService,
    SentinelMonitorService,
    SentinelCallerService,
    SentinelLiveCallService,
    SentinelWorkerService,
  ],
  exports: [SentinelService, SentinelVoiceService],
})
export class SentinelModule {}

/** Picks the one voice provider the configuration names, with its credentials. */
function voiceProviderFor(
  off: OffVoiceCallProvider,
  fake: FakeVoiceCallProvider,
  config: { sentinel: { voiceProvider: 'off' | 'fake' | 'twilio'; twilioAccountSid: string; twilioAuthToken: string; twilioFromNumber: string } },
): FakeVoiceCallProvider | OffVoiceCallProvider | TwilioVoiceCallProvider {
  switch (config.sentinel.voiceProvider) {
    case 'fake':
      return fake;
    case 'twilio':
      return new TwilioVoiceCallProvider(
        config.sentinel.twilioAccountSid,
        config.sentinel.twilioAuthToken,
        config.sentinel.twilioFromNumber,
      );
    case 'off':
    default:
      return off;
  }
}
