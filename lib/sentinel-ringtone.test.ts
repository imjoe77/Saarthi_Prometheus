import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RING_OFF_MS,
  RING_ON_MS,
  RING_PEAK_GAIN,
  RING_TONE_HZ,
  RING_VIBRATION_PATTERN,
  startRingtone,
  type AudioContextLike,
  type AudioParamLike,
  type GainNodeLike,
  type OscillatorLike,
} from "./sentinel-ringtone.ts";

/**
 * MODULE 14 - the audible ring, tested headlessly.
 *
 * The fakes stand in for Web Audio: a working context, a suspended one (the
 * autoplay-policy shape), a locked one whose resume always rejects, and no
 * context at all (SSR / kiosk). The assertions pin the behaviour the overlay
 * relies on — a dual tone on a phone cadence, a click-free envelope, resume
 * on interaction, and a stop() that really stops everything and is safe to
 * call twice.
 */

interface ParamCall {
  readonly method: "setValueAtTime" | "linearRampToValueAtTime";
  readonly value: number;
  readonly time: number;
}

function fakeParam(): AudioParamLike & { readonly calls: ParamCall[]; value: number } {
  const calls: ParamCall[] = [];
  return {
    calls,
    value: 0,
    setValueAtTime(value: number, time: number): AudioParamLike {
      calls.push({ method: "setValueAtTime", value, time });
      return this;
    },
    linearRampToValueAtTime(value: number, time: number): AudioParamLike {
      calls.push({ method: "linearRampToValueAtTime", value, time });
      return this;
    },
  };
}

interface FakeOscillator extends OscillatorLike {
  readonly frequency: ReturnType<typeof fakeParam>;
  readonly started: number[];
  readonly stopped: number[];
  readonly connectedTo: unknown[];
}

function fakeOscillator(): FakeOscillator {
  const frequency = fakeParam();
  const started: number[] = [];
  const stopped: number[] = [];
  const connectedTo: unknown[] = [];
  return {
    frequency,
    started,
    stopped,
    connectedTo,
    start(when?: number): void {
      started.push(when ?? -1);
    },
    stop(when?: number): void {
      stopped.push(when ?? -1);
    },
    connect(destination: unknown): unknown {
      connectedTo.push(destination);
      return destination;
    },
    disconnect(): unknown {
      return undefined;
    },
  };
}

interface FakeGain extends GainNodeLike {
  readonly gain: ReturnType<typeof fakeParam>;
  readonly connectedTo: unknown[];
  disconnectCount: number;
}

function fakeGain(): FakeGain {
  const gain = fakeParam();
  const connectedTo: unknown[] = [];
  return {
    gain,
    connectedTo,
    disconnectCount: 0,
    connect(destination: unknown): unknown {
      connectedTo.push(destination);
      return destination;
    },
    disconnect(): unknown {
      return undefined;
    },
  };
}

interface FakeContext {
  readonly context: AudioContextLike;
  readonly oscillators: FakeOscillator[];
  readonly gains: FakeGain[];
  readonly resumeCalls: () => number;
  setTime(seconds: number): void;
  setState(state: string): void;
  /** Simulates the browser granting a user gesture: resume now really runs. */
  grantGesture(): void;
  /** Lets a queued resume settle; the module resumes fire-and-forget. */
  flush(): Promise<void>;
}

function fakeContext(options?: {
  state?: string;
  resumeRejects?: boolean;
  /** Like a real autoplay policy: resume() only unlocks after a gesture. */
  requireGesture?: boolean;
}): FakeContext {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const destination = { kind: "destination" };
  let currentTime = 0;
  let state = options?.state ?? "running";
  let gestureSeen = false;
  let resumeCalls = 0;

  const context: AudioContextLike = {
    get currentTime(): number {
      return currentTime;
    },
    get destination(): unknown {
      return destination;
    },
    get state(): string {
      return state;
    },
    async resume(): Promise<void> {
      resumeCalls += 1;
      if (options?.resumeRejects === true) {
        throw new Error("NotAllowedError: a user gesture is required");
      }
      // A gesture-less resume on a locked context resolves but stays locked —
      // exactly what Chrome does before the first interaction.
      if (options?.requireGesture === true && !gestureSeen) return;
      state = "running";
    },
    createOscillator(): OscillatorLike {
      const oscillator = fakeOscillator();
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain(): GainNodeLike {
      const gain = fakeGain();
      gains.push(gain);
      return gain;
    },
  };

  return {
    context,
    oscillators,
    gains,
    resumeCalls: () => resumeCalls,
    setTime: (seconds: number) => {
      currentTime = seconds;
    },
    setState: (next: string) => {
      state = next;
    },
    grantGesture: () => {
      gestureSeen = true;
    },
    flush: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

/**
 * A scheduler that records but never fires. Injected into every test so no
 * real timer ever exists — a leaked ringtone cycle would otherwise keep the
 * test process alive forever (a real setTimeout loop never lets Node exit).
 */
function deadScheduler(): {
  schedule: (handler: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  scheduledMs: number[];
  cancelled: unknown[];
} {
  const scheduledMs: number[] = [];
  const cancelled: unknown[] = [];
  let next = 0;
  return {
    schedule: (_handler: () => void, ms: number) => {
      scheduledMs.push(ms);
      next += 1;
      return next;
    },
    cancel: (handle: unknown) => {
      cancelled.push(handle);
    },
    scheduledMs,
    cancelled,
  };
}

describe("startRingtone", () => {
  it("starts the carrier dual tone: one oscillator per tone, through one gain", () => {
    const fake = fakeContext();
    const timers = deadScheduler();
    const ringtone = startRingtone({
      createContext: () => fake.context,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    assert.equal(ringtone.audible, true);
    assert.equal(fake.oscillators.length, RING_TONE_HZ.length);
    // The exact frequencies a telephone network rings with.
    assert.deepEqual(
      fake.oscillators.map((oscillator) => oscillator.frequency.calls[0]?.value),
      [...RING_TONE_HZ],
    );
    // Every tone is started and routed into the single master gain.
    for (const oscillator of fake.oscillators) {
      assert.equal(oscillator.started.length, 1);
      assert.equal(oscillator.connectedTo.length, 1);
    }
    assert.equal(fake.gains.length, 1);
    assert.equal(fake.gains[0]?.connectedTo[0], fake.context.destination);

    ringtone.stop();
  });

  it("gates a click-free ring pulse on the master gain and schedules the next cycle", () => {
    const scheduled: Array<{ ms: number }> = [];
    const fake = fakeContext();
    fake.setTime(10); // the envelope must be placed on the context clock
    const ringtone = startRingtone({
      createContext: () => fake.context,
      schedule: (_handler: () => void, ms: number) => {
        scheduled.push({ ms });
        return 1;
      },
    });

    const gain = fake.gains[0]?.gain;
    assert.ok(gain);
    const on = RING_ON_MS / 1000;
    // Start silent at t, ramp up (no click), hold, ramp down (no click).
    assert.deepEqual(gain.calls, [
      { method: "setValueAtTime", value: 0, time: 10 },
      { method: "linearRampToValueAtTime", value: RING_PEAK_GAIN, time: 10 + 0.02 },
      { method: "setValueAtTime", value: RING_PEAK_GAIN, time: 10 + on - 0.02 },
      { method: "linearRampToValueAtTime", value: 0, time: 10 + on },
    ]);
    // The next ring is scheduled for one full cadence later.
    assert.deepEqual(scheduled, [{ ms: RING_ON_MS + RING_OFF_MS }]);

    ringtone.stop();
  });

  it("vibrates the ring pattern alongside the tone", () => {
    const seen: Array<readonly number[]> = [];
    const fake = fakeContext();
    const timers = deadScheduler();
    const ringtone = startRingtone({
      createContext: () => fake.context,
      schedule: timers.schedule,
      cancel: timers.cancel,
      vibrate: (pattern: readonly number[]) => {
        seen.push(pattern);
      },
    });

    assert.deepEqual(seen, [[...RING_VIBRATION_PATTERN]]);
    ringtone.stop();
    // Stopping clears the vibration, the way silencing a real phone does.
    assert.deepEqual(seen, [[...RING_VIBRATION_PATTERN], []]);
  });

  it("resumes a suspended context on start and again on the first interaction", async () => {
    let interactionResume: (() => void) | undefined;
    // A real autoplay policy: resume() without a gesture resolves but the
    // context stays suspended until the user actually interacts.
    const fake = fakeContext({ state: "suspended", requireGesture: true });
    const timers = deadScheduler();

    const ringtone = startRingtone({
      createContext: () => fake.context,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onFirstInteraction: (resume: () => void) => {
        interactionResume = resume;
        return () => {
          interactionResume = undefined;
        };
      },
    });

    // Attempted immediately at ring start — the page may already be unlocked.
    assert.equal(fake.resumeCalls(), 1);
    await fake.flush();
    assert.equal(fake.context.state, "suspended"); // still locked, honestly

    // The first interaction (a tap on this very card) unlocks it.
    assert.ok(interactionResume);
    fake.grantGesture();
    interactionResume();
    await fake.flush();
    assert.equal(fake.resumeCalls(), 2);
    assert.equal(fake.context.state, "running");

    // stop() unsubscribes the interaction hook — no listener outlives the ring.
    ringtone.stop();
    assert.equal(interactionResume, undefined);
  });

  it("keeps the tone scheduled when the context stays locked — audible but silent, never a crash", async () => {
    const fake = fakeContext({ state: "suspended", resumeRejects: true });
    const scheduled: number[] = [];

    // A locked context must not throw at start, at resume, or at interaction.
    const ringtone = startRingtone({
      createContext: () => fake.context,
      schedule: (_handler: () => void, ms: number) => {
        scheduled.push(ms);
        return 1;
      },
      onFirstInteraction: (resume: () => void) => {
        resume();
        return () => undefined;
      },
    });

    await fake.flush();
    assert.equal(ringtone.audible, true); // the context exists...
    assert.ok(scheduled.length >= 1); // ...and the cadence is queued
    ringtone.stop();
  });

  it("is a silent no-op handle when the browser has no Web Audio", () => {
    const ringtone = startRingtone({ createContext: () => undefined });

    // The overlay must be able to call stop() unconditionally.
    assert.equal(ringtone.audible, false);
    assert.doesNotThrow(() => ringtone.stop());
  });

  it("stop() halts the oscillators, cancels the pending cycle, and is idempotent", () => {
    const cancelled: unknown[] = [];
    let scheduledHandler: (() => void) | undefined;
    const fake = fakeContext();
    const vibrateCalls: Array<readonly number[]> = [];

    const ringtone = startRingtone({
      createContext: () => fake.context,
      schedule: (handler: () => void) => {
        scheduledHandler = handler;
        return "timer-1";
      },
      cancel: (handle: unknown) => {
        cancelled.push(handle);
      },
      vibrate: (pattern: readonly number[]) => {
        vibrateCalls.push(pattern);
      },
    });

    ringtone.stop();
    assert.deepEqual(cancelled, ["timer-1"]);
    for (const oscillator of fake.oscillators) {
      assert.equal(oscillator.stopped.length, 1);
    }
    assert.ok(vibrateCalls.some((pattern) => pattern.length === 0)); // vibration cleared

    // A straggler timer that fires after stop must not re-arm the ring.
    const handler = scheduledHandler;
    scheduledHandler = undefined;
    handler?.();
    assert.equal(scheduledHandler, undefined);

    // Double-stop is safe: the overlay's several teardown paths may race.
    assert.doesNotThrow(() => ringtone.stop());
    for (const oscillator of fake.oscillators) {
      assert.equal(oscillator.stopped.length, 1); // not stopped twice
    }
  });
});
