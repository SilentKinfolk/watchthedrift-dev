// The browser shell of the corner-annotation tool (issue #8) — "click the 4 LCD
// corners + enter the time → write the sidecar", point-and-click. It is pure DOM
// glue: every load-bearing decision (canonicalising click order to TL,TR,BR,BL,
// assembling + validating the sidecar) lives in the shared, unit-tested core
// (src/eval/annotate.ts), which the Node CLI (tools/annotate.ts) drives too. So this
// file carries only canvas/event wiring and the click→image-pixel mapping.
//
// Dev-only: Vite serves it under `npm run dev`; `vite build` never bundles it (the
// app build's single input is the root index.html), so it can't bloat first load.

import { buildCornerLabel, serializeCornerLabel, orderCorners } from '../../src/eval/annotate.ts'
import { sidecarPathFor, type Pt, type Stratum, type Time } from '../../src/eval/label.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const fileInput = $<HTMLInputElement>('file')
const canvas = $<HTMLCanvasElement>('canvas')
const ctx = canvas.getContext('2d')!
const statusEl = $('status')
const outEl = $('out')
const outName = $('outname')
const errorEl = $('error')
const downloadBtn = $<HTMLButtonElement>('download')
const copyBtn = $<HTMLButtonElement>('copy')

let img: HTMLImageElement | null = null
let imageName = ''
let points: Pt[] = []
let sidecarText = ''

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const

/** Redraw the photo, the numbered raw clicks, and — once four are down — the
 *  canonical quad with its TL/TR/BR/BL labels, so the annotator can SEE the order
 *  the core will assign before committing. Marker/line sizes scale with the image so
 *  they stay visible on a multi-megapixel canvas shown shrunk-to-fit. */
function redraw(): void {
  if (!img) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)
  const r = Math.max(6, Math.round(canvas.width / 120))
  ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400))
  ctx.font = `${r * 2}px sans-serif`

  points.forEach((p, i) => {
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.fillStyle = '#000'
    ctx.fillText(String(i + 1), p.x + r, p.y - r)
  })

  if (points.length === 4) {
    try {
      const ordered = orderCorners(points)
      ctx.beginPath()
      ordered.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
      ctx.strokeStyle = '#000'
      ctx.stroke()
      ctx.fillStyle = '#000'
      ordered.forEach((p, i) => ctx.fillText(CORNER_LABELS[i], p.x + r, p.y + r * 2.5))
    } catch {
      // orderCorners needs four finite points; until then just show the raw dots.
    }
  }
  statusEl.textContent = `${points.length}/4 corners`
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  if (!f) return
  imageName = f.name
  const url = URL.createObjectURL(f)
  const image = new Image()
  image.onload = () => {
    img = image
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    points = []
    sidecarText = ''
    outEl.textContent = ''
    outName.textContent = ''
    downloadBtn.disabled = true
    copyBtn.disabled = true
    redraw()
    URL.revokeObjectURL(url)
  }
  image.src = url
})

// Map a click in CSS pixels to the canvas's own (image) pixel space — the canvas is
// sized to the image's natural resolution but shrunk by CSS, so corners come out in
// the image's OWN resolution, exactly what the label schema stores.
canvas.addEventListener('click', (e) => {
  if (!img || points.length >= 4) return
  const rect = canvas.getBoundingClientRect()
  const x = (e.clientX - rect.left) * (canvas.width / rect.width)
  const y = (e.clientY - rect.top) * (canvas.height / rect.height)
  points.push({ x: Math.round(x), y: Math.round(y) })
  redraw()
})

$('undo').addEventListener('click', () => {
  points.pop()
  redraw()
})
$('clear').addEventListener('click', () => {
  points = []
  redraw()
})

/** Parse the time box: blank → `undefined` (omit it; the harness falls back to the
 *  filename `_HH-MM-SS_`), a valid HH:MM:SS → a `Time`, anything else → `null` (a
 *  signal to error rather than silently drop a typo'd time). */
function parseTimeBox(raw: string): Time | null | undefined {
  const t = raw.trim()
  if (!t) return undefined
  const m = t.match(/^(\d{1,2})[:-](\d{2})[:-](\d{2})$/)
  if (!m) return null
  return { hh: +m[1], mm: +m[2], ss: +m[3] }
}

$('build').addEventListener('click', () => {
  errorEl.textContent = ''
  try {
    if (points.length !== 4) throw new Error(`click 4 corners (have ${points.length})`)
    const time = parseTimeBox($<HTMLInputElement>('time').value)
    if (time === null) throw new Error('time must be HH:MM:SS (or blank to use the filename)')
    const stratum = $<HTMLSelectElement>('stratum').value
    const note = $<HTMLInputElement>('note').value.trim()
    const label = buildCornerLabel({
      corners: points,
      time,
      is24h: $<HTMLInputElement>('is24h').checked,
      stratum: (stratum || undefined) as Stratum | undefined,
      eval: $<HTMLInputElement>('eval').checked,
      note: note || undefined,
    })
    sidecarText = serializeCornerLabel(label)
    outEl.textContent = sidecarText
    outName.textContent = imageName ? `→ ${sidecarPathFor(imageName)}` : ''
    downloadBtn.disabled = false
    copyBtn.disabled = false
  } catch (err) {
    errorEl.textContent = (err as Error).message
    outEl.textContent = ''
    sidecarText = ''
    downloadBtn.disabled = true
    copyBtn.disabled = true
  }
})

$('download').addEventListener('click', () => {
  if (!sidecarText) return
  const blob = new Blob([sidecarText], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = sidecarPathFor(imageName).split('/').pop() ?? `${imageName}.json`
  a.click()
  URL.revokeObjectURL(a.href)
})

$('copy').addEventListener('click', () => {
  if (sidecarText) void navigator.clipboard?.writeText(sidecarText)
})
