import type { Recognizer, Recognized, RecognizeInput } from './Recognizer'
import { decodeSegments, type DecodeDebug } from './segments'

// Primary recogniser: the purpose-built F-91W seven-segment decoder
// (./segments). It owns all binarisation, so it reads the crop's pixels directly
// — feeding it the already-binarised preprocess canvas is equivalent (its Otsu
// on a {0,255} image reproduces the same ink mask), and matches the Node harness.
//
// No heavy assets to load, so init() is a no-op and the engine is instant.

/** Reject reads below this mean per-digit confidence → triggers a retake. */
const CONFIDENCE_MIN = 0.6

export class SegmentDecoderRecognizer implements Recognizer {
  readonly id = 'f91w-segments'
  /** Debug from the most recent decode, for the ?debug=1 overlay. */
  lastDebug: DecodeDebug | null = null

  async init(): Promise<void> {}

  async recognize(input: RecognizeInput): Promise<Recognized> {
    try {
      const ctx = input.canvas.getContext('2d')
      if (!ctx) return { ok: false, reason: 'engine-error' }
      const { width, height } = input.canvas
      const { data } = ctx.getImageData(0, 0, width, height)

      const { reading, debug } = decodeSegments(data, width, height)
      this.lastDebug = debug
      const cells = debug.cells.map((c) => (c.kind === 'colon' ? ':' : (c.digit ?? '?'))).join('')
      const raw = `${reading ? fmt(reading) : '—'} [${cells}] (${debug.note})`

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
