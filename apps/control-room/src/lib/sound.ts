/**
 * ── Audible outcomes ─────────────────────────────────────────────────────────
 *
 * Two officials standing over a reader are looking at each other and at the
 * package, not at a monitor. The screen is the record; the sound is what tells
 * them the answer in the moment.
 *
 * The patterns are made deliberately unlike one another rather than pleasantly
 * similar. A refusal that sounds like a slightly different success is a refusal
 * people walk past, so granted rises and refused is three flat low tones — which
 * one just played is obvious across a room and through a door.
 *
 * Synthesised rather than shipped as audio files: a few oscillators cost nothing
 * to load, always play, and cannot silently 404 in the one moment that matters.
 */

let ctx: AudioContext | null = null;
let enabled = true;

/**
 * Browsers refuse to start audio without a user gesture, so this must be called
 * from a click handler. Doing it lazily and everywhere else would give a page
 * that is silent for the first outcome and audible thereafter — worse than
 * being silent throughout, because nobody would know which they were getting.
 */
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (on) unlockAudio();
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function isAudioReady(): boolean {
  return ctx !== null && ctx.state === "running";
}

/**
 * One tone.
 *
 * The gain ramps up and down rather than switching, because an abrupt edge on a
 * square wave produces a click loud enough to be mistaken for the signal itself.
 */
function tone(
  freq: number,
  startAt: number,
  durationMs: number,
  type: OscillatorType = "sine",
  peak = 0.22,
): void {
  if (!ctx) return;
  const dur = durationMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);

  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.setValueAtTime(peak, startAt + dur - 0.03);
  gain.gain.linearRampToValueAtTime(0, startAt + dur);

  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

function play(build: (t0: number) => void): void {
  if (!enabled) return;
  unlockAudio();
  if (!ctx || ctx.state !== "running") return;
  build(ctx.currentTime + 0.01);
}

// ── the vocabulary ──────────────────────────────────────────────────────────

/** One official has authenticated. Neutral: the ceremony is not finished. */
export function soundAssertion(): void {
  play((t) => tone(880, t, 130));
}

/** Both officials, distinct templates, inside the window. */
export function soundTwoPerson(): void {
  play((t) => {
    tone(660, t, 120);
    tone(880, t + 0.14, 180);
  });
}

/** The access engine said yes. Rising, and the only rising figure here. */
export function soundGranted(): void {
  play((t) => {
    tone(660, t, 130);
    tone(880, t + 0.15, 130);
    tone(1320, t + 0.3, 320);
  });
}

/** The access engine said no. Three flat low tones, nothing like the above. */
export function soundDenied(): void {
  play((t) => {
    for (let i = 0; i < 3; i++) tone(196, t + i * 0.46, 360, "square", 0.18);
  });
}

/** A finger matched nothing, matched too weakly, or was the same finger twice. */
export function soundRefused(): void {
  play((t) => tone(196, t, 420, "square", 0.18));
}

/**
 * A monitor stopped reporting.
 *
 * Two notes, repeated, at a pitch that sits under conversation rather than
 * over it — this is a condition somebody has to notice, but it is not the
 * ceremony being refused and must not sound like it.
 */
export function soundSilent(): void {
  play((t) => {
    for (let i = 0; i < 2; i++) {
      tone(440, t + i * 0.5, 160, "triangle", 0.16);
      tone(330, t + i * 0.5 + 0.18, 200, "triangle", 0.16);
    }
  });
}
