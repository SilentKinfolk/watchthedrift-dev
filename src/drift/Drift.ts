// Computes how far a watch's displayed time is from true time, as a signed
// number of seconds (+ = the watch is ahead of / fast vs real time).
//
// Measurement model: the watch shows whole seconds, so when it displays second
// D its internal time lies somewhere in [D, D+1). The unbiased point estimate
// of the watch's true reading is therefore D + 0.5, carrying a ±0.5 s
// quantisation band. We compare that against the true local time-of-day, taking
// the nearest equivalent modulo the watch's display period — 24 h normally, or
// 12 h when the watch is in 12-hour mode and we can't read AM/PM. Because the
// real offset is only seconds, "nearest" resolves AM/PM and any minute / hour /
// midnight boundary automatically.

export type Direction = 'fast' | 'slow' | 'exact'

export interface WatchReading {
  hh: number
  mm: number
  ss: number
}

export interface DriftResult {
  /** Signed best estimate, seconds. + = watch is ahead of (fast vs) true time. */
  offsetSec: number
  /** Half-width of the uncertainty band, seconds (quantisation ⊕ time source). */
  uncertaintySec: number
  /** Direction at whole-second display resolution. */
  direction: Direction
}

const SECONDS_PER_DAY = 86_400
/** A whole-second display is known only to ±0.5 s. */
export const QUANTISATION_SEC = 0.5

/** Positive remainder: result is always in [0, m). */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

export function computeDrift(
  watch: WatchReading,
  trueUtcMs: number,
  trueUncertaintyMs: number,
  /** From `new Date().getTimezoneOffset()`: (UTC − local) in minutes. */
  tzOffsetMin: number,
  /** Watch is in 24-hour mode; otherwise 12-hour (hours 1–12, AM/PM unknown). */
  is24h: boolean,
): DriftResult {
  // In 12 h mode AM/PM is unknown, so the ambiguity folds to a 12 h period.
  const period = is24h ? SECONDS_PER_DAY : SECONDS_PER_DAY / 2

  // True local time-of-day in (fractional) seconds, reduced into the period.
  const localMs = trueUtcMs - tzOffsetMin * 60_000
  const trueSec = mod(localMs / 1000, period)

  // Watch reading as seconds-of-period, taken at the midpoint of the shown second.
  const hour = is24h ? watch.hh : watch.hh % 12
  const watchSec = mod(hour * 3600 + watch.mm * 60 + watch.ss + QUANTISATION_SEC, period)

  // Nearest signed difference, within ±period/2.
  let offsetSec = mod(watchSec - trueSec, period)
  if (offsetSec > period / 2) offsetSec -= period

  const uncertaintySec = QUANTISATION_SEC + trueUncertaintyMs / 1000

  const shown = Math.round(offsetSec)
  const direction: Direction = shown > 0 ? 'fast' : shown < 0 ? 'slow' : 'exact'

  return { offsetSec, uncertaintySec, direction }
}
