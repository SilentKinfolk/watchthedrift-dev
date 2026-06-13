import { createWorker, PSM } from 'tesseract.js'
import type { Recognizer, Recognized, RecognizeInput } from './Recognizer'
import { parseTime } from './parse'

// v1 OCR engine: Tesseract.js with a seven-segment ("ssd") model, restricted to
// digits and colons. The model file is bundled under public/traineddata as
// `digits.traineddata` (currently the compact ssd_int model — swap in the
// larger float model under the same name if accuracy demands it). The wasm core
// and worker are loaded from Tesseract's default CDN for now.

const LANG = 'digits'
const CONFIDENCE_MIN = 0.7

function langPath(): string {
  const base = import.meta.env.BASE_URL ?? '/'
  return `${base}traineddata`
}

export class TesseractRecognizer implements Recognizer {
  readonly id = 'tesseract-ssd'
  private worker: Awaited<ReturnType<typeof createWorker>> | null = null

  async init(): Promise<void> {
    if (this.worker) return
    const worker = await createWorker(LANG, 1, { langPath: langPath(), gzip: false })
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789:',
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
    })
    this.worker = worker
  }

  async recognize(input: RecognizeInput): Promise<Recognized> {
    try {
      if (!this.worker) await this.init()
      const { data } = await this.worker!.recognize(input.canvas)
      const raw = (data.text ?? '').trim()
      const confidence = (data.confidence ?? 0) / 100

      const parsed = parseTime(raw, input.is24h)
      if (!parsed) return { ok: false, reason: 'no-digits', raw }
      if (confidence < CONFIDENCE_MIN) return { ok: false, reason: 'low-confidence', raw }
      return { ok: true, value: { ...parsed, confidence, raw } }
    } catch {
      return { ok: false, reason: 'engine-error' }
    }
  }

  async terminate(): Promise<void> {
    await this.worker?.terminate()
    this.worker = null
  }
}
