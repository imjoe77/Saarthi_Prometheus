/**
 * MODULE 14 — speaking one Sentinel alert aloud, with an honest fallback.
 *
 * WHY A SEPARATE MODULE. The overlay owns React state; this owns the browser
 * audio decision, so "could this browser actually say it?" stays a pure,
 * unit-testable question instead of being buried in component effects.
 *
 * THE FALLBACK IS A FEATURE, NOT AN ERROR. Speech synthesis can be unavailable
 * for ordinary reasons: no `speechSynthesis` (older browser, locked-down
 * kiosk), a blocked autoplay/audio policy (the browser refuses to start sound
 * before a gesture), or the utterance erroring part-way. In every case the
 * caller gets `UNAVAILABLE` and must render the message as readable text with
 * a replay affordance — the user is never left believing a call was "heard"
 * when nothing was played. Nothing here ever claims audio happened; the
 * outcome is reported, not assumed.
 *
 * DEPENDENCIES ARE INJECTED. `speakAlert` takes the synthesis object and the
 * utterance factory rather than reaching for `window`, so tests drive it with
 * fakes: a working synthesis, a missing one, and one whose `speak` throws (the
 * autoplay-block shape). The browser path supplies the real globals.
 *
 * THIS IS SIMULATED SPEECH ABOUT AN ALERT. It never places a call and never
 * touches a trade — it renders text into sound.
 */

/** The slice of `SpeechSynthesis` this module uses. */
export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  readonly speaking: boolean;
}

/** The slice of `SpeechSynthesisUtterance` this module uses. */
export interface SpeechUtteranceLike {
  text: string;
  onend: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SpeechDeps {
  /** The browser's synthesis, or undefined when the browser has none. */
  readonly synthesis: SpeechSynthesisLike | undefined;
  /** Builds one utterance for a piece of text (injectable for tests). */
  readonly createUtterance?: (text: string) => SpeechUtteranceLike;
}

/**
 * What happened when we tried to speak.
 *
 * `PLAYING` means the synthesis accepted the utterance — audio *started* from
 * the browser's side (it may still be cut short by the OS; the overlay shows
 * the text alongside playback for that reason). `UNAVAILABLE` means no sound
 * can be promised, and the caller must show the text.
 */
export type SpeechOutcome = "PLAYING" | "UNAVAILABLE";

/** The plain utterance used when no browser utterance factory is supplied. */
function plainUtterance(text: string): SpeechUtteranceLike {
  const utterance: SpeechUtteranceLike = { text, onend: null, onerror: null };
  return utterance;
}

/**
 * Speaks `text` once and reports whether audio is actually under way.
 *
 * Deliberately synchronous in its verdict: a synthesis object that is missing,
 * or whose `speak` throws (the classic blocked-autoplay error), answers
 * `UNAVAILABLE` immediately so the UI can settle on the text fallback rather
 * than waiting on an event that will never come. An utterance that errors
 * asynchronously cannot flip this already-delivered verdict — the overlay
 * listens to `onerror` itself for that late case.
 */
export function speakAlert(text: string, deps: SpeechDeps): SpeechOutcome {
  const { synthesis } = deps;
  if (synthesis === undefined || typeof synthesis.speak !== "function") {
    // No synthesis at all: nothing to try.
    return "UNAVAILABLE";
  }
  if (text.trim() === "") {
    // Nothing to say. Not an audio failure, but "played" would be a lie.
    return "UNAVAILABLE";
  }

  const create = deps.createUtterance ?? plainUtterance;
  const utterance = create(text);

  try {
    // Some browsers throw synchronously here when the audio policy blocks
    // playback before a user gesture.
    synthesis.speak(utterance);
  } catch {
    return "UNAVAILABLE";
  }

  return "PLAYING";
}

/**
 * Whether an utterance `error` event means "audio failed, show the text".
 *
 * The browser reports two benign codes when *we* stop playback deliberately —
 * `canceled` (the overlay hit replay/end, which cancels the current utterance)
 * and `interrupted` (a new utterance replaced it). Treating those as failures
 * would flip the UI to "audio unavailable" every time the user pressed
 * Replay, which is backwards. Every other code (blocked, not-allowed,
 * network, synthesis-unavailable) is a genuine failure to be heard.
 */
export function isPlaybackFailure(errorMessage: string | undefined): boolean {
  if (errorMessage === undefined || errorMessage === "") {
    // An error event with no reason is still an error: default to honesty.
    return true;
  }
  return errorMessage !== "canceled" && errorMessage !== "interrupted";
}
