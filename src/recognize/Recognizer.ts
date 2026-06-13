import type { WatchReading } from '../drift/Drift'

// A pluggable time reader. v1 uses Tesseract; a purpose-built F-91W segment
// decoder will implement the same interface and become the primary engine.

export interface RecognitionResult extends WatchReading {
  /** Calibrated 0..1 confidence. */
  confidence: number
  /** Raw OCR text, surfaced in the debug view. */
  raw: string
}

export type Recognized =
  | { ok: true; value: RecognitionResult }
  | { ok: false; reason: 'low-confidence' | 'no-digits' | 'engine-error'; raw?: string }

export interface RecognizeInput {
  /** Preprocessed (binarised) time-region canvas. */
  canvas: HTMLCanvasElement
  /** Watch's display mode, from the manual toggle — constrains hour parsing. */
  is24h: boolean
}

export interface Recognizer {
  readonly id: string
  /** Lazily load any heavy assets (wasm, traineddata). */
  init(): Promise<void>
  recognize(input: RecognizeInput): Promise<Recognized>
}
