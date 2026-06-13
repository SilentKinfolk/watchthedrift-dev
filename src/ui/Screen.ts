import { Camera, type CameraError } from '../camera/Camera'
import { TimeSync } from '../time/TimeSync'
import { RectifyingSegmentRecognizer } from '../recognize/RectifyingSegmentRecognizer'
import { manualCornerSource } from '../recognize/corners'
import { drawDecodeOverlay } from '../recognize/overlay'
import { preprocess } from '../recognize/preprocess'
import { TIME_CROP, cropToPixels, cropOverride, type NormCrop, type PixelRect } from '../recognize/geometry'
import { computeDrift, type DriftResult } from '../drift/Drift'
import { isDebug, renderDebug } from './DebugView'

type State = 'idle' | 'starting' | 'preview' | 'scanning' | 'result' | 'error'

// Live-scan tuning. We decode frames continuously and lock once two reads agree.
const SCAN_GAP_MS = 150 // pause between decode attempts (self-paced, no overlap)
const SCAN_MIN_PAIR_MS = 400 // two corroborating reads must be ≥ this far apart in time
const SCAN_AGREE_S = 1.0 // …and their drift must match within this many seconds
const SCAN_SAMPLE_WINDOW_MS = 4000 // forget reads older than this when corroborating
const SCAN_HINT_AFTER_MS = 7000 // nudge the user if nothing has read by now
const DEBUG_RENDER_GAP_MS = 350 // throttle the ?debug overlay while scanning

// The whole single-screen app. Holds a stable DOM skeleton (so the live <video>
// survives state changes) and swaps text / buttons / visibility per state.
export class Screen {
  private readonly root: HTMLElement
  private readonly camera = new Camera()
  private readonly time = new TimeSync()
  // The F-91W segment decoder reads the alignment box: we crop to TIME_CROP (the
  // on-screen box) and it locates + locally re-thresholds the LCD within that
  // crop. Cropping tight keeps binarisation clean — feeding the whole frame let a
  // bright background skew the threshold and read an off-angle face as all-black.
  //
  // The decoder now sits behind the rectification stage (#4): given the LCD's four
  // corners it reads a frontal, straightened crop. The corner source is a throwaway
  // stub for now (manual `?corners=` override) and returns null otherwise, so with
  // no override this is identical to feeding the raw crop straight to v1.
  private readonly recognizer = new RectifyingSegmentRecognizer(manualCornerSource())
  private readonly debug = isDebug()

  private state: State = 'idle'
  private is24h = true
  private lastDrift: DriftResult | null = null
  private crop: NormCrop = cropOverride() ?? TIME_CROP
  // Live reference-clock tick (self-correcting onto the true-second boundary).
  private clockTimer: ReturnType<typeof setTimeout> | null = null

  // Live-scan loop state.
  private scanning = false
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private scanStartedAt = 0
  private lastDebugAt = 0
  /** Recent valid reads (drift + capture time) for the agree-twice cross-check. */
  private samples: Array<{ offsetSec: number; at: number }> = []

  private video!: HTMLVideoElement
  private viewfinder!: HTMLElement
  private guide!: HTMLElement
  private clockBox!: HTMLElement
  private clockTime!: HTMLElement
  private answer!: HTMLElement
  private sub!: HTMLElement
  private cond!: HTMLElement
  private controls!: HTMLElement
  private debugBox!: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.build()
    // Sync the clock in the background while the user gets the camera going.
    this.time
      .sync()
      .then(() => {
        this.refreshCond()
        this.renderClock() // snap the reference clock onto true time at once
      })
      .catch(() => {})
  }

  private build(): void {
    this.root.innerHTML = `
      <h1 class="question">How many seconds is your watch off?</h1>
      <div class="clock" hidden>
        <div class="clock-time">--:--:--</div>
        <div class="clock-label">true time now — compare with your watch</div>
      </div>
      <div class="viewfinder" hidden>
        <video playsinline muted></video>
        <div class="guide"></div>
      </div>
      <div class="answer" hidden></div>
      <p class="sub"></p>
      <p class="cond"></p>
      <div class="controls"></div>
      <div class="debug" hidden></div>
    `
    this.viewfinder = this.q('.viewfinder')
    this.video = this.q('video')
    this.guide = this.q('.guide')
    this.clockBox = this.q('.clock')
    this.clockTime = this.q('.clock-time')
    this.answer = this.q('.answer')
    this.sub = this.q('.sub')
    this.cond = this.q('.cond')
    this.controls = this.q('.controls')
    this.debugBox = this.q('.debug')
    this.applyGuide()
    this.setState('idle')
    this.startClock()
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T
  }

  /** Position the alignment box from the crop fractions. Because the viewfinder's
   *  aspect-ratio is set to the camera frame's, on-screen fractions map 1:1 to
   *  frame fractions — so what's framed is exactly what gets cropped for OCR. */
  private applyGuide(): void {
    const c = this.crop
    this.guide.style.left = `${(c.cx - c.w / 2) * 100}%`
    this.guide.style.top = `${(c.cy - c.h / 2) * 100}%`
    this.guide.style.width = `${c.w * 100}%`
    this.guide.style.height = `${c.h * 100}%`
  }

  private setState(state: State): void {
    if (state !== 'scanning') this.stopScan()
    this.state = state
    this.viewfinder.hidden = !(state === 'preview' || state === 'scanning')
    // Reference clock is useful from idle through result; only hidden while the
    // camera is spinning up or on an error screen.
    this.clockBox.hidden = state === 'starting' || state === 'error'
    this.answer.hidden = state !== 'result'
    this.controls.innerHTML = ''

    switch (state) {
      case 'idle':
        this.setSub('Point your phone at your Casio F-91W and measure how far it has drifted from real time.')
        this.controls.append(this.btn('Start camera', () => void this.startCamera()))
        break
      case 'starting':
        this.setSub('Starting the camera…')
        break
      case 'preview':
        this.setSub('Fit the time row (HH:MM:SS) inside the box, hold steady, then tap Scan.')
        this.controls.append(this.btn('Scan', () => void this.startScan()), this.modeToggle())
        if (this.debug) this.controls.append(this.sizeControls())
        break
      case 'scanning':
        this.setSub('Scanning… keep the time row inside the box and hold steady.')
        this.controls.append(this.btn('Stop', () => this.setState('preview')))
        break
      case 'result': {
        const d = this.lastDrift!
        this.answer.textContent = formatBig(d)
        this.setSub(formatSub(d))
        this.controls.append(this.btn('Scan again', () => void this.startScan()))
        break
      }
      case 'error':
        break
    }
    this.refreshCond()
  }

  private async startCamera(): Promise<void> {
    this.setState('starting')
    const res = await this.camera.start(this.video)
    if (res.ok) {
      this.viewfinder.style.aspectRatio = `${res.value.width} / ${res.value.height}`
      this.applyGuide()
      this.setState('preview')
    } else {
      this.showError(res.error)
    }
  }

  /** Begin continuously decoding frames until two reads agree (point-and-catch). */
  private async startScan(): Promise<void> {
    if (this.state === 'scanning') return
    // Make sure the clock sync is in flight; processFrame waits for it to land.
    if (!this.time.current) this.time.sync().then(() => this.refreshCond()).catch(() => {})
    await this.recognizer.init() // instant for the segment decoder
    this.samples = []
    this.scanning = true
    this.scanStartedAt = performance.now()
    this.setState('scanning')
    void this.scanTick()
  }

  private stopScan(): void {
    this.scanning = false
    if (this.scanTimer != null) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  }

  /** One self-paced scan step: decode a frame, then schedule the next (no overlap). */
  private async scanTick(): Promise<void> {
    if (!this.scanning) return
    try {
      await this.processFrame()
    } catch {
      // A bad frame is fine — just try the next one.
    }
    if (this.scanning) this.scanTimer = setTimeout(() => void this.scanTick(), SCAN_GAP_MS)
  }

  /** Grab one timestamped frame, decode it, and lock once two reads corroborate.
   *  The drift is computed from the frame's own capture instant, so "when the
   *  picture was taken" is exact even though the video is live. */
  private async processFrame(): Promise<void> {
    if (!this.time.current) return // wait for the clock; keep scanning

    // Timestamp at the grab — this frame is a self-contained (time, image) pair.
    const cap = this.camera.capture()
    const trueUtc = this.time.trueUtcAt(cap.perfTimestamp)
    const rect = cropToPixels(this.crop, cap.width, cap.height)
    const pre = preprocess(cap.canvas, rect)
    const rec = await this.recognizer.recognize({ canvas: pre.canvas, is24h: this.is24h })
    if (!this.scanning) return // stopped while we were decoding

    if (this.debug && cap.perfTimestamp - this.lastDebugAt > DEBUG_RENDER_GAP_MS) {
      this.lastDebugAt = cap.perfTimestamp
      renderDebug(this.debugBox, {
        scene: cropCanvas(cap.canvas, rect, 480),
        decoded: this.decodedCanvas(),
        raw: rec.ok ? rec.value.raw : rec.raw ?? '',
        confidence: rec.ok ? rec.value.confidence : undefined,
        crop: this.crop,
      })
      this.debugBox.hidden = false
    }

    if (!rec.ok) {
      if (performance.now() - this.scanStartedAt > SCAN_HINT_AFTER_MS && this.samples.length === 0) {
        this.setSub('Still looking — line the time row up inside the box, in good light, and hold steady.')
      }
      return
    }

    const drift = computeDrift(
      rec.value,
      trueUtc.epochMs,
      trueUtc.uncertaintyMs,
      new Date().getTimezoneOffset(),
      this.is24h,
    )
    const at = cap.perfTimestamp
    // Lock when an earlier read (≥ SCAN_MIN_PAIR_MS ago) agrees on the drift — an
    // honest watch ticks in step with real time, so two true reads match; a random
    // misread lands somewhere else and is discarded.
    const corroborated = this.samples.some(
      (s) => at - s.at >= SCAN_MIN_PAIR_MS && Math.abs(s.offsetSec - drift.offsetSec) <= SCAN_AGREE_S,
    )
    this.samples.push({ offsetSec: drift.offsetSec, at })
    this.samples = this.samples.filter((s) => at - s.at <= SCAN_SAMPLE_WINDOW_MS)

    if (corroborated) {
      this.lastDrift = drift
      this.setState('result')
    } else {
      this.setSub('Got the time — hold steady…')
    }
  }

  /** ?debug=1 image: the decoder's detected LCD, binarised, with its band/cell
   *  boxes drawn on — so on a real watch you can see exactly what it locked onto. */
  private decodedCanvas(): HTMLCanvasElement | undefined {
    const dbg = this.recognizer.lastDebug
    if (!dbg?.crop) return undefined
    const { ink, width, height } = dbg.crop
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(width, height)
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
      const v = ink[p] ? 0 : 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    drawDecodeOverlay(ctx, dbg)
    return canvas
  }

  private showError(e: CameraError): void {
    this.state = 'error'
    this.viewfinder.hidden = true
    this.answer.hidden = true
    this.controls.innerHTML = ''
    this.setSub(cameraErrorMessage(e))
    if (e === 'denied' || e === 'no-camera') {
      this.controls.append(this.btn('Try again', () => void this.startCamera()))
    }
    this.refreshCond()
  }

  private btn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  private modeToggle(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'mode'
    const label = document.createElement('span')
    label.className = 'mode-label'
    label.textContent = 'watch mode:'
    wrap.appendChild(label)

    const make = (text: string, is24h: boolean): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'textlink'
      b.textContent = text
      b.setAttribute('aria-pressed', String(this.is24h === is24h))
      b.addEventListener('click', () => {
        this.is24h = is24h
        wrap.querySelectorAll('button').forEach((btn) => {
          btn.setAttribute('aria-pressed', String((btn.textContent === '24h') === this.is24h))
        })
        this.renderClock() // match the watch's mode so the comparison lines up
      })
      return b
    }
    wrap.append(make('12h', false), make('24h', true))
    return wrap
  }

  /** Debug-only live box sizing, so the crop can be dialled in on-device. */
  private sizeControls(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'mode'
    const readout = document.createElement('span')
    readout.className = 'mode-label'
    const update = (): void => {
      this.applyGuide()
      const c = this.crop
      readout.textContent = `box ${c.w.toFixed(2)}×${c.h.toFixed(2)} @ ${c.cx.toFixed(2)},${c.cy.toFixed(2)}`
    }
    const adj = (dw: number, dh: number) => (): void => {
      this.crop = {
        ...this.crop,
        w: clamp(this.crop.w + dw, 0.08, 1),
        h: clamp(this.crop.h + dh, 0.05, 1),
      }
      update()
    }
    const link = (label: string, on: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'textlink'
      b.textContent = label
      b.addEventListener('click', on)
      return b
    }
    wrap.append(
      link('W−', adj(-0.04, 0)),
      link('W+', adj(0.04, 0)),
      link('H−', adj(0, -0.03)),
      link('H+', adj(0, 0.03)),
      readout,
    )
    update()
    return wrap
  }

  private setSub(text: string): void {
    this.sub.textContent = text
  }

  private refreshCond(): void {
    this.cond.textContent = this.timeStatusText()
  }

  /** Best estimate of true UTC right now, epoch ms: the synced reference once we
   *  have it, otherwise the bare device clock until the first sync lands. */
  private trueNowMs(): number {
    return this.time.current ? this.time.trueUtcAt(performance.now()).epochMs : Date.now()
  }

  private renderClock(): void {
    this.clockTime.textContent = formatClock(new Date(this.trueNowMs()), this.is24h)
  }

  /** Tick the reference clock in step with real time. After each render we wait
   *  out the rest of the current true second (plus a hair) so the displayed
   *  seconds flip on the real boundary — what matters when eyeballing the watch
   *  against it. setInterval(…, 1000) would slowly drift off the boundary. */
  private startClock(): void {
    const tick = (): void => {
      this.renderClock()
      const delay = 1000 - (this.trueNowMs() % 1000) + 15
      this.clockTimer = setTimeout(tick, delay)
    }
    if (this.clockTimer != null) clearTimeout(this.clockTimer)
    tick()
  }

  private timeStatusText(): string {
    const o = this.time.current
    if (!o) return 'checking the time…'
    if (o.degraded) {
      return '⚠ couldn’t reach a time server — using this device’s clock, so treat the result as rough.'
    }
    const names: Record<string, string> = {
      timeapi: 'timeapi.io',
      cloudflare: 'Cloudflare',
      'date-header': 'the server clock',
      device: 'this device',
    }
    return `time checked against ${names[o.source] ?? o.source}`
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** HH:MM:SS in the watch's own mode, so the on-screen reference reads like the
 *  face. 12h drops the leading zero and tags am/pm to disambiguate. */
function formatClock(d: Date, is24h: boolean): string {
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  if (is24h) return `${String(d.getHours()).padStart(2, '0')}:${mm}:${ss}`
  const h = d.getHours() % 12 || 12
  return `${h}:${mm}:${ss} ${d.getHours() < 12 ? 'am' : 'pm'}`
}

function formatBig(d: DriftResult): string {
  const n = Math.round(d.offsetSec)
  if (n === 0) return '0 s'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} s`
}

function formatSub(d: DriftResult): string {
  const n = Math.round(d.offsetSec)
  if (n === 0) return 'Spot on — no drift to the nearest second.'
  const unit = Math.abs(n) === 1 ? 'second' : 'seconds'
  const word = d.direction === 'fast' ? 'fast' : 'slow'
  return `Your watch is ${Math.abs(n)} ${unit} ${word}.`
}

function cameraErrorMessage(e: CameraError): string {
  switch (e) {
    case 'denied':
      return 'Camera permission was denied. This tool reads the watch on your device — nothing is uploaded. Allow the camera and try again.'
    case 'no-camera':
      return 'No usable camera was found on this device.'
    case 'insecure-context':
      return 'The camera needs a secure (https) connection.'
    case 'unavailable':
      return 'This browser doesn’t support camera access.'
  }
}

/** Build a downscaled colour crop of the captured frame, for the debug view. */
function cropCanvas(source: HTMLCanvasElement, rect: PixelRect, maxW: number): HTMLCanvasElement {
  const sx = Math.max(0, Math.min(rect.x, source.width - 1))
  const sy = Math.max(0, Math.min(rect.y, source.height - 1))
  const sw = Math.max(1, Math.min(rect.w, source.width - sx))
  const sh = Math.max(1, Math.min(rect.h, source.height - sy))
  const scale = sw > maxW ? maxW / sw : 1
  const c = document.createElement('canvas')
  c.width = Math.round(sw * scale)
  c.height = Math.round(sh * scale)
  c.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height)
  return c
}
