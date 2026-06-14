import type { Recognizer, Recognized, RecognizeInput } from './Recognizer.ts'
import { decodeSegments, type DecodeDebug, type DecodeResult } from './segments.ts'
import { rectify, rectifiedSize, type Quad, type RawImage } from './rectify.ts'
import type { CornerSource } from './corners.ts'

// The rectification stage (issue #4): insert the geometry step in front of the v1
// segment decoder so it reads a frontal, straightened LCD instead of the raw
// (possibly angled) crop —
//
//     frame → corner source → rectify (homography) → v1 decoder → reading
//
// behind the existing `Recognizer` interface. The corner source is pluggable (see
// ./corners): a manual stub for the `?corners=` debug override, or the learned
// `KernelCornerSource` (#9). When the source yields no corners — including when the
// detector abstains on an implausible read — we decode the raw crop unchanged, so a
// non-detection is always fail-safe (never worse than v1).

/** Reject reads below this mean per-digit confidence → triggers a retake.
 *  Mirrors SegmentDecoderRecognizer (the same v1 decoder, just on a frontal crop). */
const CONFIDENCE_MIN = 0.6

export interface RectifyDecode {
  result: DecodeResult
  /** The frontal crop that was decoded, or null when no rectification happened. */
  rectified: RawImage | null
  /** Which crop produced `result` — for overlays/diagnostics. */
  source: 'raw' | 'rectified' | 'raw-preferred'
}

/**
 * Pure core of the stage, shared by the recognizer and the Node harness: decode the
 * raw frame, and — given the 4 LCD corners — also decode the rectified frontal crop,
 * then combine the two PRECISION-FIRST.
 *
 * The learned detector's corners are imperfect (the eval-gold corner error is ~0.16
 * of the LCD diagonal on moderate; PLAN top-risk #3), so a slightly-off homography
 * can skew a crop the raw path would have read. We therefore take the rectified read
 * ONLY when it RECOVERS a read the raw path missed (the angle/off-centre geometry
 * win — raw binarises to nothing, rectify lifts it) or CONFIRMS the raw read
 * (agreement). On a clash — both read but disagree — we defer to the validated raw
 * v1 baseline. Net effect: the detector can only ADD read-success on shots raw
 * drops, never break a read raw had nor introduce a new confident-wrong. With no
 * corners (or degenerate ones) it is exactly v1.
 */
export function rectifyThenDecode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  corners: Quad | null,
): RectifyDecode {
  const raw = decodeSegments(data, width, height)
  if (corners) {
    const frontal = rectify({ data, width, height }, corners, rectifiedSize(corners))
    if (frontal) {
      const rect = decodeSegments(frontal.data, frontal.width, frontal.height)
      if (preferRectified(raw.reading, rect.reading)) return { result: rect, rectified: frontal, source: 'rectified' }
      return { result: raw, rectified: frontal, source: 'raw-preferred' }
    }
  }
  return { result: raw, rectified: null, source: 'raw' }
}

interface Hms {
  hh: number
  mm: number
  ss: number
}

/**
 * Precision-first combine decision: should the rectified read override the raw read?
 * True iff the rectified read RECOVERS a read raw missed (raw silent) or CONFIRMS it
 * (agreement). A clash (both read, disagree) returns false → defer to the validated
 * raw v1 baseline, so imperfect learned corners can't add a confident-wrong. Pure,
 * so the combine rule unit-tests without images.
 */
export function preferRectified(rawReading: Hms | null, rectReading: Hms | null): boolean {
  if (!rectReading) return false
  if (!rawReading) return true
  return sameTime(rectReading, rawReading)
}

function sameTime(a: Hms, b: Hms): boolean {
  return a.hh === b.hh && a.mm === b.mm && a.ss === b.ss
}

export class RectifyingSegmentRecognizer implements Recognizer {
  readonly id = 'rectify+f91w-segments'
  /** Debug from the most recent decode, for the ?debug=1 overlay (same shape the
   *  SegmentDecoderRecognizer exposes, so the debug view is unchanged). */
  lastDebug: DecodeDebug | null = null
  private readonly cornerSource: CornerSource

  constructor(cornerSource: CornerSource) {
    this.cornerSource = cornerSource
  }

  async init(): Promise<void> {
    await this.cornerSource.init?.()
  }

  async recognize(input: RecognizeInput): Promise<Recognized> {
    try {
      const ctx = input.canvas.getContext('2d')
      if (!ctx) return { ok: false, reason: 'engine-error' }
      const { width, height } = input.canvas
      const { data } = ctx.getImageData(0, 0, width, height)

      const corners = this.cornerSource.corners({ data, width, height })
      const { result, source } = rectifyThenDecode(data, width, height, corners)
      const { reading, debug } = result
      this.lastDebug = debug

      const cells = debug.cells.map((c) => (c.kind === 'colon' ? ':' : (c.digit ?? '?'))).join('')
      const raw = `${reading ? fmt(reading) : '—'} [${cells}] (${source}; ${debug.note})`

      if (!reading) return { ok: false, reason: 'no-digits', raw }
      if (reading.confidence < CONFIDENCE_MIN) return { ok: false, reason: 'low-confidence', raw }
      return {
        ok: true,
        value: { hh: reading.hh, mm: reading.mm, ss: reading.ss, confidence: reading.confidence, raw },
      }
    } catch {
      return { ok: false, reason: 'engine-error' }
    }
  }
}

function fmt(t: { hh: number; mm: number; ss: number }): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(t.hh)}:${p(t.mm)}:${p(t.ss)}`
}
