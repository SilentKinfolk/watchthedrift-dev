import type { Recognizer, Recognized, RecognizeInput } from './Recognizer'

// Runs recognisers in priority order and returns the first confident reading.
// The F-91W segment decoder goes first (purpose-built, instant); Tesseract sits
// behind it as a fallback. Each engine self-inits, so the heavy Tesseract wasm
// only loads if a shot actually falls through to it. If every engine declines,
// we surface the *primary's* verdict — its retake hint is the most relevant.

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
