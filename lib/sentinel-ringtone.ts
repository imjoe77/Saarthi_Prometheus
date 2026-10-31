/**
 * MODULE 14 — the audible ring for the in-app SIMULATED call.
 *
 * WHY SYNTHESIS, NOT AN AUDIO FILE. Real carriers ring a dual tone (440 Hz
 * + 480 Hz is the North-American pair); two oscillators reproduce it with no
 * binary asset in the repo, nothing to license, and a cadence that loops
 * forever with no seam — the on/off edges are short gain ramps, not hard
 * cuts, so there is no click at either end of every ring.
 *
 * WHY INJECTED DEPS. Web Audio objects, timers and vibration are all
 * side-effectful host APIs; tests drive this module with fakes — a working
 * context, a suspended one (the autoplay-policy shape), and no context at
 * all (SSR, locked-down kiosk) — without needing a DOM.
 *
 * HONESTY ABOUT AUDIO POLICY. A context created before the user has ever
 * interacted with the page starts `suspended`: no sound can be promised. This
 * module attempts `resume()` immediately and re-attempts on the first
 * interaction; the ring card stays visible either way. Nothing here ever
 * claims sound was heard.
 *
 * THIS IS A SIMULATED RING. It never places a call, never touches a trade —
 * it renders two sine waves on a schedule.
 */

/** Ring on-time, then off-time, repeating — a recognizable phone cadence. */
export const RING_ON_MS = 1500;
export const RING_OFF_MS = 2500;
/** The dual tone real telephone networks use. */
export const RING_TONE_HZ = [440, 480] as const;
/** Peak master gain: clearly audible, well short of startling. */
export const RING_PEAK_GAIN = 0.09;
/** Ramp length at each edge of a ring pulse — kills the click. */
export const RING_RAMP_S = 0.02;
/** The vibration pattern (vibrate/pause, repeats until cleared). */
export const RING_VIBRATION_PATTERN = [1500, 2500] as const;

// --- Minimal Web Audio surface ---------------------------------------------
// Only what this module touches, so tests can fake it in a few lines.

export interface AudioParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}

export interface OscillatorLike {
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
  connect(destination: unknown): unknown;
  disconnect(): unknown;
}

export interface GainNodeLike {
  readonly gain: AudioParamLike;
  connect(destination: unknown): unknown;
  disconnect(): unknown;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  /** 'running' | 'suspended' | 'closed' — only the first two matter here. */
  readonly state: string;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainNodeLike;
}

export interface RingtoneDeps {
  /**
   * Builds the Web Audio context. Returning undefined (no Web Audio, SSR,
   * locked-down device) makes `startRingtone` a silent no-op handle — the
   * call is still fully usable; it is just not audible.
   */
  readonly createContext?: () => AudioContextLike | undefined;
  /** Schedules the next ring cycle. Injectable so tests drive time. */
  readonly schedule?: (handler: () => void, ms: number) => unknown;
  /** Cancels a handle produced by `schedule`. */
  readonly cancel?: (handle: unknown) => void;
  /** Device vibration, when supported. Injected for tests; default: navigator. */
  readonly vibrate?: (pattern: readonly number[]) => void;
  /**
   * Registers a one-shot "the user interacted" hook used to unlock a
   * suspended context (autoplay policy). Returns an unsubscribe.
   */
  readonly onFirstInteraction?: (resume: () => void) => () => void;
}

export interface RingtoneHandle {
  /** False when no audible ring could be started (no Web Audio, or the
   *  browser refused). The caller must not imply otherwise. */
  readonly audible: boolean;
  /** Idempotent: stops audio, the pending cycle, vibration, and unlock hooks. */
  stop(): void;
}

const noop = (): void => {
  /* nothing to undo */
};

/** Default unlock: the first pointer/key gesture resumes the context. */
function browserUnlock(resume: () => void): () => void {
  if (typeof document === "undefined") return noop;
  const unlock = (): void => resume();
  document.addEventListener("pointerdown", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });
  return () => {
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
  };
}

/** Default vibration: the platform API when the device has one. */
function browserVibrate(pattern: readonly number[]): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate([...pattern]);
  } catch {
    // A refused vibration is cosmetic; the audible ring is the signal.
  }
}

/**
 * Starts the ring for a ringing simulated call. Returns a handle whose
 * `stop()` the caller MUST run when the ring ends (answered, declined,
 * silenced, unmounted) — every path is idempotent so double-stops are safe.
 */
export function startRingtone(deps: RingtoneDeps = {}): RingtoneHandle {
  const createContext = deps.createContext ?? defaultCreateContext;
  const schedule = deps.schedule ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const cancel = (handle: unknown): void => {
    if (deps.cancel !== undefined) {
      deps.cancel(handle);
      return;
    }
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  };

  const context = createContext();
  if (context === undefined) {
    // Nothing to ring with. Honest no-op: the card still shows the call.
    return { audible: false, stop: noop };
  }

  let stopped = false;
  let cycleHandle: unknown;
  let vibrated = false;

  const resume = (): void => {
    if (context.state !== "suspended") return;
    try {
      void Promise.resolve(context.resume()).catch(() => {
        // Still locked. The first real interaction retries via the hook.
      });
    } catch {
      // Same as above: report nothing, promise nothing.
    }
  };

  const unsubscribe =
    (deps.onFirstInteraction ?? browserUnlock)(resume) ?? noop;

  // One master gain gates both tones: a single envelope, zero-crossing ramps.
  const master = context.createGain();
  master.connect(context.destination);
  const oscillators = RING_TONE_HZ.map((hz) => {
    const oscillator = context.createOscillator();
    setFrequency(oscillator, hz, context.currentTime);
    oscillator.connect(master);
    oscillator.start(context.currentTime);
    return oscillator;
  });

  /** One ring pulse on the envelope, then the next cycle is scheduled. */
  const cycle = (): void => {
    if (stopped) return;
    const t = context.currentTime;
    const on = RING_ON_MS / 1000;
    const gain = master.gain;
    gain.setValueAtTime(0, t);
    gain.linearRampToValueAtTime(RING_PEAK_GAIN, t + RING_RAMP_S);
    gain.setValueAtTime(RING_PEAK_GAIN, t + on - RING_RAMP_S);
    gain.linearRampToValueAtTime(0, t + on);
    cycleHandle = schedule(cycle, RING_ON_MS + RING_OFF_MS);
  };
  cycle();

  // Vibration (mobile) follows the same cadence until stopped.
  if (deps.vibrate !== undefined || typeof navigator !== "undefined") {
    const vibrate = deps.vibrate ?? browserVibrate;
    try {
      vibrate(RING_VIBRATION_PATTERN);
      vibrated = true;
    } catch {
      // Cosmetic; the tone is the signal.
    }
  }

  // A suspended context gets a second chance the moment the user touches
  // anything — including this very card's Answer/Decline buttons.
  resume();

  return {
    audible: true,
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancel(cycleHandle);
      unsubscribe();
      try {
        master.gain.setValueAtTime(0, context.currentTime);
      } catch {
        // Context may be closed already; stopping the sources below suffices.
      }
      for (const oscillator of oscillators) {
        try {
          oscillator.stop();
        } catch {
          // Already stopped — the loop is defensive, not load-bearing.
        }
        try {
          oscillator.disconnect();
        } catch {
          // Ditto.
        }
      }
      try {
        master.disconnect();
      } catch {
        // Ditto.
      }
      if (vibrated) {
        const vibrate = deps.vibrate ?? browserVibrate;
        try {
          vibrate([]);
        } catch {
          // Clearing a vibration that is already gone is a no-op anyway.
        }
      }
    },
  };
}

/** Sets an oscillator's frequency, tolerating param-shape differences. */
function setFrequency(oscillator: OscillatorLike, hz: number, time: number): void {
  const frequency = oscillator.frequency as AudioParamLike & { value?: number };
  if (typeof frequency.setValueAtTime === "function") {
    frequency.setValueAtTime(hz, time);
  } else {
    frequency.value = hz;
  }
}

/** The real browser context, or undefined where Web Audio does not exist. */
function defaultCreateContext(): AudioContextLike | undefined {
  if (typeof window === "undefined") return undefined;
  const Ctor = window.AudioContext;
  if (typeof Ctor !== "function") return undefined;
  try {
    return new Ctor() as unknown as AudioContextLike;
  } catch {
    // Some hardened browsers throw on construction; stay silent and visible.
    return undefined;
  }
}
