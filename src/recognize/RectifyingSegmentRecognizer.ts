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
// behind the existing `Recognizer` interface. The corner source is a throwaway
// stub today (see ./corners); the learned detector (#9) drops in at the same seam.
// When the source yields no corners we decode the raw crop unchanged, so the live
// app is a no-op until corners are actually supplied.

/** Reject reads below this mean per-digit confidence → triggers a retake.
 *  Mirrors SegmentDecoderRecognizer (the same v1 decoder, just on a frontal crop). */
const CONFIDENCE_MIN = 0.6

/**
 * Pure core of the stage, shared by the recognizer and the Node harness: take the
 * 4 LCD corners, rectify, and run the v1 decoder on the frontal crop. With no
 * corners (or degenerate ones), fall back to decoding the raw frame — so this can
 * never do worse than v1 on the wiring alone. Returns the decode plus the frontal
 * crop it read (null when it fell back), for overlays/diagnostics.
 */
export function rectifyThenDecode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  corners: Quad | null,
): { result: DecodeResult; rectified: RawImage | null } {
  if (corners) {
    const frontal = rectify({ data, width, height }, corners, rectifiedSize(corners))
    if (frontal) {
      return { result: decodeSegments(frontal.data, frontal.width, frontal.height), rectified: frontal }
    }
  }
  return { result: decodeSegments(data, width, height), rectified: null }
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

  async init(): Promise<void> {}

  async recognize(input: RecognizeInput): Promise<Recognized> {
    try {
      const ctx = input.canvas.getContext('2d')
      if (!ctx) return { ok: false, reason: 'engine-error' }
      const { width, height } = input.canvas
      const { data } = ctx.getImageData(0, 0, width, height)

      const corners = this.cornerSource.corners(width, height)
      const { result } = rectifyThenDecode(data, width, height, corners)
      const { reading, debug } = result
      this.lastDebug = debug

      const cells = debug.cells.map((c) => (c.kind === 'colon' ? ':' : (c.digit ?? '?'))).join('')
      const src = corners ? 'rectified' : 'raw'
      const raw = `${reading ? fmt(reading) : '—'} [${cells}] (${src}; ${debug.note})`

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
