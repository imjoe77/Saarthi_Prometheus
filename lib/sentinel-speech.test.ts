import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPlaybackFailure,
  speakAlert,
  type SpeechSynthesisLike,
  type SpeechUtteranceLike,
} from "./sentinel-speech.ts";

/**
 * MODULE 14 - the audio-fallback rules, tested headlessly.
 *
 * These cases pin the honesty contract the overlay depends on: `UNAVAILABLE`
 * is returned whenever no sound can be promised (no synthesis, blocked
 * autoplay, nothing to say), so the UI can commit to the readable-text
 * fallback instead of implying a message was heard. Injected fakes stand in
 * for the browser's SpeechSynthesis — a working one, a missing one, and one
 * whose `speak` throws the way a blocked autoplay policy does.
 */

/** A synthesis fake that records what it was asked to say. */
function fakeSynthesis(options?: {
  onSpeak?: (utterance: SpeechUtteranceLike) => void;
  throws?: boolean;
}): SpeechSynthesisLike & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    speaking: false,
    speak(utterance: SpeechUtteranceLike): void {
      if (options?.throws === true) {
        // The blocked-autoplay shape: the browser refuses synchronously.
        throw new Error("play() failed because the user didn't interact");
      }
      spoken.push(utterance.text);
      options?.onSpeak?.(utterance);
    },
    cancel(): void {
      /* not under test */
    },
  };
}

describe("speakAlert", () => {
  it("reports PLAYING and hands the verbatim text to the utterance", () => {
    const synthesis = fakeSynthesis();
    const outcome = speakAlert("Sentinel from Prometheus: my alert fired.", { synthesis });

    assert.equal(outcome, "PLAYING");
    // The message must reach the browser byte-for-byte: it is the monitor's
    // own composition, and recomposing here could contradict the record.
    assert.deepEqual(synthesis.spoken, ["Sentinel from Prometheus: my alert fired."]);
  });

  it("builds the utterance with the injected factory when one is supplied", () => {
    const synthesis = fakeSynthesis();
    const created: string[] = [];
    const outcome = speakAlert("build me", {
      synthesis,
      createUtterance: (text: string): SpeechUtteranceLike => {
        created.push(text);
        return { text, onend: null, onerror: null };
      },
    });

    assert.equal(outcome, "PLAYING");
    assert.deepEqual(created, ["build me"]);
  });

  it("reports UNAVAILABLE when the browser has no speech synthesis", () => {
    // Older browsers, locked-down kiosks and SSR all land here.
    assert.equal(speakAlert("anything", { synthesis: undefined }), "UNAVAILABLE");
  });

  it("reports UNAVAILABLE when speak throws, as a blocked autoplay policy does", () => {
    const synthesis = fakeSynthesis({ throws: true });
    const outcome = speakAlert("blocked before a gesture", { synthesis });

    assert.equal(outcome, "UNAVAILABLE");
    // Nothing was recorded as spoken; the UI must show the text instead.
    assert.deepEqual(synthesis.spoken, []);
  });

  it("reports UNAVAILABLE for empty or whitespace-only text", () => {
    const synthesis = fakeSynthesis();

    assert.equal(speakAlert("", { synthesis }), "UNAVAILABLE");
    assert.equal(speakAlert("   \n\t ", { synthesis }), "UNAVAILABLE");
    // Never attempted: there was nothing to say.
    assert.deepEqual(synthesis.spoken, []);
  });
});

describe("isPlaybackFailure", () => {
  it("treats the codes caused by our own cancel as non-failures", () => {
    // Replay and End deliberately cancel the current utterance; flipping the
    // UI to "audio unavailable" on every Replay would be backwards.
    assert.equal(isPlaybackFailure("canceled"), false);
    assert.equal(isPlaybackFailure("interrupted"), false);
  });

  it("treats every other error code as a genuine playback failure", () => {
    assert.equal(isPlaybackFailure("not-allowed"), true);
    assert.equal(isPlaybackFailure("blocked"), true);
    assert.equal(isPlaybackFailure("synthesis-unavailable"), true);
    assert.equal(isPlaybackFailure("network"), true);
  });

  it("defaults to honesty when the error carries no reason", () => {
    assert.equal(isPlaybackFailure(undefined), true);
    assert.equal(isPlaybackFailure(""), true);
  });
});
