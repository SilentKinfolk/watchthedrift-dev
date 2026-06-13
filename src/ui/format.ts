// Pure presentation helpers for the drift result. Kept out of Screen so the
// user-facing wording — including the honest ± band — is unit-testable without
// a DOM. Black-and-white aesthetic: sign and words carry meaning, never colour.

import type { DriftResult } from '../drift/Drift'

/** The giant headline answer, e.g. "+6 s" / "−3 s" / "0 s". */
export function formatAnswer(d: DriftResult): string {
  const n = Math.round(d.offsetSec)
  if (n === 0) return '0 s'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} s`
}

/** One-line plain-language reading under the answer. */
export function formatDetail(d: DriftResult): string {
  const n = Math.round(d.offsetSec)
  if (n === 0) return 'Spot on — no drift to the nearest second.'
  const unit = Math.abs(n) === 1 ? 'second' : 'seconds'
  const word = d.direction === 'fast' ? 'fast' : 'slow'
  return `Your watch is ${Math.abs(n)} ${unit} ${word}.`
}

/** The honest ± uncertainty band shown beside the reading (quantisation ⊕ time
 *  source), rounded to a tenth of a second, e.g. "± 0.5 s". Returns null when
 *  the band is unbounded — the degraded device-clock fallback — so we never
 *  print "± Infinity"; the time-status line carries that warning instead. */
export function formatBand(d: DriftResult): string | null {
  if (!Number.isFinite(d.uncertaintySec)) return null
  return `± ${d.uncertaintySec.toFixed(1)} s`
}

/** The text slots the result view writes — kept structural (not HTMLElement) so
 *  Screen passes its real elements and tests pass plain stubs, no DOM needed.
 *  `hidden` is `boolean | string` to match the DOM's `hidden="until-found"`. */
export interface ResultSlots {
  answer: { textContent: string | null }
  band: { textContent: string | null; hidden: boolean | string }
  sub: { textContent: string | null }
}

/** Render a drift reading into its slots, always pairing the answer with its
 *  honest ± band. When the band is unbounded (degraded sync) we hide the band
 *  element rather than show "± ∞"; the answer and explanation still appear. */
export function applyResult(els: ResultSlots, d: DriftResult): void {
  els.answer.textContent = formatAnswer(d)
  const band = formatBand(d)
  els.band.textContent = band ?? ''
  els.band.hidden = band === null
  els.sub.textContent = formatDetail(d)
}
