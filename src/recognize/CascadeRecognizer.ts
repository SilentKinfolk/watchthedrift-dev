import type { Recognizer, Recognized, RecognizeInput } from './Recognizer'

// A generic priority cascade: runs recognisers in order and returns the first
// confident reading. Each engine self-inits, so a heavier fallback only loads if a
// shot actually falls through to it. If every engine declines, we surface the
// *primary's* verdict — its retake hint is the most relevant. (v2 reads through a
// single RectifyingSegmentRecognizer; with Tesseract dropped this cascade has no
// engines wired today, but stays as a reusable primitive.)

export class CascadeRecognizer implements Recognizer {
  readonly id: string
  private readonly engines: Recognizer[]

  constructor(engines: Recognizer[]) {
    if (engines.length === 0) throw new Error('CascadeRecognizer needs at least one engine')
    this.engines = engines
    this.id = `cascade(${engines.map((e) => e.id).join(',')})`
  }

  /** Prepare only the primary; fallbacks load lazily on first use. */
  async init(): Promise<void> {
    await this.engines[0].init()
  }

  async recognize(input: RecognizeInput): Promise<Recognized> {
    let primaryFailure: Recognized | null = null
    for (const engine of this.engines) {
      const res = await engine.recognize(input)
      if (res.ok) return res
      if (!primaryFailure) primaryFailure = res
    }
    return primaryFailure ?? { ok: false, reason: 'engine-error' }
  }
}
