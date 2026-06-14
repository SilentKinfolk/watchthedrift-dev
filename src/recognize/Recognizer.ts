import type { WatchReading } from '../drift/Drift'

// A pluggable time reader. v2's engine is the purpose-built F-91W segment decoder,
// fed a frontal crop by the learned corner detector (RectifyingSegmentRecognizer).
// General OCR (Tesseract) was dropped — it can't read the rigid seven-segment font.

export interface RecognitionResult extends WatchReading {
  /** Calibrated 0..1 confidence. */
  confidence: number
  /** Raw decoder summary (read + cells), surfaced in the debug view. */
  raw: string
}

export type Recognized =
  | { ok: true; value: RecognitionResult }
  | { ok: false; reason: 'low-confidence' | 'no-digits' | 'engine-error'; raw?: string }

export interface RecognizeInput {
  /** Preprocessed time-region canvas (the decoder owns binarisation). */
  canvas: HTMLCanvasElement
  /** Watch's display mode, from the manual toggle — constrains hour parsing. */
  is24h: boolean
}

export interface Recognizer {
  readonly id: string
  /** Lazily load any heavy assets (e.g. the corner-detector model). */
  init(): Promise<void>
  recognize(input: RecognizeInput): Promise<Recognized>
}
